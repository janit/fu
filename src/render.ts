import { type ComponentType, h, options, type VNode } from "preact";
import { renderToStringAsync } from "preact-render-to-string";
import { buildRoutes, match, type Route } from "./router.ts";
import type { App } from "./app.ts";
import type { Assets, Ctx, Head, RouteManifest } from "./types.ts";
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
        const Inner = ((props: never) =>
          (type as (p: never) => unknown)(props)) as ComponentType<never>;
        w = ((props: Record<string, unknown>) =>
          h("div", {
            "data-island": key,
            "data-props": JSON.stringify(props ?? {}),
          }, h(Inner as never, props as never))) as ComponentType<never>;
        wrapped.set(type, w);
      }
      vnode.type = w as never;
    }
    prev?.(vnode);
  };
}

/** Optional root wrapper (`routes/_app.tsx`) around every page. */
export interface ShellProps<S = Record<string, unknown>> {
  ctx: Ctx<S>;
  children: unknown;
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
  /** Initial state for each request. Shallow-copied per request. */
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
  const terminal = (ctx: Ctx<S>) => renderRoute(ctx, routes, parts);
  const run = parts.app ? parts.app.compose(terminal) : composeBare(terminal);

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
    return run(ctx).catch((err) => renderError(ctx, err, parts));
  };
}

function composeBare<S>(
  terminal: (ctx: Ctx<S>) => Response | Promise<Response>,
): (ctx: Ctx<S>) => Promise<Response> {
  return (ctx) => Promise.resolve(terminal(ctx));
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

    const mod = await m.route.load();
    if (mod.handlers) {
      const fn = mod.handlers[ctx.req.method];
      if (!fn) throw new HttpError(405);
      const result = await fn(ctx);
      if (result instanceof Response) return result;
      ctx.data = result;
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
  const tree = parts.Shell
    ? h(parts.Shell as never, { ctx, children: page } as never)
    : page;
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
 * text. Either way it goes back out through the middleware chain as a normal
 * response, so security headers and logging still apply.
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
      ctx.head.title ??= `${error.status} ${statusText(error.status)}`;
      ctx.head.robots ??= "noindex";
      const body = await renderTree(ctx, h(parts.ErrorPage as never, ctx as never), parts);
      return htmlResponse(body, ctx, parts, error.status);
    } catch (pageErr) {
      // An error page that throws must not mask the original failure.
      console.error("[fu] the error page itself threw", pageErr);
    }
  }
  return new Response(`${error.status} ${error.message}`, {
    status: error.status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => escapes[c]);
}

function tag(name: string, attrs: Record<string, string>): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  return `<${name}${a}>`;
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
  for (const a of assets.css ?? []) parts.push(tag("link", { rel: "stylesheet", href: a.href }));
  if (head.jsonLd !== undefined) {
    // `<` escaped so a string value cannot close the script element early.
    const json = JSON.stringify(head.jsonLd).replace(/</g, "\\u003c");
    parts.push(`<script type="application/ld+json">${json}</script>`);
  }
  const js = (assets.js ?? [])
    .map((a) => tag("script", { type: "module", src: a.href }) + "</script>")
    .join("");
  return `<!doctype html><html lang="${esc(head.lang ?? "en")}"><head>${
    parts.join("")
  }</head><body>${body}${js}</body></html>`;
}
