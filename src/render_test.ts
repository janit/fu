import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "preact";
import { createHandler, document } from "./render.ts";
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

Deno.test("a route with handlers but no component is not renderable", async () => {
  // The handler returned data rather than a Response, and there is no default
  // export to render it with.
  assertEquals((await get(createHandler({ manifest, assets }), "/nopage")).status, 404);
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
