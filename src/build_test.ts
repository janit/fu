import { assertEquals } from "@std/assert";
import { assertRejects, assertStringIncludes } from "@std/assert";
import { build, clearOutput, staticClosure } from "./build.ts";

async function tree(files: string[]): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const f of files) {
    await Deno.mkdir(`${dir}/${f}`.replace(/\/[^/]+$/, ""), { recursive: true });
    await Deno.writeTextFile(`${dir}/${f}`, "");
  }
  return dir;
}
const exists = (p: string) => Deno.stat(p).then(() => true, () => false);

Deno.test("the default output dir is cleared whole", async () => {
  const ours = await tree(["public/_fu/old-abc.js", "server/index.mjs"]);
  try {
    clearOutput(ours, true);
    assertEquals(await exists(ours), false);
  } finally {
    await Deno.remove(ours, { recursive: true }).catch(() => {});
  }
});

Deno.test("in a custom dir only what the build writes is cleared", async () => {
  // It may hold a stranger's files; an earlier build's hashed assets must
  // still not ship with this one.
  const dir = await tree([
    "public/_fu/old-abc.js",
    "server/index.mjs",
    "keep.txt",
    "public/robots.txt",
  ]);
  try {
    clearOutput(dir, false);
    assertEquals(
      [
        await exists(`${dir}/public/_fu`),
        await exists(`${dir}/server`),
        await exists(`${dir}/keep.txt`),
        await exists(`${dir}/public/robots.txt`),
      ],
      [false, false, true, true],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A small real project, with the repo's node_modules linked in so it resolves preact. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir();
  for (const [file, text] of Object.entries(files)) {
    await Deno.mkdir(`${root}/${file}`.replace(/\/[^/]+$/, ""), { recursive: true });
    await Deno.writeTextFile(`${root}/${file}`, text);
  }
  await Deno.symlink(new URL("../node_modules", import.meta.url).pathname, `${root}/node_modules`);
  return root;
}

// rolldown holds native handles past the end of a build.
const real = { sanitizeResources: false, sanitizeOps: false };

Deno.test(
  "a real build: one stylesheet in cascade order, islands mapped, old output gone",
  real,
  async () => {
    const root = await project({
      "routes/index.tsx":
        `import "./route.css";\nimport I from "../islands/I.tsx";\nexport default () => <main><I /></main>;\n`,
      "routes/route.css": ".x { color: red }",
      "islands/I.tsx":
        `import "./island.css";\nexport default function I() { return <b class="x">i</b>; }\n`,
      "islands/island.css": ".x { color: blue }",
      ".output/public/_fu/old-abc.js": "stale",
    });
    const log = console.log;
    console.log = () => {};
    try {
      await build({ root });
      const client = [...Deno.readDirSync(`${root}/dist/client`)].map((e) => e.name);
      const sheet = client.find((f) => /^style-.*\.css$/.test(f))!;
      // Route CSS first, island CSS after it, as in dev.
      assertEquals(
        await Deno.readTextFile(`${root}/dist/client/${sheet}`),
        ".x{color:red}\n.x{color:#00f}",
      );

      const entry = await Deno.readTextFile(`${root}/.fu/ssr.ts`);
      const assets = JSON.parse(entry.match(/const assets = (.*);/)![1]);
      assertEquals(assets.css, [{ href: `/_fu/${sheet}` }]);
      assertEquals(Object.keys(assets.islands), ["/islands/I.tsx"]);
      // The island's own chunk comes first in its list.
      assertEquals(/^\/_fu\/I-.+\.js$/.test(assets.islands["/islands/I.tsx"][0]), true);
      assertEquals(
        assets.islands["/islands/I.tsx"].every((href: string) =>
          client.includes(href.slice("/_fu/".length))
        ),
        true,
      );
      assertEquals(/^\/_fu\/boot-.+\.js$/.test(assets.js[0].href), true);

      // The navigation runtime is a chunk of its own that the entry reaches by
      // dynamic import alone, and no page preloads it: a page without
      // data-fu-nav never fetches it.
      const nav = client.filter((f) => /^nav-.+\.js$/.test(f));
      assertEquals(nav.length, 1, client.join(" "));
      const boot = await Deno.readTextFile(
        `${root}/dist/client/${assets.js[0].href.slice("/_fu/".length)}`,
      );
      assertStringIncludes(boot, "fuNav");
      assertEquals(new RegExp(`import\\(.\\./${nav[0]}.\\)`).test(boot), true, boot);
      assertEquals(new RegExp(`from\\s*.\\./${nav[0]}`).test(boot), false);
      assertEquals(boot.includes("popstate"), false);
      // The hydration signal is in the entry itself, and the server never renders it.
      assertStringIncludes(boot, "data-fu-hydrated");
      assertStringIncludes(boot, "fu:hydrated");
      assertEquals(JSON.stringify(assets).includes(nav[0]), false);

      assertEquals(
        [...Deno.readDirSync(`${root}/.output/server`)].map((e) => e.name).sort(),
        ["index.mjs", "serve.mjs"],
      );
      assertEquals(await exists(`${root}/.output/public/_fu/old-abc.js`), false);
      assertEquals(await exists(`${root}/.output/public/_fu/${sheet}`), true);
      // No pre-compressed siblings: celld negotiates no encodings, a proxy compresses.
      assertEquals(
        [...Deno.readDirSync(`${root}/.output/public/_fu`)].some((e) =>
          /\.(br|gz|zst)$/.test(e.name)
        ),
        false,
      );
    } finally {
      console.log = log;
      await Deno.remove(root, { recursive: true });
    }
  },
);

/** Start a built server on a free port; `stop()` ends it. */
async function serve(root: string): Promise<{ base: string; stop(): Promise<void> }> {
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${root}/.output/server/serve.mjs`],
    env: { PORT: String(port), HOST: "127.0.0.1" },
    stdout: "null",
    stderr: "null",
  }).spawn();
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill("SIGKILL");
    await child.status;
  };
  for (let i = 0; i < 100; i++) {
    try {
      await (await fetch(base + "/")).body?.cancel();
      return { base, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await stop();
  throw new Error("the built server did not start");
}

Deno.test(
  "a built server: an asset is cached for good, and no failure under /_fu/ is cacheable",
  real,
  async () => {
    // After a deploy a page from the old build asks for a chunk that is gone.
    // A 404 without cache-control may be cached by a CDN on a heuristic, and
    // then outlives a rollback that brings the chunk back.
    const root = await project({
      "routes/index.tsx":
        `import I from "../islands/I.tsx";\nexport default () => <main><I /></main>;\n`,
      "islands/I.tsx": `export default function I() { return <b>i</b>; }\n`,
    });
    const log = console.log;
    console.log = () => {};
    let server: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      await build({ root });
      const boot = [...Deno.readDirSync(`${root}/dist/client`)].map((e) => e.name)
        .find((f) => /^boot-.*\.js$/.test(f))!;
      server = await serve(root);
      const head = async (path: string, init?: RequestInit) => {
        const res = await fetch(server!.base + path, init);
        await res.body?.cancel();
        return [res.status, res.headers.get("cache-control")];
      };

      const ok = await fetch(`${server.base}/_fu/${boot}`);
      await ok.body?.cancel();
      assertEquals([ok.status, ok.headers.get("cache-control")], [
        200,
        "public, max-age=31536000, immutable",
      ]);
      // A revalidation is not a failure: it keeps the asset's caching.
      assertEquals(
        await head(`/_fu/${boot}`, { headers: { "if-none-match": ok.headers.get("etag")! } }),
        [304, "public, max-age=31536000, immutable"],
      );

      // A file's URL is its URL to the letter: under a trailing slash it is not served.
      assertEquals(await head(`/_fu/${boot}/`), [404, "no-store"]);
      assertEquals(await head(`/_fu/${boot}//`), [404, "no-store"]);

      // A chunk of another build.
      assertEquals(await head("/_fu/boot-0ldHash0.js"), [404, "no-store"]);
      assertEquals(await head("/_fu/boot-0ldHash0.js", { method: "HEAD" }), [404, "no-store"]);
      // Not a file, or not a GET.
      assertEquals(await head("/_fu/"), [404, "no-store"]);
      assertEquals(await head("/_fu"), [404, "no-store"]);
      assertEquals(await head(`/_fu/${boot}`, { method: "POST" }), [404, "no-store"]);
      // Outside the prefix nothing changed: the app answers, as before.
      assertEquals(await head("/nope"), [404, "no-store"]);
      assertEquals((await head("/"))[0], 200);
    } finally {
      console.log = log;
      await server?.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
);

/** One request with the path sent exactly as written (fetch would tidy it). */
async function raw(base: string, path: string, method = "GET"): Promise<[number, string | null]> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: Number(new URL(base).port) });
  try {
    await conn.write(
      new TextEncoder().encode(
        `${method} ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      ),
    );
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of conn.readable) {
      text += decoder.decode(chunk, { stream: true });
      if (text.includes("\r\n\r\n")) break;
    }
    const head = text.slice(0, text.indexOf("\r\n\r\n"));
    const cc = head.match(/^cache-control:\s*(.*)$/im)?.[1] ?? null;
    return [Number(head.split(" ")[1]), cc];
  } finally {
    try {
      conn.close();
    } catch {
      // Closed by reading it to the end.
    }
  }
}

Deno.test(
  "a built server: only a real client file, successfully served, is ever immutable",
  real,
  async () => {
    // The year-long header was once a rule on the PATH, matched by nitro on a
    // normalised spelling, while fu decided "is this under the prefix" on the
    // raw one. A spelling the two read differently reached the app and came
    // back with the app's 404, or its redirect, marked immutable. Pinned still,
    // now that one test decides both.
    const root = await project({
      "app.ts": `import { App } from "@janit/fu";\nconst app = new App();\n` +
        `app.use((ctx) => {\n  const p = ctx.url.pathname;\n` +
        `  if (p.length > 1 && p.endsWith("/")) {\n` +
        `    return new Response(null, { status: 301, headers: { location: p.slice(0, -1) } });\n` +
        `  }\n  return ctx.next();\n});\nexport default app;\n`,
      "routes/index.tsx":
        `import I from "../islands/I.tsx";\nexport default () => <main><I /></main>;\n`,
      "routes/about.tsx": `export default () => <main>about</main>;\n`,
      "islands/I.tsx": `export default function I() { return <b>i</b>; }\n`,
    });
    const log = console.log;
    console.log = () => {};
    let server: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      await build({ root });
      const boot = [...Deno.readDirSync(`${root}/dist/client`)].map((e) => e.name)
        .find((f) => /^boot-.*\.js$/.test(f))!;
      server = await serve(root);
      const IMMUTABLE = "public, max-age=31536000, immutable";
      const got: Record<string, [number, string | null]> = {};
      const paths = [
        // The real thing, with and without a query string.
        `/_fu/${boot}`,
        `/_fu/${boot}?v=1`,
        // Spellings nitro and fu once read differently.
        "//_fu/x",
        "/_fu%2Fx",
        "/%2F_fu/x",
        "/_fu%5Cx",
        "//_fu",
        "/_fu%2Fabout/",
        "/_fu%2f..%2fabout",
        "/_FU/x",
        "/_fu;x/y",
        "/%5Ffu/x.js",
        "//_fu/x?y=1",
        `//_fu/${boot}`,
        "/_fu/nope.js?x=1",
        // Dot segments: the server resolves them before anything sees the path.
        "/_fu/../about",
        "/about",
      ];
      for (const path of paths) got[path] = await raw(server.base, path);
      assertEquals(got[`/_fu/${boot}`], [200, IMMUTABLE]);
      assertEquals(got[`/_fu/${boot}?v=1`], [200, IMMUTABLE]);
      // Everything else: whoever answered, never immutable. A failure is
      // no-store; an answer of the app's carries what the app gave it.
      assertEquals(
        Object.fromEntries(Object.entries(got).slice(2)),
        {
          "//_fu/x": [404, "no-store"],
          "/_fu%2Fx": [404, "no-store"],
          "/%2F_fu/x": [404, "no-store"],
          "/_fu%5Cx": [404, "no-store"],
          "//_fu": [404, "no-store"],
          "/_fu%2Fabout/": [301, null],
          "/_fu%2f..%2fabout": [404, "no-store"],
          "/_FU/x": [404, "no-store"],
          "/_fu;x/y": [404, "no-store"],
          "/%5Ffu/x.js": [404, "no-store"],
          "//_fu/x?y=1": [404, "no-store"],
          [`//_fu/${boot}`]: [404, "no-store"],
          "/_fu/nope.js?x=1": [404, "no-store"],
          "/_fu/../about": [200, null],
          "/about": [200, null],
        },
      );
      assertEquals(await raw(server.base, `/_fu/${boot}`, "POST"), [404, "no-store"]);
      assertEquals(await raw(server.base, "//_fu/x", "POST"), [404, "no-store"]);
    } finally {
      console.log = log;
      await server?.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "a built page preloads the chunks its own islands import statically, and nothing else",
  real,
  async () => {
    // Every shared chunk used to be announced on every page: 34 on each page
    // of the first real app, most of them code that page never runs.
    const root = await project({
      "routes/index.tsx":
        `import A from "../islands/A.tsx";\nexport default () => <main><A /></main>;\n`,
      "routes/c.tsx":
        `import C from "../islands/C.tsx";\nexport default () => <main><C /></main>;\n`,
      "routes/all.tsx": `import A from "../islands/A.tsx";\nimport B from "../islands/B.tsx";\n` +
        `import C from "../islands/C.tsx";\n` +
        `export default () => <main><A /><B /><C /><A /></main>;\n`,
      "routes/none.tsx": `export default () => <main>none</main>;\n`,
      // Shared by A and B only, so it lands in a chunk of its own.
      "lib/shared.ts": `export function shared(s: string): string { return "shared:" + s; }\n`,
      // Reached by a dynamic import alone.
      "lib/lazy.ts": `export const lazy = "lazy-marker";\n`,
      "islands/A.tsx": `import { shared } from "../lib/shared.ts";\n` +
        `export default function A() {\n` +
        `  return <button onClick={() => import("../lib/lazy.ts")}>{shared("a")}</button>;\n}\n`,
      "islands/B.tsx": `import { shared } from "../lib/shared.ts";\n` +
        `export default function B() { return <b>{shared("b")}</b>; }\n`,
      "islands/C.tsx": `export default function C() { return <i>c</i>; }\n`,
    });
    const log = console.log;
    console.log = () => {};
    let server: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      await build({ root });
      const client = [...Deno.readDirSync(`${root}/dist/client`)].map((e) => e.name);
      // The fixture is what it claims: one chunk per island, the two shared
      // ones, the lazy one and the navigation runtime.
      const names = client.map((f) => f.replace(/-[\w-]{8}\.js$/, "")).sort();
      assertEquals(names, ["A", "B", "C", "boot", "jsxRuntime", "lazy", "nav", "shared"]);

      server = await serve(root);
      /** The chunks a page preloads, by name, in the order the document names them. */
      const preloads = async (path: string): Promise<string[]> => {
        const html = await (await fetch(server!.base + path)).text();
        return [...html.matchAll(/<link rel="modulepreload" href="\/_fu\/([^"]+)">/g)]
          .map((m) => m[1].replace(/-[\w-]{8}\.js$/, ""));
      };
      // The island's chunk and what it imports statically. Not B or C, not
      // the chunk A reaches by dynamic import, not the navigation runtime,
      // and not the entry, which is the script tag itself.
      // In the order emitted: what the islands import, then the islands.
      assertEquals(await preloads("/"), ["shared", "jsxRuntime", "A"]);
      assertEquals(await preloads("/c"), ["jsxRuntime", "C"]);
      // Each chunk once, however many islands share it or times one is rendered.
      assertEquals(await preloads("/all"), ["shared", "jsxRuntime", "A", "B", "C"]);
      assertEquals(await preloads("/none"), []);
      assertEquals(await preloads("/no-such-page"), []);

      const entry = await Deno.readTextFile(`${root}/.fu/ssr.ts`);
      const assets = entry.match(/const assets = (.*);/)![1];
      for (const never of ["lazy", "nav"]) {
        const file = client.find((f) => f.startsWith(never + "-"))!;
        assertEquals(assets.includes(file), false, file);
      }
      // The boot module imports nothing statically here, so no page-wide preload.
      assertEquals(JSON.parse(assets).preload, []);
    } finally {
      console.log = log;
      await server?.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test("staticClosure follows static imports only, and never names what it was told to skip", () => {
  const chunks = [
    { fileName: "boot.js", imports: ["preact.js"], dynamicImports: ["A.js", "nav.js"] },
    { fileName: "preact.js", imports: [], dynamicImports: [] },
    { fileName: "A.js", imports: ["jsx.js", "shared.js"], dynamicImports: ["lazy.js"] },
    // Chunks import each other in a cycle often enough (a shared chunk and the entry).
    { fileName: "jsx.js", imports: ["boot.js", "preact.js"], dynamicImports: [] },
    { fileName: "shared.js", imports: ["jsx.js", "deep.js"], dynamicImports: [] },
    { fileName: "deep.js", imports: ["shared.js", "node:fs"], dynamicImports: [] },
    { fileName: "lazy.js", imports: ["only-lazy.js"], dynamicImports: [] },
    { fileName: "only-lazy.js", imports: [], dynamicImports: [] },
  ];
  const boot = staticClosure(chunks, "boot.js", new Set(["boot.js"]));
  assertEquals(boot, ["preact.js"]);
  // What every page has already (the entry and its closure) is not repeated
  // per island; an import that is no chunk of this build is not a preload.
  assertEquals(
    staticClosure(chunks, "A.js", new Set(["boot.js", ...boot])),
    ["jsx.js", "shared.js", "deep.js"],
  );
});

Deno.test(
  "a real build fails on an import of the app's that resolves to nothing",
  real,
  async () => {
    const root = await project({
      "routes/index.tsx": `import "not-installed-anywhere";\nexport default () => <p>x</p>;\n`,
    });
    const log = console.log;
    console.log = () => {};
    try {
      const err = await assertRejects(() => build({ root }));
      assertStringIncludes(String(err), "not-installed-anywhere");
    } finally {
      console.log = log;
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "a built server: an encoded slash and a malformed escape reach the app, as written",
  real,
  async () => {
    // h3 answered a path it could not decode with its own 400 before any
    // handler, unless told not to: the app never saw the request.
    const page = (name: string) =>
      `export default (ctx) => <p>${name}|{JSON.stringify(ctx.params)}|{JSON.stringify(ctx.rawParams)}</p>;\n`;
    const root = await project({
      "routes/s/[code].tsx": page("s"),
      "routes/[a]/[b].tsx": page("ab"),
      "routes/[...slug].tsx": page("all"),
    });
    const log = console.log;
    console.log = () => {};
    let server: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      await build({ root });
      server = await serve(root);
      const got: Record<string, string> = {};
      for (
        const path of ["/s/a%20b%2Fc", "/dublin%2Fcork", "/s/%E0%A4%A", "/dublin%E0%A4%A", "/s/%"]
      ) {
        // fetch sends an escape as it is written, malformed or not.
        const res = await fetch(server.base + path);
        const text = (await res.text()).replaceAll("&quot;", '"');
        got[path] = `${res.status} ${text.match(/<p>([^<]*)<\/p>/)?.[1] ?? ""}`;
      }
      assertEquals(got, {
        "/s/a%20b%2Fc": '200 s|{"code":"a b%2Fc"}|{"code":"a%20b%2Fc"}',
        "/dublin%2Fcork": '200 all|{"slug":"dublin%2Fcork"}|{"slug":"dublin%2Fcork"}',
        "/s/%E0%A4%A": '200 s|{"code":"%E0%A4%A"}|{"code":"%E0%A4%A"}',
        "/dublin%E0%A4%A": '200 all|{"slug":"dublin%E0%A4%A"}|{"slug":"dublin%E0%A4%A"}',
        "/s/%": '200 s|{"code":"%"}|{"code":"%"}',
      });
      // Under the asset prefix it is a 404, uncacheable.
      assertEquals(await raw(server.base, "/_fu/%E0%A4%A"), [404, "no-store"]);
    } finally {
      console.log = log;
      await server?.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "the Worker is one module exporting handlers only, and fu adds no node: import to it",
  real,
  async () => {
    const root = await project({
      "routes/index.tsx": `export default () => <main>home</main>;\n`,
      "worker.ts": `export async function prepare(env) {}\n` +
        `export const scheduled = { async scheduled() {} };\n` +
        `export class Room { fetch() { return new Response("room"); } }\n` +
        `export type Unused = string;\n`,
    });
    const log = console.log;
    console.log = () => {};
    try {
      const out = await build({ root });
      assertEquals(out.worker, `${root}/.output/server/index.mjs`);
      assertEquals(out.publicDir, `${root}/.output/public`);
      const code = await Deno.readTextFile(out.worker);
      // One file: no import of a chunk of its own, and no node: import.
      assertEquals(/\bimport\s*\(?\s*["'][./]/.test(code), false);
      assertEquals(code.includes("node:"), false);
      // Only handlers: fu's fetch, and what worker.ts exported, prepare excepted.
      const mod = await import(out.worker);
      assertEquals(Object.keys(mod).sort(), ["Room", "default", "scheduled"]);
      assertEquals(typeof mod.default.fetch, "function");
    } finally {
      console.log = log;
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "a built Worker runs nothing of the app until the first request, and prepare runs first",
  real,
  async () => {
    // Module-scope reads of the environment must see what prepare set up: the
    // app graph is evaluated lazily, inside the one file.
    const g = globalThis as { __fuOrder?: string[] };
    g.__fuOrder = [];
    const root = await project({
      "routes/index.tsx": `globalThis.__fuOrder.push("route:" + globalThis.__fuEnvKey);\n` +
        `export default () => <main>home</main>;\n`,
      "app.ts": `import { App } from "@janit/fu";\n` +
        `globalThis.__fuOrder.push("app");\nexport default new App();\n`,
      "worker.ts": `export function prepare(env) {\n` +
        `  globalThis.__fuOrder.push("prepare");\n  globalThis.__fuEnvKey = env.KEY;\n}\n`,
    });
    const log = console.log;
    console.log = () => {};
    try {
      const out = await build({ root });
      const mod = await import(out.worker);
      assertEquals(g.__fuOrder, []);
      const res = await mod.default.fetch(new Request("http://x/"), { KEY: "k" }, {
        waitUntil() {},
      });
      assertStringIncludes(await res.text(), "home");
      assertEquals(g.__fuOrder, ["prepare", "app", "route:k"]);
    } finally {
      console.log = log;
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "a built Worker: a worker.ts with a default export does not build",
  real,
  async () => {
    const root = await project({
      "routes/index.tsx": `export default () => <main>home</main>;\n`,
      "worker.ts": `export default { fetch() {} };\n`,
    });
    const log = console.log;
    console.log = () => {};
    try {
      const err = await assertRejects(() => build({ root }));
      assertStringIncludes(String(err), "default export is not allowed");
    } finally {
      console.log = log;
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "an app that serves files with assets() from @janit/fu/static gets no node: import in its Worker",
  real,
  async () => {
    // The same module exports staticFiles and assetsFromDir, which read the
    // filesystem; what the app does not use must not reach celld.
    const root = await project({
      "routes/index.tsx": `export default () => <main>home</main>;\n`,
      "app.ts": `import { App } from "@janit/fu";\n` +
        `import { assets } from "@janit/fu/static";\n` +
        `export default new App().use(assets({ isStatic: (p) => p === "/logo.svg" }));\n`,
    });
    const log = console.log;
    console.log = () => {};
    try {
      const out = await build({ root });
      const code = await Deno.readTextFile(out.worker);
      assertEquals(code.includes("node:"), false);
      const store = {
        fetch: () => Promise.resolve(new Response("<svg/>", { headers: { etag: '"1"' } })),
      };
      const mod = await import(out.worker);
      const res = await mod.default.fetch(new Request("http://x/logo.svg"), { ASSETS: store }, {
        waitUntil() {},
      });
      assertEquals(await res.text(), "<svg/>");
    } finally {
      console.log = log;
      await Deno.remove(root, { recursive: true });
    }
  },
);
