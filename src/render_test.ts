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
      h("div", { id: "shell" }, h("span", null, (ctx.state as { tenant: string }).tenant), children),
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
    manifest: { "/routes/index.tsx": () => Promise.resolve({ default: () => h(Island, { n: 7 }) }) },
    assets,
  });
  const html = await (await get(handler, "/")).text();
  assertStringIncludes(html, 'data-island="/islands/X.tsx"');
  assertStringIncludes(html, "&quot;n&quot;:7");
  assertStringIncludes(html, "<b>7</b>");
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
  for (const [path, method, status, body] of [
    ["/nothing", "GET", 404, "404: Not Found"],
    ["/api", "GET", 405, "405: Method Not Allowed"],
    ["/forbidden", "GET", 403, "403: Not yours"],
    ["/boom", "GET", 500, "500: Internal Server Error"],
  ] as const) {
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
