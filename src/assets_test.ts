import { assertEquals } from "@std/assert";
import { assets, clientFiles, IMMUTABLE } from "./assets.ts";
import { compose } from "./app.ts";
import type { AssetStore, Ctx, Middleware, RequestExtra } from "./types.ts";

/** A store that answers from a table, records what it was asked, and freezes its headers as celld's do. */
function fakeStore(files: Record<string, string>): AssetStore & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch(input) {
      const req = input instanceof Request ? input : new Request(input);
      asked.push(`${req.method} ${new URL(req.url).pathname}`);
      if (req.method !== "GET" && req.method !== "HEAD") {
        return Promise.resolve(new Response(null, { status: 405 }));
      }
      const body = files[new URL(req.url).pathname];
      if (body === undefined) return Promise.resolve(new Response("nope", { status: 404 }));
      const etag = `"${body.length}"`;
      const res = req.headers.get("if-none-match") === etag
        ? new Response(null, { status: 304, headers: { etag } })
        : new Response(req.method === "HEAD" ? null : body, {
          headers: { etag, "cache-control": "public, max-age=0, must-revalidate" },
        });
      // A Workers fetch hands back a Response whose headers cannot be changed.
      const immutable = () => {
        throw new TypeError("immutable");
      };
      Object.assign(res.headers, { set: immutable, append: immutable, delete: immutable });
      return Promise.resolve(res);
    },
  };
}

function ctxFor(path: string, init: RequestInit = {}, store: AssetStore | null = null): Ctx {
  const url = new URL("http://x" + path);
  return {
    req: new Request(url, init),
    url,
    params: {},
    rawParams: {},
    state: {},
    head: {},
    response: { status: 200, headers: new Headers() },
    partial: false,
    env: {},
    waitUntil: () => {},
    assets: store,
    next: () => Promise.reject(new Error("not composed")),
  };
}

const APP = new Response("from the app", { status: 418 });
const run = (mw: Middleware, ctx: Ctx) => compose([mw], () => APP.clone())(ctx);

Deno.test("assets() serves a static path from the store with the app's cache policy", async () => {
  const store = fakeStore({ "/logo.svg": "<svg/>" });
  const mw = assets({
    isStatic: (p) => p === "/logo.svg",
    cacheControl: (p, url) => `public, max-age=60; ${p}; ${url.search}`,
  });
  const res = await run(mw, ctxFor("/logo.svg?v=1", {}, store));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "<svg/>");
  assertEquals(res.headers.get("cache-control"), "public, max-age=60; /logo.svg; ?v=1");
  assertEquals(res.headers.get("etag"), '"6"');
});

Deno.test("assets() keeps the policy on a revalidation: a 304 carries the same cache-control", async () => {
  const store = fakeStore({ "/a.css": "body{}" });
  const mw = assets({ cacheControl: () => "public, max-age=600" });
  const res = await run(mw, ctxFor("/a.css", { headers: { "if-none-match": '"6"' } }, store));
  assertEquals([res.status, res.headers.get("cache-control")], [304, "public, max-age=600"]);
});

Deno.test("assets() falls through for a path it is told is not static, without asking the store", async () => {
  const store = fakeStore({ "/a.css": "body{}" });
  const res = await run(assets({ isStatic: () => false }), ctxFor("/a.css", {}, store));
  assertEquals(res.status, 418);
  assertEquals(store.asked, []);
});

Deno.test("assets() falls through on a miss, and for a method that does not read", async () => {
  const store = fakeStore({ "/a.css": "body{}" });
  const mw = assets();
  assertEquals((await run(mw, ctxFor("/missing.css", {}, store))).status, 418);
  assertEquals((await run(mw, ctxFor("/a.css", { method: "POST" }, store))).status, 418);
  assertEquals((await run(mw, ctxFor("/a.css", { method: "DELETE" }, store))).status, 418);
  // POST and DELETE never reach the store.
  assertEquals(store.asked, ["GET /missing.css"]);
});

Deno.test("an outer middleware can set headers on a file the store served", async () => {
  const store = fakeStore({ "/a.css": "body{}" });
  const outer: Middleware = async (ctx) => {
    const res = await ctx.next();
    res.headers.set("x-frame-options", "DENY");
    return res;
  };
  const res = await compose([outer, assets()], () => APP.clone())(ctxFor("/a.css", {}, store));
  assertEquals([res.status, res.headers.get("x-frame-options")], [200, "DENY"]);
});

Deno.test("assets() answers HEAD from the store, without a body", async () => {
  const store = fakeStore({ "/a.css": "body{}" });
  const res = await run(assets(), ctxFor("/a.css", { method: "HEAD" }, store));
  assertEquals([res.status, await res.text()], [200, ""]);
});

Deno.test("assets() names a type the store did not, and leaves one it did alone", async () => {
  // A byte body carries no type, as celld's store sends none for an unknown extension.
  const store: AssetStore = {
    fetch: (input) => {
      const typed = new URL(input instanceof Request ? input.url : input).pathname === "/a.txt";
      return Promise.resolve(
        new Response(new Uint8Array([120]), {
          headers: typed ? { "content-type": "text/plain" } : {},
        }),
      );
    },
  };
  const mw = assets({ contentType: () => "application/x-custom" });
  const untyped = await run(mw, ctxFor("/LICENSE", {}, store));
  assertEquals(untyped.headers.get("content-type"), "application/x-custom");
  const typed = await run(mw, ctxFor("/a.txt", {}, store));
  assertEquals(typed.headers.get("content-type"), "text/plain");
});

Deno.test("assets() without a store falls through and says so once", async () => {
  const errors: unknown[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    const mw = assets();
    assertEquals((await run(mw, ctxFor("/a.css"))).status, 418);
    assertEquals((await run(mw, ctxFor("/b.css"))).status, 418);
    assertEquals(errors.length, 1);
  } finally {
    console.warn = warn;
  }
});

Deno.test("assets() serves through a policy that throws, with the store's own header, and says so once", async () => {
  const store = fakeStore({ "/a.css": "body{}" });
  const errors: unknown[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    const mw = assets({
      cacheControl: () => {
        throw new Error("policy bug");
      },
    });
    for (let i = 0; i < 2; i++) {
      const res = await run(mw, ctxFor("/a.css", {}, store));
      assertEquals([res.status, res.headers.get("cache-control")], [
        200,
        "public, max-age=0, must-revalidate",
      ]);
    }
    assertEquals(errors.length, 1);
  } finally {
    console.error = error;
  }
});

Deno.test("assets() can be given a store of its own instead of the runtime's", async () => {
  const own = fakeStore({ "/a.css": "own" });
  const runtime = fakeStore({ "/a.css": "runtime" });
  const res = await run(assets({ store: own }), ctxFor("/a.css", {}, runtime));
  assertEquals(await res.text(), "own");
  assertEquals(runtime.asked, []);
});

// ---- clientFiles: the /_fu/ policy of a built server ----

const FILES = ["/_fu/boot-abc.js", "/_fu/style-def.css"];
const app = (req: Request, extra?: RequestExtra) =>
  Promise.resolve(
    new Response(`app ${new URL(req.url).pathname} ${extra?.assets ? "with" : "without"}`, {
      status: 404,
      headers: { "cache-control": "no-store" },
    }),
  );
const handler = clientFiles(app, { prefix: "/_fu/", files: FILES });
const store = fakeStore({ "/_fu/boot-abc.js": "boot", "/_fu/style-def.css": "css" });
const call = async (path: string, init: RequestInit = {}, assets: AssetStore | null = store) => {
  const res = await handler(new Request("http://x" + path, init), { assets });
  return [res.status, res.headers.get("cache-control"), await res.text()];
};

Deno.test("a client file, asked for by its exact URL, is served from the store for good", async () => {
  assertEquals(await call("/_fu/boot-abc.js"), [200, IMMUTABLE, "boot"]);
  assertEquals(await call("/_fu/boot-abc.js?v=2"), [200, IMMUTABLE, "boot"]);
  assertEquals(await call("/_fu/boot-abc.js", { method: "HEAD" }), [200, IMMUTABLE, ""]);
  // A revalidation is not a failure: it keeps the asset's caching.
  assertEquals(
    await call("/_fu/boot-abc.js", { headers: { "if-none-match": '"4"' } }),
    [304, IMMUTABLE, ""],
  );
});

Deno.test("anything else under the prefix is a 404 nobody may cache, and the app is not asked", async () => {
  for (
    const path of [
      "/_fu/",
      "/_fu",
      "/_fu/boot-abc.js/",
      "/_fu/boot-0ld.js",
      "/_fu/%62oot-abc.js",
      "/_fu/sub/boot-abc.js",
    ]
  ) {
    assertEquals(await call(path), [404, "no-store", "Not Found"], path);
  }
  assertEquals(await call("/_fu/boot-abc.js", { method: "POST" }), [404, "no-store", "Not Found"]);
  assertEquals(await call("/_fu/nope", { method: "HEAD" }), [404, "no-store", ""]);
});

Deno.test("outside the prefix the app answers, and gets what the runtime passed", async () => {
  assertEquals(await call("/about"), [404, "no-store", "app /about with"]);
  assertEquals(await call("/_fux/a"), [404, "no-store", "app /_fux/a with"]);
  assertEquals(await call("//_fu/boot-abc.js"), [404, "no-store", "app //_fu/boot-abc.js with"]);
});

Deno.test("a client file with no store to serve it is a 500, logged once with the fix", async () => {
  const errors: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    const h = clientFiles(app, { prefix: "/_fu/", files: FILES });
    for (let i = 0; i < 2; i++) {
      const res = await h(new Request("http://x/_fu/boot-abc.js"), {});
      await res.body?.cancel();
      assertEquals([res.status, res.headers.get("cache-control")], [500, "no-store"]);
    }
    assertEquals(errors.length, 1);
    assertEquals(errors[0].includes("ASSETS"), true, errors[0]);
  } finally {
    console.error = error;
  }
});

Deno.test("a client file the store cannot find is a 404 nobody may cache", async () => {
  const empty = fakeStore({});
  assertEquals(await call("/_fu/boot-abc.js", {}, empty), [404, "no-store", "nope"]);
});
