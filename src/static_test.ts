import { assertEquals, assertStringIncludes } from "@std/assert";
import { assertRejects } from "@std/assert";
import { relative } from "node:path";
import { __openHandlesForTest, contentType, isUnder, safeSegments, staticFiles } from "./static.ts";
import { App } from "./app.ts";
import { createHandler } from "./render.ts";
import type { Ctx, Middleware } from "./types.ts";

const base = await Deno.makeTempDir();
const dir = `${base}/served`;
await Deno.mkdir(`${dir}/icons`, { recursive: true });
await Deno.mkdir(`${dir}/.git`);
await Deno.mkdir(`${dir}/sub`);
await Deno.mkdir(`${dir}-private`);
await Deno.writeTextFile(`${dir}/hello.txt`, "hello");
await Deno.writeTextFile(`${dir}/empty.txt`, "");
await Deno.writeTextFile(`${dir}/sub/a.txt`, "sub-a");
await Deno.writeTextFile(`${dir}/icons/icon.svg`, "<svg/>");
await Deno.writeTextFile(`${dir}/.secret`, "x");
await Deno.writeTextFile(`${dir}/.git/HEAD`, "ref");
await Deno.writeTextFile(`${base}/above.txt`, "ABOVE-SECRET");
await Deno.writeTextFile(`${dir}-private/priv.txt`, "PRIVATE-SECRET");
addEventListener("unload", () => Deno.removeSync(base, { recursive: true }));

function ctxFor(path: string, init: RequestInit = {}): Ctx & { nexted: boolean } {
  const c = {
    req: new Request("http://x" + path, init),
    url: new URL("http://x" + path),
    params: {},
    rawParams: {},
    state: {},
    head: {},
    response: { status: 200, headers: new Headers() },
    partial: false,
    env: {},
    waitUntil: () => {},
    assets: null,
    nexted: false,
    next: () => {
      c.nexted = true;
      return Promise.resolve(new Response("next", { status: 404 }));
    },
  };
  return c;
}

Deno.test("safeSegments refuses traversal, dotfiles, NUL and backslashes", () => {
  assertEquals(safeSegments("/icons/icon.svg"), ["icons", "icon.svg"]);
  assertEquals(safeSegments("/caf%C3%A9.txt"), ["caf" + String.fromCharCode(0xe9) + ".txt"]);
  for (
    const bad of [
      "/sub%2fa.txt",
      "/sub%2Fa.txt",
      "/",
      "/icons/",
      "/../x",
      "/icons/../hello.txt",
      "/%2e%2e/x",
      "/.secret",
      "/.git/HEAD",
      "/a%00b",
      "/a%5cb",
      "/icons//icon.svg",
      "/%zz",
    ]
  ) assertEquals(safeSegments(bad), null, bad);
});

Deno.test("each check in safeSegments is the only thing refusing some path", () => {
  // One path per check, chosen so that no other check refuses it: deleting
  // that check makes exactly its line fail.
  const only: Record<string, string> = {
    "must start with a slash": "icons/icon.svg",
    "malformed escape": "/a%zzb",
    "empty segment": "/icons//icon.svg",
    // "." and ".." are covered by the dotfile rule as well; these two are
    // refused by it alone.
    "dotfile, first segment": "/.secret",
    "dotfile, later segment": "/icons/.hidden",
    "encoded slash": "/sub%2fa.txt",
    "backslash": "/a%5cb",
    "NUL": "/a%00b",
  };
  for (const [why, path] of Object.entries(only)) assertEquals(safeSegments(path), null, why);
  assertEquals(safeSegments("/icons/%2e%2e/x"), null);
  assertEquals(safeSegments("/icons/%2e/x"), null);
  // Not refused: a dot inside a name, and an encoded dot that is not leading.
  assertEquals(safeSegments("/a.b/c%2ed"), ["a.b", "c.d"]);
});

Deno.test("isUnder is the last guard: unreachable through safeSegments, tested directly", () => {
  assertEquals(isUnder("/srv/static", "/srv/static/a.txt"), true);
  assertEquals(isUnder("/srv/static", "/srv/static"), false);
  assertEquals(isUnder("/srv/static", "/srv/static-private/a.txt"), false);
  assertEquals(isUnder("/srv/static", "/srv/a.txt"), false);
});

Deno.test("contentType covers what frontend4/static holds and falls back to octet-stream", () => {
  // The map is derived from the 936 files under frontend4/static (pbf, svg,
  // webp, png, css, woff2, mjs, json, js, xml, txt, ico, html, LICENSE).
  assertEquals(contentType("/font/Inter/0-255.pbf"), "application/x-protobuf");
  assertEquals(contentType("/a/b.css"), "text/css; charset=utf-8");
  assertEquals(contentType("/a/sw.js"), "text/javascript; charset=utf-8");
  assertEquals(
    contentType("/maplibre/6.11.2/maplibre-gl-worker.mjs"),
    "text/javascript; charset=utf-8",
  );
  assertEquals(contentType("/a/f.woff2"), "font/woff2");
  assertEquals(contentType("/a/x.webp"), "image/webp");
  assertEquals(contentType("/a/x.SVG"), "image/svg+xml");
  assertEquals(contentType("/flags/LICENSE"), "application/octet-stream");
  assertEquals(contentType("/a/f.unknownext"), "application/octet-stream");
});

Deno.test("a Range header is ignored: nothing in static needs ranges, so the answer is the whole file", async () => {
  const mw = staticFiles({ dir });
  const res = await mw(ctxFor("/hello.txt", { headers: { range: "bytes=0-1" } }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("accept-ranges"), "none");
  assertEquals(res.headers.get("content-range"), null);
  assertEquals(await res.text(), "hello");
});

Deno.test("a file is served with type, length, validators and the chosen cache-control", async () => {
  const mw = staticFiles({
    dir,
    cacheControl: (p) => p.startsWith("/icons/") ? "public, max-age=604800" : null,
  });
  const c = ctxFor("/icons/icon.svg");
  const res = await mw(c);
  assertEquals(c.nexted, false);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/svg+xml");
  assertEquals(res.headers.get("content-length"), "6");
  assertEquals(res.headers.get("cache-control"), "public, max-age=604800");
  assertEquals(res.headers.get("etag")?.startsWith('W/"6-'), true);
  assertEquals(typeof res.headers.get("last-modified"), "string");
  assertEquals(await res.text(), "<svg/>");

  const plain = await mw(ctxFor("/hello.txt"));
  assertEquals(plain.headers.get("cache-control"), null);
  assertEquals(await plain.text(), "hello");
});

Deno.test("misses, directories, dotfiles and non-GET fall through to next()", async () => {
  const mw = staticFiles({ dir });
  for (
    const [path, init] of [
      ["/nope.txt", {}],
      ["/icons", {}],
      ["/.secret", {}],
      ["/.git/HEAD", {}],
      ["/..%2fhello.txt", {}],
      ["/hello.txt", { method: "POST" }],
    ] as const
  ) {
    const c = ctxFor(path, init);
    const res = await mw(c);
    assertEquals(c.nexted, true, path);
    assertEquals(res.status, 404, path);
  }
});

async function expectRefused(mw: Middleware, path: string): Promise<void> {
  const c = ctxFor(path);
  c.next = () => {
    c.nexted = true;
    return Promise.resolve(new Response("sentinel", { status: 599 }));
  };
  const res = await mw(c);
  assertEquals(c.nexted, true, path);
  assertEquals(res.status, 599, path);
  const text = await res.text();
  assertEquals(text.includes("SECRET"), false, path);
}

Deno.test("an encoded slash is not a separator: path policy sees what the filesystem serves", async () => {
  const seen: string[] = [];
  const mw = staticFiles({ dir, cacheControl: (p) => (seen.push(p), null) });
  await expectRefused(mw, "/sub%2fa.txt");
  assertEquals(seen, []);
  const ok = await mw(ctxFor("/sub/a.txt"));
  assertEquals(ok.status, 200);
  assertEquals(await ok.text(), "sub-a");
  assertEquals(seen, ["/sub/a.txt"]);
});

Deno.test("traversal to real files above the dir, or in a sibling dir, is refused", async () => {
  const mw = staticFiles({ dir });
  for (
    const p of [
      "/icons%2f..%2f..%2fabove.txt",
      "/%2e%2e/above.txt",
      "/..%2fabove.txt",
      "/../above.txt",
      "/icons/../../above.txt",
      "/..%2fserved-private%2fpriv.txt",
      "/%2e%2e/served-private/priv.txt",
      "/..%5cabove.txt",
      "/icons/%2e%2e/%2e%2e/above.txt",
      "/icons/.hidden",
    ]
  ) await expectRefused(mw, p);
});

Deno.test("a pathname with literal dot segments, which URL parsing would have removed, is refused", async () => {
  // `new URL` normalises "/../x" away, so the requests above never reach the
  // segment checks with a literal "..". A ctx whose pathname was set by hand
  // (a middleware rewriting ctx.url, a server that does not normalise) does.
  const mw = staticFiles({ dir });
  for (const pathname of ["/../above.txt", "/icons/../../above.txt", "/./hello.txt"]) {
    const c = ctxFor("/hello.txt");
    c.url = { pathname } as URL;
    c.next = () => {
      c.nexted = true;
      return Promise.resolve(new Response("sentinel", { status: 599 }));
    };
    const res = await mw(c);
    assertEquals([c.nexted, res.status], [true, 599], pathname);
    assertEquals((await res.text()).includes("SECRET"), false, pathname);
  }
  // The file is real and readable: only the refusal stands in the way.
  assertEquals(await Deno.readTextFile(`${dir}/../above.txt`), "ABOVE-SECRET");
});

Deno.test("cacheControl is asked only about a file that will be served", async () => {
  const seen: string[] = [];
  const mw = staticFiles({ dir, cacheControl: (p) => (seen.push(p), "max-age=60") });
  for (const miss of ["/nope.txt", "/icons", "/icons/nope.svg", "/.secret"]) {
    await mw(ctxFor(miss));
  }
  await mw(ctxFor("/hello.txt", { method: "POST" }));
  assertEquals(seen, []);
  const head = await mw(ctxFor("/hello.txt", { method: "HEAD" }));
  assertEquals([seen, head.headers.get("cache-control")], [["/hello.txt"], "max-age=60"]);
});

// The handle tests below read the module's own count of open files, not the
// process's descriptors. It is trusted because it moves in the only two places
// a handle is opened and closed. The real descriptor count under srvx on Node
// was measured by a probe outside the repo (100 mid-download disconnects:
// /proc/<pid>/fd unchanged).
const big = new Uint8Array(300_000).map((_, i) => i % 251);
await Deno.writeFile(`${dir}/big.bin`, big);

Deno.test("a body nobody reads opens nothing: 200 dropped responses leave no handle", async () => {
  // An outer middleware may replace the response. The file must not be open
  // by then, or the handle is left to the garbage collector, which on Node is
  // an uncaught exception.
  const mw = staticFiles({ dir });
  const before = __openHandlesForTest();
  for (let i = 0; i < 200; i++) {
    const res = await mw(ctxFor("/big.bin"));
    assertEquals([res.status, res.headers.get("content-length")], [200, "300000"]);
  }
  // Give anything that was (wrongly) started time to open.
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(__openHandlesForTest() - before, 0);
});

Deno.test("a body read to the end is the file, in several chunks, and its handle is closed", async () => {
  const mw = staticFiles({ dir });
  const res = await mw(ctxFor("/big.bin"));
  const reader = res.body!.getReader();
  const first = await reader.read();
  // One chunk in, more to come: the handle is open now, and only now.
  assertEquals(first.value!.length < big.length, true);
  assertEquals(__openHandlesForTest(), 1);
  const parts = [first.value!];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (all.set(p, at), at += p.length);
  assertEquals(all, big);
  assertEquals(__openHandlesForTest(), 0);
});

Deno.test("cancelling a body closes its handle, mid-file and before the first chunk arrives", async () => {
  const mw = staticFiles({ dir });
  const res = await mw(ctxFor("/big.bin"));
  const reader = res.body!.getReader();
  await reader.read();
  assertEquals(__openHandlesForTest(), 1);
  await reader.cancel();
  assertEquals(__openHandlesForTest(), 0);

  // Cancel while the first read is still opening the file.
  const racing = (await mw(ctxFor("/big.bin"))).body!.getReader();
  const pending = racing.read();
  await racing.cancel();
  await pending;
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(__openHandlesForTest(), 0);
});

Deno.test("a file replaced between the stat and the first read errors the body instead of sending a short one", async () => {
  const file = `${dir}/swap.txt`;
  await Deno.writeTextFile(file, "a long first version of the file");
  const mw = staticFiles({ dir });
  const res = await mw(ctxFor("/swap.txt"));
  assertEquals(res.headers.get("content-length"), "32");
  await Deno.writeTextFile(file, "short");
  // Not "short" under a content-length of 32.
  await assertRejects(() => res.text(), Error, "changed");
  assertEquals(__openHandlesForTest(), 0);

  // Deleted: the same, with the reason the filesystem gives.
  const gone = await mw(ctxFor("/swap.txt"));
  await Deno.remove(file);
  await assertRejects(() => gone.text());
  assertEquals(__openHandlesForTest(), 0);
});

Deno.test("If-None-Match accepts *, lists and weak comparison; it beats If-Modified-Since", async () => {
  const mw = staticFiles({ dir });
  const first = await mw(ctxFor("/hello.txt"));
  const etag = first.headers.get("etag")!;
  const lastModified = first.headers.get("last-modified")!;
  await first.body?.cancel();
  const strong = etag.slice(2);
  const old = "Thu, 01 Jan 1970 00:00:00 GMT";
  const status = async (h: Record<string, string>) => {
    const r = await mw(ctxFor("/hello.txt", { headers: h }));
    await r.body?.cancel();
    return r.status;
  };
  assertEquals(await status({ "if-none-match": "*" }), 304);
  assertEquals(await status({ "if-none-match": `"zzz", ${etag}` }), 304);
  assertEquals(await status({ "if-none-match": `"zzz",${strong}` }), 304);
  assertEquals(await status({ "if-none-match": strong }), 304);
  assertEquals(await status({ "if-none-match": `"zzz", "yyy"` }), 200);
  // INM present and not matching: the date must be ignored.
  assertEquals(await status({ "if-none-match": '"zzz"', "if-modified-since": lastModified }), 200);
  // INM present and matching: an old date does not matter.
  assertEquals(await status({ "if-none-match": etag, "if-modified-since": old }), 304);
});

Deno.test("If-Modified-Since only counts when it is an HTTP date", async () => {
  const mw = staticFiles({ dir });
  const res = await mw(ctxFor("/hello.txt", { headers: { "if-modified-since": "9999-12-31" } }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("HEAD and 304 carry no body; a directory falls through; an empty file is 200 length 0", async () => {
  const mw = staticFiles({ dir });
  const head = await mw(ctxFor("/hello.txt", { method: "HEAD" }));
  assertEquals(head.status, 200);
  assertEquals(head.headers.get("content-length"), "5");
  assertEquals(head.body, null);

  const dirRes = ctxFor("/icons");
  assertEquals((await mw(dirRes)).status, 404);
  assertEquals(dirRes.nexted, true);

  const empty = await mw(ctxFor("/empty.txt"));
  assertEquals(empty.status, 200);
  assertEquals(empty.headers.get("content-length"), "0");
  assertEquals(await empty.text(), "");
});

Deno.test("a cacheControl that throws is logged once and treated as no cache-control", async () => {
  const mw = staticFiles({
    dir,
    cacheControl: () => {
      throw new Error("boom");
    },
  });
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void calls.push(a);
  try {
    for (let i = 0; i < 2; i++) {
      const res = await mw(ctxFor("/hello.txt"));
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("cache-control"), null);
      assertEquals(await res.text(), "hello");
    }
  } finally {
    console.error = orig;
  }
  assertEquals(calls.length, 1);
  assertEquals(calls[0][0], "[fu] staticFiles cacheControl threw");
});

Deno.test("an etag the app supplies is the validator: sent, matched, and stable across a touch", async () => {
  // Size and mtime change with every image build, even for identical bytes;
  // an app that knows a content hash can say so.
  const file = `${dir}/hashed.txt`;
  await Deno.writeTextFile(file, "same bytes");
  const asked: unknown[] = [];
  const mw = staticFiles({
    dir,
    cacheControl: () => "public, max-age=60",
    etag: (pathname, stat) => {
      asked.push([pathname, stat.size, typeof stat.mtimeMs]);
      return pathname === "/hashed.txt" ? '"abc123"' : null;
    },
  });
  try {
    const first = await mw(ctxFor("/hashed.txt"));
    assertEquals([first.status, first.headers.get("etag")], [200, '"abc123"']);
    assertEquals(await first.text(), "same bytes");
    const builtIn = `W/"10-${Math.floor((await Deno.stat(file)).mtime!.getTime())}"`;

    // The same bytes, written again later: another mtime, the same tag.
    await Deno.utime(file, new Date(), new Date(Date.now() + 60_000));
    const inm = (value: string) =>
      mw(ctxFor("/hashed.txt", { headers: { "if-none-match": value } }));
    const hit = await inm('"abc123"');
    // A 304 carries what the 200 would: the tag that matched, and the cache-control.
    assertEquals(
      [hit.status, hit.headers.get("etag"), hit.headers.get("cache-control"), hit.body],
      [304, '"abc123"', "public, max-age=60", null],
    );
    assertEquals((await inm('W/"abc123"')).status, 304);
    // The built-in tag is not also accepted: one file, one validator.
    const miss = await inm(builtIn);
    assertEquals([miss.status, miss.headers.get("etag")], [200, '"abc123"']);
    await miss.body?.cancel();

    // null: the built-in tag, as without the option. Asked with the decoded
    // pathname, and only about files that are served.
    const other = await mw(ctxFor("/sub/a.txt"));
    assertEquals(/^W\/"5-\d+"$/.test(other.headers.get("etag")!), true);
    await other.body?.cancel();
    await mw(ctxFor("/missing.txt"));
    assertEquals(asked.at(-1), ["/sub/a.txt", 5, "number"]);
    assertEquals(asked.some((a) => (a as string[])[0] === "/missing.txt"), false);
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("an etag callback that throws, or returns no entity-tag, is logged once and the built-in used", async () => {
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void calls.push(a);
  try {
    for (
      const etag of [
        () => {
          throw new Error("boom");
        },
        () => "abc123", // not quoted: not an entity-tag
        () => '"a"b"',
        () => '"line\nbreak"',
        // Legal in an entity-tag, but If-None-Match is a comma-separated
        // list: this tag could be sent and never matched.
        () => '"a,b"',
      ]
    ) {
      const mw = staticFiles({ dir, etag });
      for (let i = 0; i < 2; i++) {
        const res = await mw(ctxFor("/hello.txt"));
        assertEquals(res.status, 200);
        assertEquals(/^W\/"5-\d+"$/.test(res.headers.get("etag")!), true);
        await res.body?.cancel();
      }
    }
  } finally {
    console.error = orig;
  }
  assertEquals(calls.length, 5);
  assertStringIncludes(String(calls[0][0]), "[fu] staticFiles etag");
});

Deno.test("every served file is nosniff", async () => {
  const mw = staticFiles({ dir });
  const res = await mw(ctxFor("/hello.txt"));
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  await res.body?.cancel();
});

Deno.test("conditional requests: a matching etag wins over a stale date; a wrong etag loses", async () => {
  const mw = staticFiles({ dir });
  const first = await mw(ctxFor("/hello.txt"));
  const etag = first.headers.get("etag")!;
  const lastModified = first.headers.get("last-modified")!;
  await first.body?.cancel();

  const byEtag = await mw(ctxFor("/hello.txt", {
    headers: { "if-none-match": etag, "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT" },
  }));
  assertEquals(byEtag.status, 304);
  assertEquals(byEtag.headers.get("etag"), etag);
  assertEquals(byEtag.body, null);

  const wrongEtag = await mw(ctxFor("/hello.txt", {
    headers: { "if-none-match": 'W/"other"', "if-modified-since": lastModified },
  }));
  assertEquals(wrongEtag.status, 200);
  await wrongEtag.body?.cancel();

  const byDate = await mw(ctxFor("/hello.txt", { headers: { "if-modified-since": lastModified } }));
  assertEquals(byDate.status, 304);
});

Deno.test("content types a browser refuses to guess under nosniff", () => {
  assertEquals(contentType("/a/m.wasm"), "application/wasm");
  assertEquals(contentType("/a/x.avif"), "image/avif");
  assertEquals(contentType("/a/x.jpg"), "image/jpeg");
  assertEquals(contentType("/a/x.JPEG"), "image/jpeg");
  assertEquals(contentType("/a/x.gif"), "image/gif");
  assertEquals(contentType("/a/app.js.map"), "application/json; charset=utf-8");
  assertEquals(contentType("/a/site.webmanifest"), "application/manifest+json; charset=utf-8");
});

/** Run `fn` and return what it sent to console.warn. */
function warnings(fn: () => void): string[] {
  const warn = console.warn;
  const out: string[] = [];
  console.warn = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    fn();
  } finally {
    console.warn = warn;
  }
  return out;
}

Deno.test("a relative dir is resolved once, when the middleware is made", async () => {
  const cwd = Deno.cwd();
  let mw: Middleware;
  const warned = warnings(() => mw = staticFiles({ dir: relative(cwd, dir) }));
  assertEquals(warned, []);
  Deno.chdir(base);
  try {
    const res = await mw!(ctxFor("/hello.txt"));
    assertEquals([res.status, await res.text()], [200, "hello"]);
  } finally {
    Deno.chdir(cwd);
  }
});

Deno.test("a dir that is not a directory is said so once, at construction, and every request falls through", async () => {
  const missing = `${base}/nowhere`;
  const said = (abs: string) => [
    `[fu] staticFiles: ${abs} is not a directory; every request will fall through`,
  ];
  let mw: Middleware;
  assertEquals(warnings(() => mw = staticFiles({ dir: missing })), said(missing));
  // A file is not a directory either; and the message names the absolute path.
  const cwd = Deno.cwd();
  assertEquals(
    warnings(() => staticFiles({ dir: relative(cwd, `${dir}/hello.txt`) })),
    said(`${dir}/hello.txt`),
  );
  // Nothing more is said per request.
  const warn = console.warn;
  let later = 0;
  console.warn = () => void later++;
  try {
    const c = ctxFor("/hello.txt");
    const res = await mw!(c);
    assertEquals([c.nexted, res.status, later], [true, 404, 0]);
  } finally {
    console.warn = warn;
  }
});

Deno.test("static responses travel back through the chain, so an outer middleware decorates them", async () => {
  const app = new App()
    .use(async (ctx) => {
      const res = await ctx.next();
      res.headers.set("x-frame-options", "SAMEORIGIN");
      return res;
    })
    .use(staticFiles({ dir }));
  const handler = createHandler({ manifest: {}, assets: { js: [], css: [] }, app });
  const res = await handler(new Request("http://x/hello.txt"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assertStringIncludes(await res.text(), "hello");
  const head = await handler(new Request("http://x/hello.txt", { method: "HEAD" }));
  assertEquals(head.status, 200);
  assertEquals(await head.text(), "");
});

Deno.test("a file that cannot be read is a miss for HEAD as it is for GET", async () => {
  const file = `${dir}/unreadable.txt`;
  await Deno.writeTextFile(file, "x");
  await Deno.chmod(file, 0o000);
  try {
    const mw = staticFiles({ dir });
    for (const method of ["GET", "HEAD"]) {
      const c = ctxFor("/unreadable.txt", { method });
      const res = await mw(c);
      assertEquals([c.nexted, res.status], [true, 404], method);
    }
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("a file is served by a Deno run with only net, read and env: no sys permission", async () => {
  // fu-todo's image runs serve.mjs this way; node:fs `access` asked for the
  // uid, and the first client file took the whole server down.
  const script = `
    import { assetsFromDir } from ${JSON.stringify(new URL("./static.ts", import.meta.url).href)};
    const res = await assetsFromDir(${
    JSON.stringify(dir)
  }).fetch(new Request("http://x/hello.txt"));
    console.log(res.status, await res.text());
  `;
  // `deno eval` grants everything, so the script is a file and `deno run` it.
  const file = `${base}/no-sys.ts`;
  await Deno.writeTextFile(file, script);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-prompt", "--allow-read", "--allow-env", "--allow-net", file],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder();
  assertEquals(
    [out.code, text.decode(out.stdout).trim()],
    [0, "200 hello"],
    text.decode(out.stderr),
  );
});
