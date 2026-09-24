import { type ComponentChildren, type ComponentType, h, options, type VNode } from "preact";
import { renderToStringAsync } from "preact-render-to-string";
import { buildRoutes, match, type Route } from "./router.ts";
import { type App, compose } from "./app.ts";
import type { Assets, Ctx, Head, RouteError, RouteManifest, RouteModule } from "./types.ts";
import { HttpError, statusText, toRouteError } from "./errors.ts";

/** Property the SSR transform stamps onto island exports. */
const ISLAND = "__island";

const wrapped = new WeakMap<ComponentType<never>, ComponentType<never>>();
let hookInstalled = false;

/**
 * Intercept island components during render. Preact's `options.vnode` hook
 * fires for every vnode created, so an island is recognised from the stamp the
 * SSR transform left on the component itself — no separate registry.
 *
 * The wrapper forwards to an arrow that does NOT carry the stamp, so rendering
 * the island's own output does not re-enter this branch.
 */
function installIslandHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  const prev = options.vnode;
  options.vnode = (vnode: VNode<Record<string, unknown>>) => {
    const type = vnode.type as ComponentType<never> & { [ISLAND]?: string };
    if (typeof type === "function" && type[ISLAND]) {
      let w = wrapped.get(type);
      if (!w) {
        const key = type[ISLAND];
        const Inner = ((props: never) => (type as (p: never) => unknown)(props)) as ComponentType<
          never
        >;
        w = ((props: Record<string, unknown>) =>
          h("div", {
            "data-island": key,
            "data-props": serializeProps(key, props),
          }, h(Inner as never, props as never))) as ComponentType<never>;
        wrapped.set(type, w);
      }
      vnode.type = w as never;
    }
    prev?.(vnode);
  };
}

/**
 * Island props as the JSON the client hydrates from. A function or a JSX
 * element cannot cross that boundary: JSON drops the one and turns the other
 * into an object Preact will not render, so the island would hydrate without
 * it and wipe what the server showed. Fail the render instead, naming the prop.
 */
function serializeProps(key: string, props: Record<string, unknown> | null): string {
  return JSON.stringify(props ?? {}, (k, v) => {
    const kind = typeof v === "function"
      ? "function"
      : v && typeof v === "object" && v.constructor === undefined && "type" in v && "props" in v
      ? "JSX element"
      : null;
    if (kind) {
      throw new Error(
        `fu: island ${key} was passed a ${kind} in prop "${k}", but island props must be ` +
          `JSON. Render it inside the island, or pass the data it needs.`,
      );
    }
    return v;
  });
}

/** Optional root wrapper (`routes/_app.tsx`) around every page. */
export interface ShellProps<S = Record<string, unknown>> {
  ctx: Ctx<S>;
  children: ComponentChildren;
}

export interface HandlerParts<S> {
  manifest: RouteManifest<S>;
  assets: Assets;
  /** Middleware chain. Omit for no middleware. */
  app?: App<S>;
  /** `routes/_app.tsx` default export, if the project has one. */
  Shell?: ComponentType<ShellProps<S>>;
  /**
   * `routes/_error.tsx` default export, if the project has one. It receives
   * `ctx` exactly like a page component, with `ctx.error` set.
   */
  ErrorPage?: (ctx: Ctx<S>) => unknown;
  /** Initial state for each request, called once per request. */
  initialState?: () => S;
}

/**
 * Build the request handler: middleware chain wrapped around routing + render.
 *
 * Middleware runs before routing so it can answer a request no route matches.
 */
export function createHandler<S = Record<string, unknown>>(
  parts: HandlerParts<S>,
): (req: Request) => Promise<Response> {
  installIslandHook();
  const routes = buildRoutes(parts.manifest);
  const run = compose(parts.app?.middleware ?? [], (ctx) => renderRoute(ctx, routes, parts));

  return (req: Request): Promise<Response> => {
    const ctx: Ctx<S> = {
      req,
      url: new URL(req.url),
      params: {},
      state: (parts.initialState?.() ?? {}) as S,
      head: {},
      next: () => Promise.reject(new Error("fu: next() outside the chain")),
    };
    // Middleware runs outside renderRoute's try, so a throw up there would
    // otherwise escape to the server as an unhandled 500.
    const res = run(ctx).catch((err) => renderError(ctx, err, parts));
    // HEAD is answered like GET, down to the headers, minus the body — error
    // responses included. Stripped here, outermost, so middleware sees the
    // same response either way.
    return req.method === "HEAD" ? res.then(withoutBody) : res;
  };
}

function withoutBody(res: Response): Response {
  res.body?.cancel();
  return new Response(null, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** Methods a route answers: its handlers, GET when it has a page, HEAD with GET, OPTIONS always. */
function allowed(mod: RouteModule<never>): string {
  const methods = new Set(Object.keys(mod.handlers ?? {}));
  if (mod.default) methods.add("GET");
  if (methods.has("GET")) methods.add("HEAD");
  methods.add("OPTIONS");
  return [...methods].join(", ");
}

async function renderRoute<S>(
  ctx: Ctx<S>,
  routes: Route<S>[],
  parts: HandlerParts<S>,
): Promise<Response> {
  try {
    const m = match(routes, ctx.url.pathname);
    if (!m) throw new HttpError(404);
    ctx.params = m.params;

    // Cached on the route: a dynamic import of a loaded module is cheap but
    // not free, and the manifest never changes within one server process.
    const mod = m.route.module ??= await m.route.load();
    const method = ctx.req.method;
    // HEAD borrows the GET handler unless it has its own; the body is dropped
    // on the way out.
    const fn = mod.handlers?.[method] ?? (method === "HEAD" ? mod.handlers?.GET : undefined);
    if (fn) {
      const result = await fn(ctx);
      if (result instanceof Response) return result;
      ctx.data = result;
    } else if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { allow: allowed(mod) } });
    } else if (method !== "GET" && method !== "HEAD" || !mod.default) {
      // A page renders for GET and HEAD without a handler; anything else needs one.
      const status = mod.handlers || mod.default ? 405 : 404;
      throw new HttpError(
        status,
        undefined,
        status === 405 ? { headers: { allow: allowed(mod) } } : undefined,
      );
    }

    const Page = mod.default;
    if (!Page) throw new HttpError(404);
    return htmlResponse(await renderTree(ctx, h(Page as never, ctx as never), parts), ctx, parts);
  } catch (err) {
    return renderError(ctx, err, parts);
  }
}

/** Render the page, wrapped in `routes/_app.tsx` when the project has one. */
async function renderTree<S>(
  ctx: Ctx<S>,
  page: VNode,
  parts: HandlerParts<S>,
): Promise<string> {
  const tree = parts.Shell ? h(parts.Shell as never, { ctx, children: page } as never) : page;
  return await renderToStringAsync(tree);
}

function htmlResponse<S>(
  body: string,
  ctx: Ctx<S>,
  parts: HandlerParts<S>,
  status = 200,
): Response {
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
  // No failure may be cached: during a deploy a valid URL can 404 for a few
  // seconds, and a shared cache would pin that.
  if (status >= 400) headers["cache-control"] = "no-store";
  // `document` is called after rendering, so a component can still set ctx.head.
  return new Response(document(body, ctx.head, parts.assets), { status, headers });
}

/**
 * Turn a failure into a response. Rendered through `routes/_error.tsx` when the
 * project has one, so it inherits the app's markup and styling; otherwise plain
 * text.
 *
 * For a handler or page failure this runs at the route boundary, so the
 * response goes back out through the middleware chain and security headers and
 * logging still apply. For a middleware throw it runs only after the whole
 * chain has unwound — the throw propagates past every `await ctx.next()` so an
 * outer middleware can catch it — and nothing decorates the response.
 */
export async function renderError<S>(
  ctx: Ctx<S>,
  err: unknown,
  parts: HandlerParts<S>,
): Promise<Response> {
  const error = toRouteError(err);
  ctx.error = error;
  // The underlying cause is logged, never rendered: a 500's message can carry
  // connection strings, file paths and query text.
  if (error.status >= 500) console.error(`[fu] ${ctx.url.pathname}`, error.cause ?? err);

  if (parts.ErrorPage) {
    try {
      resetHead(ctx.head, `${error.status} ${statusText(error.status)}`);
      const body = await renderTree(ctx, h(parts.ErrorPage as never, ctx as never), parts);
      return withErrorHeaders(htmlResponse(body, ctx, parts, error.status), error);
    } catch (pageErr) {
      // An error page that throws must not mask the original failure.
      console.error("[fu] the error page itself threw", pageErr);
    }
  }
  return withErrorHeaders(
    new Response(`${error.status} ${error.message}`, {
      status: error.status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    }),
    error,
  );
}

/**
 * Clear what the failed page said about itself before the error page renders:
 * its title, canonical and JSON-LD would otherwise describe a page that does
 * not exist, and a middleware's `robots: "index"` would let a 404 be indexed.
 * `lang` and `links` are app-wide (a tenant's language, font preloads), so they
 * stay. Cleared in place, because middleware holds the same object.
 */
function resetHead(head: Head, title: string): void {
  const { lang, links } = head;
  for (const k of Object.keys(head)) delete head[k as keyof Head];
  Object.assign(head, { title, robots: "noindex" }, lang && { lang }, links && { links });
}

function withErrorHeaders(res: Response, error: RouteError): Response {
  error.headers?.forEach((v, k) => res.headers.set(k, v));
  return res;
}

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
const NEEDS_ESCAPE = /[&<>"]/;
function esc(s: string): string {
  // Most values have nothing to escape; testing first skips the replace
  // callback, which the profile showed on every attribute of every request.
  return NEEDS_ESCAPE.test(s) ? s.replace(/[&<>"]/g, (c) => escapes[c]) : s;
}

function tag(name: string, attrs: Record<string, string>): string {
  let out = `<${name}`;
  for (const k in attrs) out += ` ${k}="${esc(attrs[k])}"`;
  return out + ">";
}

/**
 * The asset tags depend only on the asset list, which is fixed for the life of
 * a server, so they are built once per list rather than on every request.
 */
const assetTags = new WeakMap<Assets, { head: string; body: string }>();
function tagsFor(assets: Assets): { head: string; body: string } {
  let tags = assetTags.get(assets);
  if (!tags) {
    tags = {
      head: assets.css.map((a) => tag("link", { rel: "stylesheet", href: a.href })).join("") +
        (assets.preload ?? []).map((a) => tag("link", { rel: "modulepreload", href: a.href }))
          .join(""),
      body: assets.js.map((a) => tag("script", { type: "module", src: a.href }) + "</script>")
        .join(""),
    };
    assetTags.set(assets, tags);
  }
  return tags;
}

/** Assemble the HTML document from the page body, head metadata and assets. */
export function document(body: string, head: Head, assets: Assets): string {
  const parts: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
  ];
  if (head.title) parts.push(`<title>${esc(head.title)}</title>`);
  if (head.description) {
    parts.push(tag("meta", { name: "description", content: head.description }));
  }
  if (head.robots) parts.push(tag("meta", { name: "robots", content: head.robots }));
  if (head.canonical) parts.push(tag("link", { rel: "canonical", href: head.canonical }));
  if (head.title) parts.push(tag("meta", { property: "og:title", content: head.title }));
  if (head.description) {
    parts.push(tag("meta", { property: "og:description", content: head.description }));
  }
  if (head.image) parts.push(tag("meta", { property: "og:image", content: head.image }));
  for (const link of head.links ?? []) parts.push(tag("link", link));
  const tags = tagsFor(assets);
  parts.push(tags.head);
  if (head.jsonLd !== undefined) {
    // `<` escaped so a string value cannot close the script element early.
    const json = JSON.stringify(head.jsonLd).replace(/</g, "\\u003c");
    parts.push(`<script type="application/ld+json">${json}</script>`);
  }
  return `<!doctype html><html lang="${esc(head.lang ?? "en")}"><head>${
    parts.join("")
  }</head><body>${body}${tags.body}</body></html>`;
}
