import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { Component, Fragment, h } from "preact";
import { renderToString } from "preact-render-to-string";
import {
  __resetWarningsForTest,
  createHandler,
  document,
  FuHead,
  FuScripts,
  headMarker,
  MARKER_TOKEN,
  onlyHosts,
  Partial,
  scriptsMarker,
} from "./render.ts";
import {
  BUILD_ATTR,
  BUILD_PARAM,
  BUILD_RELOAD_HEADER,
  NAV_ATTR,
  PARTIAL_PARAM,
} from "./nav-protocol.ts";
import { App } from "./app.ts";
import { HttpError } from "./errors.ts";
import type { Assets, Ctx, RouteManifest } from "./types.ts";

const assets: Assets = { js: [{ href: "/boot.js" }], css: [{ href: "/style.css" }] };
const get = (h: (req: Request) => Promise<Response>, p: string, method = "GET") =>
  h(new Request("http://x" + p, { method }));

Deno.test("document renders the head fields the shell contract promises", () => {
  const html = document("BODY", {
    title: "T",
    description: "D",
    canonical: "http://x/c",
    robots: "noindex",
    image: "http://x/i.png",
    lang: "fi",
  }, assets);
  assertStringIncludes(html, '<html lang="fi">');
  assertStringIncludes(html, "<title>T</title>");
  assertStringIncludes(html, '<meta name="description" content="D">');
  assertStringIncludes(html, '<meta name="robots" content="noindex">');
  assertStringIncludes(html, '<link rel="canonical" href="http://x/c">');
  assertStringIncludes(html, '<meta property="og:title" content="T">');
  assertStringIncludes(html, '<meta property="og:image" content="http://x/i.png">');
  assertStringIncludes(html, '<link rel="stylesheet" href="/style.css">');
  assertStringIncludes(html, '<script type="module" src="/boot.js"></script>');
  assertStringIncludes(html, ">BODY<");
});

Deno.test("shared chunks are announced as modulepreload", () => {
  const html = document("", {}, { ...assets, preload: [{ href: "/jsxRuntime-x.js" }] });
  assertStringIncludes(html, '<link rel="modulepreload" href="/jsxRuntime-x.js">');
});

Deno.test("head values are escaped so they cannot break out of an attribute", () => {
  const html = document("", { title: '"><script>alert(1)</script>', description: "a & b" }, {
    js: [],
    css: [],
  });
  assertEquals(html.includes("<script>alert(1)"), false);
  assertStringIncludes(html, "&quot;&gt;&lt;script&gt;");
  assertStringIncludes(html, "a &amp; b");
});

Deno.test("json-ld cannot close its own script element", () => {
  const html = document("", { jsonLd: { x: "</script><script>alert(1)</script>" } }, {
    js: [],
    css: [],
  });
  assertEquals(html.includes("</script><script>alert(1)"), false);
  assertStringIncludes(html, "\\u003c/script");
});

Deno.test("head fields that were never set emit nothing", () => {
  const html = document("B", {}, { js: [], css: [] });
  assertEquals(html.includes("<title>"), false);
  assertEquals(html.includes("og:title"), false);
  assertStringIncludes(html, '<html lang="en">');
});

const manifest: RouteManifest = {
  "/routes/index.tsx": () =>
    Promise.resolve({
      handlers: {
        GET: (ctx: Ctx) => {
          ctx.head.title = "Home";
          return { hello: "world" };
        },
      },
      default: (ctx: Ctx) => h("p", null, JSON.stringify(ctx.data)),
    }),
  "/routes/blog/[slug].tsx": () =>
    Promise.resolve({ default: (ctx: Ctx) => h("h1", null, ctx.params.slug) }),
  "/routes/api.ts": () =>
    Promise.resolve({ handlers: { POST: () => new Response("made", { status: 201 }) } }),
  "/routes/nopage.ts": () => Promise.resolve({ handlers: { GET: () => ({ a: 1 }) } }),
};

Deno.test("routing, params, handler data and head all reach the response", async () => {
  const handler = createHandler({ manifest, assets });
  const res = await get(handler, "/");
  const html = await res.text();
  assertEquals(res.status, 200);
  assertStringIncludes(html, "<title>Home</title>");
  assertStringIncludes(html, "{&quot;hello&quot;:&quot;world&quot;}");
  assertStringIncludes(await (await get(handler, "/blog/abc")).text(), "<h1>abc</h1>");
});

Deno.test("unmatched is 404 and a wrong method on a matched route is 405", async () => {
  const handler = createHandler({ manifest, assets });
  assertEquals((await get(handler, "/nothing-here")).status, 404);
  assertEquals((await get(handler, "/api", "GET")).status, 405);
  assertEquals((await get(handler, "/api", "POST")).status, 201);
});

Deno.test("a 405 names the methods the route does answer", async () => {
  const handler = createHandler({ manifest, assets });
  const res = await get(handler, "/api", "GET");
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "POST, OPTIONS");
  assertEquals((await get(handler, "/", "DELETE")).headers.get("allow"), "GET, HEAD, OPTIONS");
});

Deno.test("a page without handlers renders for GET and HEAD only", async () => {
  const handler = createHandler({ manifest, assets });
  const post = await get(handler, "/blog/abc", "POST");
  assertEquals(post.status, 405);
  assertEquals(post.headers.get("allow"), "GET, HEAD, OPTIONS");
  const head = await get(handler, "/blog/abc", "HEAD");
  assertEquals(head.status, 200);
  assertEquals(head.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(await head.text(), "");
});

Deno.test("HEAD runs the GET handler and drops the body, errors included", async () => {
  const handler = createHandler({ manifest, assets });
  const res = await get(handler, "/", "HEAD");
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "");
  const missing = await get(handler, "/nothing-here", "HEAD");
  assertEquals(missing.status, 404);
  assertEquals(await missing.text(), "");
});

Deno.test("OPTIONS is answered with the allowed methods", async () => {
  const res = await get(createHandler({ manifest, assets }), "/api", "OPTIONS");
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("allow"), "POST, OPTIONS");
});

Deno.test("a route that only posts still renders its page on GET", async () => {
  const handler = createHandler({
    manifest: {
      "/routes/form.tsx": () =>
        Promise.resolve({
          handlers: { POST: () => new Response(null, { status: 303, headers: { location: "/" } }) },
          default: () => h("form", null),
        }),
    },
    assets,
  });
  const res = await get(handler, "/form");
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "<form></form>");
  assertEquals((await get(handler, "/form", "POST")).status, 303);
});

Deno.test("a handler returning a Response short-circuits rendering", async () => {
  const handler = createHandler({ manifest, assets });
  const res = await get(handler, "/api", "POST");
  assertEquals(await res.text(), "made");
});

Deno.test("a handler that returns data with no page to render it is a 500, not a 404", async () => {
  // The handler ran, side effects and all, so "Not Found" would be a lie; a
  // forgotten `return` in an API route is the usual cause.
  const origError = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => logged.push(...a);
  try {
    assertEquals((await get(createHandler({ manifest, assets }), "/nopage")).status, 500);
  } finally {
    console.error = origError;
  }
  assertStringIncludes(String(logged.find((e) => e instanceof Error)), "no page");
});

Deno.test("only a route's own handlers answer, not what an object inherits", async () => {
  const handler = createHandler({ manifest, assets });
  for (const method of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
    const res = await handler(new Request("http://x/", { method }));
    assertEquals(res.status, 405, method);
  }
});

Deno.test("middleware runs before routing, so params are empty inside it", async () => {
  let seen: Record<string, string> | null = null;
  const app = new App().use((ctx) => {
    seen = { ...ctx.params };
    return ctx.next();
  });
  await get(createHandler({ manifest, assets, app }), "/blog/abc");
  assertEquals(seen, {});
});

Deno.test("middleware can answer a path no route matches", async () => {
  const app = new App().use((ctx) =>
    ctx.url.pathname === "/healthz" ? new Response("ok") : ctx.next()
  );
  const handler = createHandler({ manifest, assets, app });
  assertEquals(await (await get(handler, "/healthz")).text(), "ok");
  assertEquals((await get(handler, "/healthz-nope")).status, 404);
});

Deno.test("the shell wraps the page and can read state", async () => {
  const handler = createHandler({
    manifest,
    assets,
    initialState: () => ({ tenant: "acme" }),
    Shell: ({ ctx, children }) =>
      h(
        "div",
        { id: "shell" },
        h("span", null, (ctx.state as { tenant: string }).tenant),
        children,
      ),
  });
  const html = await (await get(handler, "/")).text();
  assertStringIncludes(html, '<div id="shell">');
  assertStringIncludes(html, "<span>acme</span>");
  assertStringIncludes(html, "{&quot;hello&quot;:&quot;world&quot;}");
});

Deno.test("islands are wrapped in a hydration marker carrying their props", async () => {
  const Island = (props: { n: number }) => h("b", null, String(props.n));
  (Island as unknown as { __island: string }).__island = "/islands/X.tsx";
  const handler = createHandler({
    manifest: {
      "/routes/index.tsx": () => Promise.resolve({ default: () => h(Island, { n: 7 }) }),
    },
    assets,
  });
  const html = await (await get(handler, "/")).text();
  assertStringIncludes(html, 'data-island="/islands/X.tsx"');
  assertStringIncludes(html, "&quot;n&quot;:7");
  assertStringIncludes(html, "<b>7</b>");
});

Deno.test("an island passed JSX children or a function fails loudly, not on hydrate", async () => {
  // JSON turns a vnode into an object Preact cannot render, so the client would
  // hydrate the island with nothing and wipe the server's markup.
  const Island = (_props: { children?: unknown; onPick?: unknown }) => h("i", null, "x");
  (Island as unknown as { __island: string }).__island = "/islands/K.tsx";
  const page = (props: Record<string, unknown>) =>
    createHandler({
      manifest: { "/routes/index.tsx": () => Promise.resolve({ default: () => h(Island, props) }) },
      assets,
    });
  const origError = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => logged.push(...a);
  try {
    assertEquals((await get(page({ children: h("p", null, "kid") }), "/")).status, 500);
    assertEquals((await get(page({ onPick: () => {} }), "/")).status, 500);
  } finally {
    console.error = origError;
  }
  assertStringIncludes(String(logged.find((e) => e instanceof Error)), 'prop "children"');
  // Plain text children are data and still fine.
  const ok = await get(page({ children: "just text" }), "/");
  assertEquals(ok.status, 200);
  assertStringIncludes(await ok.text(), "just text");
});

// The error page receives ctx just like a page component does.
const ErrorPage = (ctx: Ctx) =>
  h("main", { id: "err" }, `${ctx.error?.status}: ${ctx.error?.message}`);

const failing: RouteManifest = {
  ...manifest,
  "/routes/boom.tsx": () =>
    Promise.resolve({
      default: () => {
        throw new Error("secret connection string");
      },
    }),
  "/routes/forbidden.tsx": () =>
    Promise.resolve({
      handlers: {
        GET: () => {
          throw new HttpError(403, "Not yours");
        },
      },
    }),
};

Deno.test("without an error page, failures are plain text and uncacheable", async () => {
  const handler = createHandler({ manifest: failing, assets });
  const res = await get(handler, "/nothing");
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertStringIncludes(await res.text(), "404 Not Found");
});

Deno.test("the error page renders for 404, 405, thrown HttpError and a bare throw", async () => {
  const handler = createHandler({ manifest: failing, assets, ErrorPage });
  for (
    const [path, method, status, body] of [
      ["/nothing", "GET", 404, "404: Not Found"],
      ["/api", "GET", 405, "405: Method Not Allowed"],
      ["/forbidden", "GET", 403, "403: Not yours"],
      ["/boom", "GET", 500, "500: Internal Server Error"],
    ] as const
  ) {
    const res = await get(handler, path, method);
    assertEquals(res.status, status);
    assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
    assertStringIncludes(await res.text(), body);
  }
});

Deno.test("a 500 never renders the underlying message", async () => {
  const handler = createHandler({ manifest: failing, assets, ErrorPage });
  const html = await (await get(handler, "/boom")).text();
  assertEquals(html.includes("secret connection string"), false);
});

Deno.test("error pages are noindex and titled by default", async () => {
  const html = await (await get(createHandler({ manifest: failing, assets, ErrorPage }), "/nope"))
    .text();
  assertStringIncludes(html, "<title>404 Not Found</title>");
  assertStringIncludes(html, '<meta name="robots" content="noindex">');
});

Deno.test("the error page does not inherit what the failed page said about itself", async () => {
  const handler = createHandler({
    manifest: {
      "/routes/todo.tsx": () =>
        Promise.resolve({
          handlers: {
            GET: (ctx: Ctx) => {
              ctx.head.title = "Todo 1";
              ctx.head.canonical = "http://x/todo";
              ctx.head.jsonLd = { "@type": "Thing" };
              throw new HttpError(404);
            },
          },
          default: () => h("p", null),
        }),
    },
    assets,
    ErrorPage,
    app: new App().use((ctx) => {
      ctx.head.lang = "fi";
      ctx.head.robots = "index, follow";
      return ctx.next();
    }),
  });
  const html = await (await get(handler, "/todo")).text();
  assertStringIncludes(html, "<title>404 Not Found</title>");
  assertStringIncludes(html, '<meta name="robots" content="noindex">');
  assertStringIncludes(html, '<html lang="fi">');
  assertEquals(html.includes("Todo 1"), false);
  assertEquals(html.includes("canonical"), false);
  assertEquals(html.includes("ld+json"), false);
});

Deno.test("the error response still travels out through the middleware chain", async () => {
  // This is why errors are caught at the terminal rather than rethrown: the
  // security-header and logging middleware must see them.
  const app = new App().use(async (ctx) => {
    const res = await ctx.next();
    res.headers.set("X-Seen", String(res.status));
    return res;
  });
  const res = await get(createHandler({ manifest: failing, assets, app, ErrorPage }), "/boom");
  assertEquals(res.headers.get("X-Seen"), "500");
});

Deno.test("an error thrown by middleware is caught too", async () => {
  const app = new App().use(() => {
    throw new HttpError(503, "draining");
  });
  const res = await get(createHandler({ manifest: failing, assets, app, ErrorPage }), "/");
  assertEquals(res.status, 503);
  assertStringIncludes(await res.text(), "503: draining");
});

Deno.test("a middleware throw is rendered after the chain unwinds, undecorated", async () => {
  // The price of letting a throw propagate past `await ctx.next()`: by the time
  // it becomes a response, the middleware that set headers have already exited.
  const app = new App()
    .use(async (ctx) => {
      const res = await ctx.next();
      res.headers.set("X-Seen", "1");
      return res;
    })
    .use(() => {
      throw new HttpError(503, "draining");
    });
  const res = await get(createHandler({ manifest: failing, assets, app, ErrorPage }), "/");
  assertEquals(res.status, 503);
  assertEquals(res.headers.get("X-Seen"), null);
});

Deno.test("an error page that itself throws falls back instead of masking", async () => {
  const handler = createHandler({
    manifest: failing,
    assets,
    ErrorPage: () => {
      throw new Error("error page is broken too");
    },
  });
  const res = await get(handler, "/boom");
  assertEquals(res.status, 500);
  assertStringIncludes(await res.text(), "500 Internal Server Error");
});

Deno.test("the error page's response is uncacheable too", async () => {
  const handler = createHandler({ manifest: failing, assets, ErrorPage });
  for (const path of ["/nothing", "/boom"]) {
    const origError = console.error;
    console.error = () => {};
    try {
      assertEquals((await get(handler, path)).headers.get("cache-control"), "no-store", path);
    } finally {
      console.error = origError;
    }
  }
});

Deno.test("an island written as a class renders inside its marker", async () => {
  class Cls extends Component<{ n: number }> {
    render() {
      return h("b", null, String(this.props.n));
    }
  }
  (Cls as unknown as { __island: string }).__island = "/islands/Cls.tsx";
  const handler = createHandler({
    manifest: { "/routes/index.tsx": () => Promise.resolve({ default: () => h(Cls, { n: 3 }) }) },
    assets,
  });
  const res = await get(handler, "/");
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, 'data-island="/islands/Cls.tsx"');
  assertStringIncludes(html, "<b>3</b>");
});

Deno.test("an island rendered inside another island belongs to the outer one", async () => {
  // Its own marker would make the client hydrate it twice: once as part of the
  // outer island, and once more into the node that hydration just replaced.
  const Inner = (props: { n: number }) => h("i", null, String(props.n));
  (Inner as unknown as { __island: string }).__island = "/islands/Inner.tsx";
  const Outer = () => h("section", null, h(Inner, { n: 1 }));
  (Outer as unknown as { __island: string }).__island = "/islands/Outer.tsx";
  const handler = createHandler({
    manifest: {
      "/routes/index.tsx": () =>
        Promise.resolve({ default: () => h("div", null, h(Outer, null), h(Inner, { n: 2 })) }),
    },
    assets,
  });
  const html = await (await get(handler, "/")).text();
  assertStringIncludes(html, "<section><i>1</i></section>");
  assertEquals(html.match(/data-island="[^"]+"/g), [
    'data-island="/islands/Outer.tsx"',
    'data-island="/islands/Inner.tsx"',
  ]);
});

Deno.test("a dev server answers only to the names it was started for", async () => {
  // A page on another site can point its own domain at 127.0.0.1 and read the
  // dev server through it; the Host header is what gives that away.
  const guarded = onlyHosts(() => Promise.resolve(new Response("ok")), ["localhost", "127.0.0.1"]);
  const status = async (url: string) => (await guarded(new Request(url))).status;
  assertEquals(await status("http://localhost:1337/"), 200);
  assertEquals(await status("http://127.0.0.1:1337/"), 200);
  assertEquals(await status("http://acme.localhost:1337/"), 200);
  assertEquals(await status("http://attacker.example:1337/"), 403);
  assertEquals(await status("http://localhost.attacker.example:1337/"), 403);
});

Deno.test("the islands a page rendered are preloaded, and only those", async () => {
  // Otherwise the browser learns of an island's chunk only after the entry
  // has downloaded and run: one more round trip before anything hydrates.
  const Used = () => h("b", null, "x");
  (Used as unknown as { __island: string }).__island = "/islands/W.tsx#Used";
  const handler = createHandler({
    manifest: {
      "/routes/index.tsx": () => Promise.resolve({ default: () => h("p", null, h(Used, null)) }),
      "/routes/plain.tsx": () => Promise.resolve({ default: () => h("p", null) }),
    },
    assets: {
      ...assets,
      islands: { "/islands/W.tsx": "/_fu/W-abc.js", "/islands/Other.tsx": "/_fu/Other-def.js" },
    },
  });
  const home = await (await get(handler, "/")).text();
  assertStringIncludes(home, '<link rel="modulepreload" href="/_fu/W-abc.js">');
  assertEquals(home.includes("Other-def"), false);
  assertEquals((await (await get(handler, "/plain")).text()).includes("modulepreload"), false);
});

Deno.test("an island's list of chunks is preloaded with it, each chunk once per page", async () => {
  // A build maps an island to its chunk and that chunk's static imports.
  const A = Object.assign(() => h("b", null, "a"), { __island: "/islands/A.tsx" });
  const B = Object.assign(() => h("b", null, "b"), { __island: "/islands/B.tsx" });
  const handler = createHandler({
    manifest: {
      "/routes/index.tsx": () =>
        Promise.resolve({ default: () => h("p", null, h(A, null), h(B, null), h(A, null)) }),
      "/routes/b.tsx": () => Promise.resolve({ default: () => h("p", null, h(B, null)) }),
      "/routes/plain.tsx": () => Promise.resolve({ default: () => h("p", null) }),
    },
    assets: {
      js: [],
      css: [],
      preload: [{ href: "/_fu/preact.js" }],
      islands: {
        "/islands/A.tsx": ["/_fu/A.js", "/_fu/jsx.js", "/_fu/shared.js"],
        "/islands/B.tsx": ["/_fu/B.js", "/_fu/shared.js", "/_fu/jsx.js", "/_fu/onlyB.js"],
        "/islands/C.tsx": ["/_fu/C.js", "/_fu/onlyC.js"],
      },
    },
  });
  const preloads = async (path: string) =>
    [...(await (await get(handler, path)).text()).matchAll(/rel="modulepreload" href="([^"]+)"/g)]
      .map((m) => m[1]);
  // What every page preloads, then what these islands import, then the islands.
  assertEquals(await preloads("/"), [
    "/_fu/preact.js",
    "/_fu/jsx.js",
    "/_fu/shared.js",
    "/_fu/onlyB.js",
    "/_fu/A.js",
    "/_fu/B.js",
  ]);
  assertEquals(await preloads("/b"), [
    "/_fu/preact.js",
    "/_fu/shared.js",
    "/_fu/jsx.js",
    "/_fu/onlyB.js",
    "/_fu/B.js",
  ]);
  assertEquals(await preloads("/plain"), ["/_fu/preact.js"]);
});

Deno.test("a function deep inside an island's props is refused too", async () => {
  const Island = (_props: { a: unknown }) => h("i", null);
  (Island as unknown as { __island: string }).__island = "/islands/D.tsx";
  const handler = createHandler({
    manifest: {
      "/routes/index.tsx": () =>
        Promise.resolve({ default: () => h(Island, { a: [{ pick: () => {} }] }) }),
    },
    assets,
  });
  const origError = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => logged.push(...a);
  try {
    assertEquals((await get(handler, "/")).status, 500);
  } finally {
    console.error = origError;
  }
  assertStringIncludes(String(logged.find((e) => e instanceof Error)), 'prop "pick"');
});

Deno.test("a handler can set the status and headers of its rendered page", async () => {
  const handler = createHandler({
    manifest: {
      "/routes/home.tsx": () =>
        Promise.resolve({
          handlers: {
            GET: (ctx: Ctx) => {
              ctx.response.status = 203;
              ctx.response.headers.set("last-modified", "Thu, 01 Jan 2026 00:00:00 GMT");
              ctx.response.headers.set("cache-control", "public, max-age=60");
              return { ok: true };
            },
          },
          default: () => h("p", null, "home"),
        }),
    },
    assets,
  });
  const res = await get(handler, "/home");
  assertEquals(res.status, 203);
  assertEquals(res.headers.get("last-modified"), "Thu, 01 Jan 2026 00:00:00 GMT");
  assertEquals(res.headers.get("cache-control"), "public, max-age=60");
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  assertStringIncludes(await res.text(), "<p>home</p>");
});

Deno.test("ctx.response is ignored when the handler throws, so an error stays uncacheable", async () => {
  const handler = createHandler({
    manifest: {
      "/routes/home.tsx": () =>
        Promise.resolve({
          handlers: {
            GET: (ctx: Ctx) => {
              ctx.response.status = 203;
              ctx.response.headers.set("cache-control", "public, max-age=60");
              ctx.response.headers.set("x-from-handler", "1");
              throw new HttpError(404);
            },
          },
          default: () => h("p", null),
        }),
    },
    assets,
  });
  const res = await get(handler, "/home");
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("x-from-handler"), null);
});

Deno.test("ctx.response is ignored when the handler returns a Response", async () => {
  const handler = createHandler({
    manifest: {
      "/routes/api.ts": () =>
        Promise.resolve({
          handlers: {
            GET: (ctx: Ctx) => {
              ctx.response.status = 203;
              return new Response("raw", { status: 201 });
            },
          },
        }),
    },
    assets,
  });
  const res = await get(handler, "/api");
  assertEquals(res.status, 201);
});

Deno.test("middleware sees the same ctx.response object the handler wrote to", async () => {
  let seen: string | null = null;
  const app = new App().use(async (ctx) => {
    const res = await ctx.next();
    seen = ctx.response.headers.get("x-page");
    return res;
  });
  const handler = createHandler({
    manifest: {
      "/routes/home.tsx": () =>
        Promise.resolve({
          handlers: {
            GET: (ctx: Ctx) => {
              ctx.response.headers.set("x-page", "home");
              return null;
            },
          },
          default: () => h("p", null),
        }),
    },
    assets,
    app,
  });
  await get(handler, "/home");
  assertEquals(seen, "home");
});

Deno.test("a status outside 200-599 on ctx.response is a programming error", async () => {
  const handler = createHandler({
    manifest: {
      "/routes/home.tsx": () =>
        Promise.resolve({
          handlers: {
            GET: (ctx: Ctx) => {
              ctx.response.status = 99;
              return null;
            },
          },
          default: () => h("p", null),
        }),
    },
    assets,
  });
  const origError = console.error;
  console.error = () => {};
  try {
    assertEquals((await get(handler, "/home")).status, 500);
  } finally {
    console.error = origError;
  }
});

Deno.test("a rendered page with an error status on ctx.response is forced to no-store", async () => {
  const handler = createHandler({
    manifest: {
      "/routes/home.tsx": () =>
        Promise.resolve({
          handlers: {
            GET: (ctx: Ctx) => {
              ctx.response.status = 404;
              ctx.response.headers.set("cache-control", "public, max-age=60");
              return null;
            },
          },
          default: () => h("p", null, "gone"),
        }),
    },
    assets,
  });
  const res = await get(handler, "/home");
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("cache-control"), "no-store");
  await res.body?.cancel();
});

Deno.test("set-cookie appended twice on ctx.response reaches the response as two cookies", async () => {
  const handler = createHandler({
    manifest: {
      "/routes/home.tsx": () =>
        Promise.resolve({
          handlers: {
            GET: (ctx: Ctx) => {
              ctx.response.headers.append("set-cookie", "a=1; Path=/");
              ctx.response.headers.append("set-cookie", "b=2; Path=/");
              return null;
            },
          },
          default: () => h("p", null),
        }),
    },
    assets,
  });
  const res = await get(handler, "/home");
  assertEquals(res.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
  await res.body?.cancel();
});

Deno.test("a bodiless status (204, 205, 304) on ctx.response is a programming error", async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    for (const status of [204, 205, 304]) {
      const handler = createHandler({
        manifest: {
          "/routes/home.tsx": () =>
            Promise.resolve({
              handlers: {
                GET: (ctx: Ctx) => {
                  ctx.response.status = status;
                  return null;
                },
              },
              default: () => h("p", null),
            }),
        },
        assets,
      });
      const logged: unknown[] = [];
      console.error = (...a: unknown[]) => logged.push(...a);
      const res = await get(handler, "/home");
      assertEquals(res.status, 500, String(status));
      await res.body?.cancel();
      const err = logged.find((e) => e instanceof Error);
      assertEquals(err instanceof RangeError, true, String(status));
    }
  } finally {
    console.error = origError;
  }
});

const HEAD_MARKER = headMarker();
const SCRIPTS_MARKER = scriptsMarker();

Deno.test("the marker components render the exact strings document() replaces", () => {
  // Pinned so a renderer upgrade that changes attribute or self-closing
  // output fails here, not silently in production.
  assertEquals(renderToString(h(FuHead, null)), HEAD_MARKER);
  assertEquals(renderToString(h(FuScripts, null)), SCRIPTS_MARKER);
  assertEquals(HEAD_MARKER, `<fu-marker data-fu="head" data-k="${MARKER_TOKEN}"></fu-marker>`);
  assertEquals(/^[0-9a-f]{16}$/.test(MARKER_TOKEN), true);
});

Deno.test("raw HTML cannot relocate fu's tags: a marker without the token is left alone", () => {
  // dangerouslySetInnerHTML could carry a marker-shaped string; without the
  // per-process token it is just markup, and the real marker still wins.
  const forged = '<fu-marker data-fu="scripts" data-k="0000000000000000"></fu-marker>';
  const body =
    `<html><head>${HEAD_MARKER}</head><body><div>${forged}</div>${SCRIPTS_MARKER}</body></html>`;
  const html = document(body, {}, assets);
  assertStringIncludes(
    html,
    `<div>${forged}</div><script type="module" src="/boot.js"></script></body>`,
  );
});

Deno.test("a marker that occurs twice is a shell bug and fails the render", () => {
  const body =
    `<html><head>${HEAD_MARKER}</head><body>${SCRIPTS_MARKER}${SCRIPTS_MARKER}</body></html>`;
  let err: unknown;
  try {
    document(body, {}, assets);
  } catch (e) {
    err = e;
  }
  assertStringIncludes(String(err), "FuScripts");
});

Deno.test("a shell that renders <html> owns the document and gets the tags at its markers", () => {
  const body = `<html lang="fi" data-x="1"><head><meta charset="utf-8">${HEAD_MARKER}` +
    `<link rel="ai-info" href="/llms.txt"></head><body data-view="landing">B${SCRIPTS_MARKER}</body></html>`;
  const html = document(body, { title: "T", robots: "noindex" }, {
    ...assets,
    preload: [{ href: "/_fu/jsxRuntime-x.js" }],
    islands: { "/islands/W.tsx": "/_fu/W-abc.js" },
  }, ["/islands/W.tsx"]);
  assertEquals(html.startsWith('<!doctype html><html lang="fi" data-x="1"><head>'), true);
  assertEquals(html.match(/<!doctype html>/gi)?.length, 1);
  // Only one charset: the shell's.
  assertEquals(html.match(/charset="utf-8"/g)?.length, 1);
  assertEquals(html.includes("viewport"), false);
  const headAt = html.indexOf("<title>T</title>");
  const cssAt = html.indexOf('<link rel="stylesheet" href="/style.css">');
  const sharedAt = html.indexOf('<link rel="modulepreload" href="/_fu/jsxRuntime-x.js">');
  const islandAt = html.indexOf('<link rel="modulepreload" href="/_fu/W-abc.js">');
  const aiAt = html.indexOf('<link rel="ai-info"');
  assertEquals(headAt > 0 && headAt < cssAt && cssAt < sharedAt && sharedAt < islandAt, true);
  assertEquals(islandAt < aiAt, true);
  assertStringIncludes(html, '<meta name="robots" content="noindex">');
  assertStringIncludes(html, 'B<script type="module" src="/boot.js"></script></body></html>');
  assertEquals(html.includes("fu-marker"), false);
});

Deno.test("an owned document is recognised with an upper-case doctype and leading whitespace", () => {
  const body =
    `\n  <!DOCTYPE html>\n<html><head>${HEAD_MARKER}</head><body>${SCRIPTS_MARKER}</body></html>`;
  const html = document(body, {}, assets);
  assertEquals(html.match(/doctype/gi)?.length, 1);
  assertEquals(html.startsWith("<!doctype html><html><head>"), true);
  assertStringIncludes(html, '<link rel="stylesheet" href="/style.css">');
});

Deno.test("an owned document without a scripts marker gets no boot script and warns once", () => {
  const origWarn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...a: unknown[]) => warned.push(a.join(" "));
  __resetWarningsForTest();
  try {
    const body = `<html><head>${HEAD_MARKER}</head><body>no islands here</body></html>`;
    const first = document(body, {}, assets);
    const second = document(body, {}, assets);
    assertEquals(first.includes("<script"), false);
    assertEquals(second.includes("<script"), false);
  } finally {
    console.warn = origWarn;
  }
  assertEquals(warned.filter((w) => String(w).includes("FuScripts")).length, 1);
});

Deno.test("a missing head marker warns that ctx.head fields are not emitted either", () => {
  const origWarn = console.warn;
  const warned: string[] = [];
  console.warn = (...a: unknown[]) => warned.push(a.join(" "));
  __resetWarningsForTest();
  try {
    document(`<html><head></head><body>${SCRIPTS_MARKER}</body></html>`, { title: "T" }, assets);
  } finally {
    console.warn = origWarn;
  }
  const msg = warned.find((w) => w.includes("FuHead")) ?? "";
  assertStringIncludes(msg, "ctx.head");
  assertStringIncludes(msg, "title");
  assertStringIncludes(msg, "robots");
});

Deno.test("a comment or a legacy doctype before <html> still marks an owned document", () => {
  const rest = `<html><head>${HEAD_MARKER}</head><body>${SCRIPTS_MARKER}</body></html>`;
  for (
    const lead of [
      "<!-- rendered by x -->\n",
      '<!DOCTYPE html SYSTEM "about:legacy-compat">',
      "<!-- a -->\n<!doctype html><!-- b -->\n",
    ]
  ) {
    const html = document(lead + rest, {}, assets);
    assertEquals(html.match(/<!doctype/gi)?.length, 1, lead);
    assertEquals(html.startsWith("<!doctype html><"), true, lead);
    assertStringIncludes(html, '<html><head><link rel="stylesheet" href="/style.css">');
    assertEquals(html.includes("fu-marker"), false, lead);
  }
});

Deno.test("the leading comments of an owned document are kept, after the doctype", () => {
  const rest = `<html><head>${HEAD_MARKER}</head><body>${SCRIPTS_MARKER}</body></html>`;
  const out = (lead: string) => document(lead + rest, {}, assets).split("<html>")[0];
  assertEquals(out("<!-- rendered by x -->\n"), "<!doctype html><!-- rendered by x -->");
  assertEquals(
    out(" <!-- a -->\n<!DOCTYPE html>\n<!-- b --><!---->\n"),
    "<!doctype html><!-- a --><!-- b --><!---->",
  );
  assertEquals(out("<!doctype html>"), "<!doctype html>");
  assertEquals(out(""), "<!doctype html>");
});

Deno.test("only comments and a doctype may precede <html> in an owned document", () => {
  const wrapped = (body: string) => {
    const html = document(body, {}, assets);
    // fu's own document around it: the body is inside <body>, whole.
    assertStringIncludes(html, `<body>${body}<script`, body);
  };
  // A comment, content, another comment, then <html>: the content is the
  // page. Taking this for an owned document would delete the <p>.
  wrapped("<!-- a --><p>x</p><!-- b --><html><head></head><body></body></html>");
  wrapped("<p>x</p><html></html>");
  wrapped("<!-- never closed <html><head></head></html>");
  wrapped("<!doctype html><!doctype html><html></html>");
  wrapped("<!doctype svg><html></html>");
  wrapped("<htmlx></htmlx>");
  wrapped("<!-- a -->");
});

Deno.test("deciding ownership is linear in the number of leading comments", () => {
  // The first matcher was a regex that backtracked exponentially: 26 empty
  // comments before a <div> took about 20 seconds, and each further comment
  // doubled it. The scanner takes well under a millisecond for 5000, so the
  // bound is loose enough for any loaded machine and still far below what
  // exponential, or even quadratic with a large constant, would need.
  const LIMIT_MS = 2000;
  for (const n of [26, 5000]) {
    const body = "<!---->".repeat(n) + "<div>x</div>";
    const start = performance.now();
    const html = document(body, {}, assets);
    const ms = performance.now() - start;
    assertEquals(ms < LIMIT_MS, true, `${n} comments took ${ms} ms`);
    assertStringIncludes(html, "<body><!----><!---->");
  }
  const owned = "<!-- c -->".repeat(5000) + "<html><head></head><body></body></html>";
  __resetWarningsForTest();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const start = performance.now();
    const html = document(owned, {}, assets);
    assertEquals(performance.now() - start < LIMIT_MS, true);
    assertEquals(html.startsWith("<!doctype html><!-- c --><!-- c -->"), true);
  } finally {
    console.warn = warn;
    __resetWarningsForTest();
  }
});

Deno.test("the marker token never reaches a client when the shell does not own the document", () => {
  const origWarn = console.warn;
  const warned: string[] = [];
  console.warn = (...a: unknown[]) => warned.push(a.join(" "));
  __resetWarningsForTest();
  try {
    const html = document(`<div>B${HEAD_MARKER}${SCRIPTS_MARKER}</div>`, {}, assets);
    assertEquals(html.includes(MARKER_TOKEN), false);
    assertEquals(html.includes("fu-marker"), false);
    // Hydration is unchanged: the boot script is where the wrapped document puts it.
    assertStringIncludes(
      html,
      '<body><div>B</div><script type="module" src="/boot.js"></script></body>',
    );
  } finally {
    console.warn = origWarn;
  }
  assertEquals(
    warned.filter((w) => w.includes("outside a document-owning shell")).length,
    1,
  );
});

Deno.test("a non-owned document is byte-identical to what v0.4.3 produced", () => {
  // The expectation was verified by executing v0.4.3's document(): identical
  // across a 360-case matrix of head fields and asset lists.
  const html = document(
    '<div data-island="x">B</div>',
    { title: "T & U", description: "D", lang: "fi", jsonLd: { a: "</b>" } },
    {
      js: [{ href: "/b.js" }],
      css: [{ href: "/s.css" }],
      preload: [{ href: "/p.js" }],
      islands: { "/islands/W.tsx": "/_fu/W.js" },
    },
    ["/islands/W.tsx"],
  );
  assertEquals(
    html,
    '<!doctype html><html lang="fi"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      "<title>T &amp; U</title>" +
      '<meta name="description" content="D">' +
      '<meta property="og:title" content="T &amp; U">' +
      '<meta property="og:description" content="D">' +
      '<link rel="stylesheet" href="/s.css">' +
      '<link rel="modulepreload" href="/p.js">' +
      '<link rel="modulepreload" href="/_fu/W.js">' +
      '<script type="application/ld+json">{"a":"\\u003c/b>"}</script>' +
      '</head><body><div data-island="x">B</div><script type="module" src="/b.js"></script>' +
      "</body></html>",
  );
});

const Island = Object.assign(() => h("i", null, "isl"), { __island: "/islands/W.tsx#default" });
const owningAssets: Assets = {
  js: [{ href: "/boot.js" }],
  css: [{ href: "/style.css" }],
  islands: { "/islands/W.tsx": "/_fu/W-abc.js" },
};
const ownManifest: RouteManifest = {
  "/routes/index.tsx": () => Promise.resolve({ default: () => h("main", null, h(Island, null)) }),
};
const ownShell = ({ children }: { children: unknown }) =>
  h(
    "html",
    { lang: "fi" },
    h("head", null, h(FuHead, null)),
    h("body", null, children as never, h(FuScripts, null)),
  );

Deno.test("handler: a 200 page through an owning shell gets css, island preload and boot script", async () => {
  const handler = createHandler({
    manifest: ownManifest,
    assets: owningAssets,
    Shell: ownShell as never,
  });
  const res = await get(handler, "/");
  const html = await res.text();
  assertEquals(res.status, 200);
  assertEquals(html.match(/<!doctype html>/gi)?.length, 1);
  assertEquals(html.includes("fu-marker"), false);
  assertEquals(html.includes(MARKER_TOKEN), false);
  assertStringIncludes(html, '<head><link rel="stylesheet" href="/style.css">');
  assertStringIncludes(html, '<link rel="modulepreload" href="/_fu/W-abc.js">');
  assertStringIncludes(html, '<script type="module" src="/boot.js"></script></body></html>');
});

Deno.test("handler: a 404 rendered through _error and the owning shell gets the same tags", async () => {
  const handler = createHandler({
    manifest: ownManifest,
    assets: owningAssets,
    Shell: ownShell as never,
    ErrorPage: (ctx) => h("section", null, String(ctx.error?.status)),
  });
  const res = await get(handler, "/missing");
  const html = await res.text();
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(html.match(/<!doctype html>/gi)?.length, 1);
  assertStringIncludes(html, "<section>404</section>");
  assertStringIncludes(html, '<link rel="stylesheet" href="/style.css">');
  assertStringIncludes(html, '<script type="module" src="/boot.js"></script></body></html>');
  assertEquals(html.includes(MARKER_TOKEN), false);
});

/** An owning shell that writes its own title and robots tag, as a real one does. */
const titledShell = ({ ctx, children }: { ctx: Ctx; children: unknown }) =>
  h(
    "html",
    { lang: "fi" },
    h(
      "head",
      null,
      h("title", null, ctx.error ? "Oops" : "Site"),
      ctx.error && h("meta", { name: "robots", content: "noindex, nofollow" }),
      h(FuHead, null),
    ),
    h("body", null, children as never, h(FuScripts, null)),
  );

Deno.test("an owning shell owns the error page's head: fu adds no title or robots of its own", async () => {
  // The shell writes its own; fu's defaults beside them were a second <title>,
  // a second robots tag and an og:title nobody asked for.
  const handler = createHandler({
    manifest: {
      "/routes/todo.tsx": () =>
        Promise.resolve({
          handlers: {
            GET: (ctx: Ctx) => {
              ctx.head.title = "Todo 1";
              ctx.head.canonical = "http://x/todo";
              throw new HttpError(404);
            },
          },
          default: () => h("p", null),
        }),
    },
    assets: owningAssets,
    Shell: titledShell as never,
    ErrorPage: (ctx) => h("section", null, String(ctx.error?.status)),
    app: new App().use((ctx) => {
      ctx.head.links = [{ rel: "preconnect", href: "https://t.example" }];
      return ctx.next();
    }),
  });
  for (const path of ["/missing", "/todo"]) {
    const res = await get(handler, path);
    assertEquals([res.status, res.headers.get("cache-control")], [404, "no-store"]);
    assertEquals(
      await res.text(),
      '<!doctype html><html lang="fi"><head><title>Oops</title>' +
        '<meta name="robots" content="noindex, nofollow"/>' +
        // What the failed page said is gone; what the app set for every page stays.
        '<link rel="preconnect" href="https://t.example">' +
        '<link rel="stylesheet" href="/style.css"></head>' +
        '<body><section>404</section><script type="module" src="/boot.js"></script>' +
        "</body></html>",
      path,
    );
  }
});

Deno.test("an owning shell still gets the head fields the app set on the error path", async () => {
  // Only fu's own defaults are withheld. A value the error page (or the shell,
  // or a middleware on the way out) wrote is the app's, even when it is the
  // very string fu would have used.
  const plainShell = ownShell;
  for (
    const [set, want] of [
      [(c: Ctx) => (c.head.robots = "noindex"), '<meta name="robots" content="noindex">'],
      [
        (c: Ctx) => (c.head.title = "404 Not Found"),
        '<title>404 Not Found</title><meta property="og:title" content="404 Not Found">',
      ],
      [
        (c: Ctx) => (c.head.description = "D"),
        '<meta name="description" content="D"><meta property="og:description" content="D">',
      ],
      [() => {}, ""],
    ] as const
  ) {
    const handler = createHandler({
      manifest: {},
      assets: owningAssets,
      Shell: plainShell as never,
      ErrorPage: (ctx) => {
        set(ctx);
        return h("section", null, "e");
      },
    });
    const html = await (await get(handler, "/missing")).text();
    assertStringIncludes(html, `<head>${want}<link rel="stylesheet" href="/style.css"></head>`);
  }
});

Deno.test("on the error path: a head field from middleware is reset; copying the head onto itself adopts the defaults", async () => {
  const render = async (edit: (ctx: Ctx) => void) => {
    const handler = createHandler({
      manifest: {},
      assets: { js: [], css: [] },
      Shell: ownShell as never,
      ErrorPage: (ctx) => {
        edit(ctx);
        return h("i", null);
      },
      app: new App().use((ctx) => {
        ctx.head.description = "set before next()";
        ctx.head.links = [{ rel: "preconnect", href: "https://t.example" }];
        return ctx.next();
      }),
    });
    const html = await (await get(handler, "/missing")).text();
    return html.slice(html.indexOf("<head>") + 6, html.indexOf("</head>"));
  };
  // Only `links` (and `lang`) outlive the reset.
  assertEquals(await render(() => {}), '<link rel="preconnect" href="https://t.example">');
  // Assignment is what makes a field the app's, and this assigns them all.
  assertEquals(
    await render((ctx) => Object.assign(ctx.head, { ...ctx.head })),
    '<title>404 Not Found</title><meta name="robots" content="noindex">' +
      '<meta property="og:title" content="404 Not Found">' +
      '<link rel="preconnect" href="https://t.example">',
  );
});

Deno.test("fu's own document keeps its error title and robots, to the byte", async () => {
  const seen: unknown[] = [];
  const handler = createHandler({
    manifest: {},
    assets,
    ErrorPage: (ctx) => {
      // Readable while the error page renders, as they always were.
      seen.push(ctx.head.title, ctx.head.robots, Object.keys(ctx.head), { ...ctx.head });
      return h("section", null, "e");
    },
    app: new App().use((ctx) => {
      ctx.head.lang = "fi";
      return ctx.next();
    }),
  });
  assertEquals(
    await (await get(handler, "/missing")).text(),
    '<!doctype html><html lang="fi"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>404 Not Found</title><meta name="robots" content="noindex">' +
      '<meta property="og:title" content="404 Not Found">' +
      '<link rel="stylesheet" href="/style.css"></head><body><section>e</section>' +
      '<script type="module" src="/boot.js"></script></body></html>',
  );
  assertEquals(seen, [
    "404 Not Found",
    "noindex",
    ["title", "robots", "lang"],
    { title: "404 Not Found", robots: "noindex", lang: "fi" },
  ]);
});

Deno.test("in fu's own document an error page can still replace or remove the defaults", async () => {
  const render = async (edit: (ctx: Ctx) => void) => {
    const handler = createHandler({
      manifest: {},
      assets: { js: [], css: [] },
      ErrorPage: (ctx) => {
        edit(ctx);
        return h("i", null);
      },
    });
    const html = await (await get(handler, "/missing")).text();
    return html.slice(html.indexOf('initial-scale=1">') + 17, html.indexOf("</head>"));
  };
  assertEquals(
    await render((c) => {
      c.head.title = "Gone";
      c.head.robots = "noindex, nofollow";
    }),
    '<title>Gone</title><meta name="robots" content="noindex, nofollow">' +
      '<meta property="og:title" content="Gone">',
  );
  assertEquals(
    await render((c) => {
      delete c.head.title;
      c.head.robots = undefined;
    }),
    "",
  );
});

Deno.test("handler: a shell that renders <FuScripts/> twice is a 500 without the token", async () => {
  const twice = ({ children }: { children: unknown }) =>
    h(
      "html",
      null,
      h("head", null, h(FuHead, null)),
      h("body", null, children as never, h(FuScripts, null), h(FuScripts, null)),
    );
  const handler = createHandler({
    manifest: ownManifest,
    assets: owningAssets,
    Shell: twice as never,
    ErrorPage: (ctx) => h("section", null, String(ctx.error?.status)),
  });
  const origError = console.error;
  console.error = () => {};
  try {
    const res = await get(handler, "/");
    const body = await res.text();
    assertEquals(res.status, 500);
    assertEquals(body.includes(MARKER_TOKEN), false);
    assertEquals(body.includes("fu-marker"), false);
  } finally {
    console.error = origError;
  }
});

Deno.test("Partial renders comment markers around its children, in body and head alike", () => {
  const html = document(
    renderToString(
      h(Fragment, null, h(Partial, { name: "content" }, h("p", null, "x")), h("i", null)),
    ),
    {},
    assets,
  );
  assertStringIncludes(html, "<!--fu:p:content--><p>x</p><!--/fu:p--><i></i>");
  assertEquals(html.includes("fu-marker"), false);

  // This owned document has no FuHead/FuScripts markers, which warns; silence it.
  __resetWarningsForTest();
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const owned = document(
      `<html><head>${
        renderToString(h(Partial, { name: "head-dynamic" }, h("title", null, "T")))
      }</head><body></body></html>`,
      {},
      assets,
    );
    assertStringIncludes(
      owned,
      "<head><!--fu:p:head-dynamic--><title>T</title><!--/fu:p--></head>",
    );
  } finally {
    console.warn = origWarn;
    __resetWarningsForTest();
  }
});

Deno.test("a Partial survives a non-owning shell, where stray head/scripts markers are stripped", () => {
  __resetWarningsForTest();
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const html = document(
      renderToString(
        h(Fragment, null, h(FuHead, null), h(Partial, { name: "main" }, h("p", null, "m"))),
      ),
      {},
      assets,
    );
    assertStringIncludes(html, "<body><!--fu:p:main--><p>m</p><!--/fu:p-->");
    assertEquals(html.includes("fu-marker"), false);
    assertEquals(html.includes(MARKER_TOKEN), false);
  } finally {
    console.warn = origWarn;
    __resetWarningsForTest();
  }
});

Deno.test("the navigation protocol constants are the wire values", () => {
  assertEquals(
    [PARTIAL_PARAM, BUILD_PARAM, BUILD_RELOAD_HEADER, NAV_ATTR, BUILD_ATTR],
    ["fu-partial", "__b", "x-fu-reload", "data-fu-nav", "data-fu-build"],
  );
});

Deno.test("a Partial name that is not a plain token fails the render", async () => {
  const handler = createHandler({
    manifest: {
      "/routes/index.tsx": () =>
        Promise.resolve({ default: () => h(Partial, { name: "x--><b>" }, "y") }),
    },
    assets,
  });
  const origError = console.error;
  console.error = () => {};
  try {
    assertEquals((await get(handler, "/")).status, 500);
  } finally {
    console.error = origError;
  }
});

Deno.test("a Partial name is lower-case words joined by single hyphens", () => {
  for (const name of ["a", "content", "head-dynamic", "a1-2b", "x-y-z"]) {
    assertEquals(typeof Partial({ name }), "object", name);
  }
  for (const name of ["", "a-", "a--b", "-a", "A", "9a", "a_b", "a b", "a-B", "content "]) {
    assertThrows(() => Partial({ name }), Error, "must match", name);
  }
});

Deno.test("raw HTML is trusted: a region comment in it is served as written; a forged marker element is inert", async () => {
  const page = (html: string) =>
    createHandler({
      manifest: {
        "/routes/index.tsx": () =>
          Promise.resolve({
            default: () => h("div", { dangerouslySetInnerHTML: { __html: html } }),
          }),
      },
      assets,
    });
  // Not refused on the server: stored content must not become a lasting 500.
  // The client falls back to a full load when the regions it finds are unsound.
  for (const raw of ["<!--fu:p:content-->x<!--/fu:p-->", "<!--/fu:p-->"]) {
    const res = await get(page(raw), "/");
    assertEquals(res.status, 200, raw);
    assertStringIncludes(await res.text(), `<div>${raw}</div>`);
  }
  const forged =
    '<fu-marker data-fu="p" data-k="0000000000000000" data-name="content"></fu-marker>';
  const res = await get(page(forged), "/");
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, forged);
  assertEquals(html.includes("<!--fu:p:"), false);
});

Deno.test("ctx.partial is true only for the partial-navigation query parameter", async () => {
  const seen: boolean[] = [];
  const handler = createHandler({
    manifest: {
      "/routes/index.tsx": () =>
        Promise.resolve({
          handlers: {
            GET: (ctx: Ctx) => {
              seen.push(ctx.partial);
              return null;
            },
          },
          default: () => h("p", null),
        }),
    },
    assets,
  });
  await get(handler, "/");
  await get(handler, `/?${PARTIAL_PARAM}=1`);
  await get(handler, `/?${PARTIAL_PARAM}=true`);
  assertEquals(seen, [false, true, false]);
});

Deno.test("ctx.partial is readable inside a middleware, at any depth", async () => {
  // A build guard is middleware. Each level sees ctx through a forwarding
  // view, so a field missing from that view reads as undefined there.
  const seen: unknown[] = [];
  const app = new App()
    .use((ctx) => (seen.push(ctx.partial), ctx.next()))
    .use((ctx) => (seen.push(ctx.partial), ctx.next()));
  const handler = createHandler({
    manifest: { "/routes/index.tsx": () => Promise.resolve({ default: () => h("p", null) }) },
    assets,
    app,
  });
  await get(handler, `/?${PARTIAL_PARAM}=1`);
  await get(handler, "/");
  assertEquals(seen, [true, true, false, false]);
});

Deno.test("ctx.rawParams reaches a handler, a page, and a middleware on the way out", async () => {
  const seen: unknown[] = [];
  const app = new App().use(async (ctx) => {
    seen.push(ctx.rawParams);
    const res = await ctx.next();
    seen.push(ctx.rawParams);
    return res;
  });
  const handler = createHandler({
    manifest: {
      "/routes/s/[code].tsx": () =>
        Promise.resolve({
          handlers: { GET: (ctx: Ctx) => ctx.rawParams.code },
          default: (ctx: Ctx) =>
            h("p", { "data-p": ctx.params.code, "data-r": ctx.rawParams.code, "data-h": ctx.data }),
        }),
    },
    assets,
    app,
  });
  const res = await get(handler, "/s/a%20b%2Fc");
  assertEquals(res.status, 200);
  // Decoded, except the slash: decoding never makes a separator.
  assertStringIncludes(
    await res.text(),
    '<p data-p="a b%2Fc" data-r="a%20b%2Fc" data-h="a%20b%2Fc"></p>',
  );
  // Like params: empty until routing has run.
  assertEquals(seen, [{}, { code: "a%20b%2Fc" }]);

  // A malformed escape is the app's to answer, with the text as written.
  const bad = await get(handler, "/s/%E0%A4%A");
  assertEquals(bad.status, 200);
  assertStringIncludes(await bad.text(), '<p data-p="%E0%A4%A" data-r="%E0%A4%A"');
});

Deno.test("a request's dot segments, empty segments and trailing slash route as they did in 0.5.2", async () => {
  // Passed before the matcher was rewritten. The URL of a Request has its dot
  // segments resolved, encoded or not, before fu reads it.
  const page = (name: string) => () =>
    Promise.resolve({ default: (ctx: Ctx) => h("p", null, `${name}:${ctx.params.x ?? ""}`) });
  const handler = createHandler({
    manifest: {
      "/routes/about.tsx": page("about"),
      "/routes/blog/[x].tsx": page("blog"),
      "/routes/files/[...x].tsx": page("files"),
    },
    assets,
  });
  const got: Record<string, string> = {};
  for (
    const path of [
      "//",
      "/about/",
      "//about",
      "/blog/a/",
      "/blog//a",
      "/files/",
      "/files/a//b",
      "/x/../about",
      "/x/%2e%2e/about",
      "/blog/./a",
      "/files/a/../b",
      "/files/a/%2E%2e/b",
      "/files/a/./b",
      "/files/..",
    ]
  ) {
    const res = await get(handler, path);
    const html = await res.text();
    got[path] = res.status === 200 ? html.match(/<p>([^<]*)<\/p>/)![1] : String(res.status);
  }
  assertEquals(got, {
    "//": "404",
    "/about/": "404",
    "//about": "404",
    "/blog/a/": "404",
    "/blog//a": "404",
    "/files/": "404",
    "/files/a//b": "404",
    "/x/../about": "about:",
    "/x/%2e%2e/about": "about:",
    "/blog/./a": "blog:a",
    "/files/a/../b": "files:b",
    "/files/a/%2E%2e/b": "files:b",
    "/files/a/./b": "files:a/b",
    "/files/..": "404",
  });
});

Deno.test("what the runtime passes reaches every middleware and the page as env, waitUntil and assets", async () => {
  const waited: Promise<unknown>[] = [];
  const store = { fetch: () => Promise.resolve(new Response("file")) };
  const seen: unknown[] = [];
  const app = new App();
  app.use((ctx) => {
    seen.push(ctx.env.KEY, ctx.assets);
    ctx.waitUntil(Promise.resolve("outer"));
    return ctx.next();
  });
  app.use((ctx) => {
    seen.push(ctx.env.KEY, ctx.assets);
    return ctx.next();
  });
  const manifest: RouteManifest = {
    "/routes/index.tsx": () =>
      Promise.resolve({
        default: (ctx: Ctx) => {
          ctx.waitUntil(Promise.resolve("page"));
          return h("p", null, String(ctx.env.KEY));
        },
      }),
  };
  const handler = createHandler({ manifest, assets, app });
  const res = await handler(new Request("http://x/"), {
    env: { KEY: "value" },
    waitUntil: (p) => waited.push(p),
    assets: store,
  });
  assertStringIncludes(await res.text(), "<p>value</p>");
  assertEquals(seen, ["value", store, "value", store]);
  assertEquals(await Promise.all(waited), ["outer", "page"]);
});

Deno.test("without a runtime extra, env is empty, waitUntil does nothing and there is no asset store", async () => {
  let seen: [unknown, unknown] | undefined;
  const app = new App();
  app.use((ctx) => {
    seen = [ctx.env, ctx.assets];
    ctx.waitUntil(Promise.reject(new Error("dropped, and not unhandled")).catch(() => {}));
    return ctx.next();
  });
  const handler = createHandler({ manifest: {}, assets, app });
  assertEquals((await get(handler, "/")).status, 404);
  assertEquals(seen, [{}, null]);
});
