import {
  type ComponentChildren,
  type ComponentType,
  createContext,
  h,
  options,
  type VNode,
} from "preact";
import { useContext } from "preact/hooks";
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
 * Where a render is: below an island (`INSIDE`), where everything is part of
 * that island, or in a page, where the value collects the files of the islands
 * rendered so the document can preload their chunks. A context rather than a
 * module variable because renders are async and overlap.
 */
const INSIDE = Symbol("fu.inside");
const Scope = createContext<Set<string> | typeof INSIDE | null>(null);

/**
 * Intercept island components during render. Preact's `options.vnode` hook
 * fires for every vnode created, so an island is recognised from the stamp the
 * SSR transform left on the component itself — no separate registry.
 *
 * The wrapper forwards to a component that does NOT carry the stamp, so
 * rendering the island's own output does not re-enter this branch.
 *
 * An island rendered inside another gets no marker of its own. The client
 * hydrates the outer one whole, inner island included; a second marker would
 * be hydrated again, into a node the first hydration had already replaced.
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
        const Inner = unstamped(type);
        const file = key.split("#")[0];
        w = ((props: Record<string, unknown>) => {
          const scope = useContext(Scope);
          if (scope === INSIDE) return h(Inner, props as never);
          scope?.add(file);
          return h(
            Scope.Provider,
            { value: INSIDE },
            h("div", {
              "data-island": key,
              "data-props": serializeProps(key, props),
            }, h(Inner, props as never)),
          );
        }) as ComponentType<never>;
        wrapped.set(type, w);
      }
      vnode.type = w as never;
    }
    prev?.(vnode);
  };
}

/** The same component without the stamp. A class has to stay one: it cannot be called. */
function unstamped(type: ComponentType<never>): ComponentType<never> {
  const proto = (type as { prototype?: { render?: unknown } }).prototype;
  if (typeof proto?.render !== "function") {
    return ((props: never) => (type as (p: never) => unknown)(props)) as ComponentType<never>;
  }
  const Inner = class extends (type as new (...args: never[]) => object) {};
  // Statics are inherited, the stamp with them; shadow it.
  Object.defineProperty(Inner, ISLAND, { value: undefined });
  return Inner as unknown as ComponentType<never>;
}

/**
 * Island props as the JSON the client hydrates from. A function or a JSX
 * element cannot cross that boundary: JSON drops the one and turns the other
 * into an object Preact will not render, so the island would hydrate without
 * it and wipe what the server showed. Fail the render instead, naming the prop.
 */
function serializeProps(key: string, props: Record<string, unknown> | null): string {
  // Checked by a walk rather than a JSON.stringify replacer: the replacer is
  // called back for every key and made serialising a list three times slower.
  checkProps(key, "", props);
  return JSON.stringify(props ?? {});
}

function checkProps(key: string, name: string, v: unknown): void {
  if (v === null || typeof v !== "object") {
    if (typeof v === "function") refuseProp(key, name, "function");
    return;
  }
  const o = v as Record<string, unknown>;
  if (o.constructor === undefined && "type" in o && "props" in o) {
    refuseProp(key, name, "JSX element");
  }
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) checkProps(key, String(i), o[i]); }
  else if (typeof o.toJSON !== "function") { for (const k in o) checkProps(key, k, o[k]); }
}

function refuseProp(key: string, name: string, kind: string): never {
  throw new Error(
    `fu: island ${key} was passed a ${kind} in prop "${name}", but island props must be ` +
      `JSON. Render it inside the island, or pass the data it needs.`,
  );
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

/**
 * Dev only: answer requests addressed to one of `hosts` (or a `*.localhost`
 * name, which always resolves to loopback) and refuse the rest. Binding to
 * loopback keeps other machines out, but not a web page that points its own
 * domain at 127.0.0.1; the Host header is the one thing such a page cannot fake.
 */
export function onlyHosts(
  handler: (req: Request) => Promise<Response>,
  hosts: readonly string[],
): (req: Request) => Promise<Response> {
  const allowed = new Set(hosts);
  return (req) => {
    const host = new URL(req.url).hostname;
    if (allowed.has(host) || host.endsWith(".localhost")) return handler(req);
    return Promise.resolve(
      new Response(
        `fu dev: not serving "${host}". Start the dev server with --host ${host} to allow it.\n`,
        { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
      ),
    );
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
    // Not thrown: a miss is the commonest failure there is (every bot probe),
    // and building an Error just to catch it below costs microseconds each.
    if (!m) return renderError(ctx, { status: 404, message: statusText(404) }, parts);
    ctx.params = m.params;

    // Cached on the route: a dynamic import of a loaded module is cheap but
    // not free, and the manifest never changes within one server process.
    const mod = m.route.module ??= await m.route.load();
    const method = ctx.req.method;
    // HEAD borrows the GET handler unless it has its own; the body is dropped
    // on the way out.
    // Own properties only: a method token like `toString` must not find
    // Object.prototype's.
    const own = (name: string) =>
      mod.handlers && Object.hasOwn(mod.handlers, name) ? mod.handlers[name] : undefined;
    const fn = own(method) ?? (method === "HEAD" ? own("GET") : undefined);
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
    // Only reachable after a handler ran and returned data: answering 404 for
    // a request whose side effects went through would send the author looking
    // in the wrong place. A missing `return` in an API handler is the usual cause.
    if (!Page) {
      throw new Error(
        `fu: the ${method} handler for ${m.route.pattern} returned ${
          ctx.data === undefined ? "nothing" : "data"
        }, not a Response, and the route has no page to render`,
      );
    }
    return htmlResponse(await renderTree(ctx, h(Page as never, ctx as never), parts), ctx, parts);
  } catch (err) {
    return renderError(ctx, err, parts);
  }
}

/** A rendered body, and the island files that went into it. */
interface Rendered {
  body: string;
  islands: Set<string>;
}

/** Render the page, wrapped in `routes/_app.tsx` when the project has one. */
async function renderTree<S>(
  ctx: Ctx<S>,
  page: VNode,
  parts: HandlerParts<S>,
): Promise<Rendered> {
  const tree = parts.Shell ? h(parts.Shell as never, { ctx, children: page } as never) : page;
  const islands = new Set<string>();
  return { body: await renderToStringAsync(h(Scope.Provider, { value: islands }, tree)), islands };
}

function htmlResponse<S>(
  { body, islands }: Rendered,
  ctx: Ctx<S>,
  parts: HandlerParts<S>,
  status = 200,
): Response {
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
  // No failure may be cached: during a deploy a valid URL can 404 for a few
  // seconds, and a shared cache would pin that.
  if (status >= 400) headers["cache-control"] = "no-store";
  // `document` is called after rendering, so a component can still set ctx.head.
  return new Response(document(body, ctx.head, parts.assets, islands), { status, headers });
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
export function document(
  body: string,
  head: Head,
  assets: Assets,
  /** Files of the islands in `body`; their chunks are preloaded. */
  islands?: Iterable<string>,
): string {
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
  if (assets.islands && islands) {
    for (const file of islands) {
      const href = assets.islands[file];
      if (href) parts.push(tag("link", { rel: "modulepreload", href }));
    }
  }
  if (head.jsonLd !== undefined) {
    // `<` escaped so a string value cannot close the script element early.
    const json = JSON.stringify(head.jsonLd).replace(/</g, "\\u003c");
    parts.push(`<script type="application/ld+json">${json}</script>`);
  }
  return `<!doctype html><html lang="${esc(head.lang ?? "en")}"><head>${
    parts.join("")
  }</head><body>${body}${tags.body}</body></html>`;
}
