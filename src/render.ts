import {
  type ComponentChildren,
  type ComponentType,
  createContext,
  Fragment,
  h,
  options,
  type RenderableProps,
  type VNode,
} from "preact";
import { useContext } from "preact/hooks";
import { renderToStringAsync } from "preact-render-to-string";
import { buildRoutes, match, type Route } from "./router.ts";
import { type App, compose } from "./app.ts";
import type {
  Assets,
  Ctx,
  Head,
  RequestExtra,
  RouteError,
  RouteManifest,
  RouteModule,
} from "./types.ts";
import { HttpError, statusText, toRouteError } from "./errors.ts";
import { PARTIAL_PARAM, REGION_NAME } from "./nav-protocol.ts";

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
    if (typeof type !== "function") return prev?.(vnode);
    if (type.constructor === AsyncFunction) {
      // Inside the tree nobody can await it, and the renderer drops a promise
      // without a word. The page, error page and shell never get here: fu
      // calls those itself (see `top`).
      vnode.type = refusedAsync(type) as never;
    } else if (type[ISLAND]) {
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

const AsyncFunction = (async () => {}).constructor;

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return v !== null && typeof v === "object" &&
    typeof (v as { then?: unknown }).then === "function";
}

function nameOf(type: unknown): string {
  const t = type as { displayName?: string; name?: string };
  return t.displayName || t.name || "anonymous";
}

const refused = new WeakMap<object, ComponentType<never>>();
/** Stands in for an async component met inside the tree: rendering it fails, naming it. */
function refusedAsync(type: ComponentType<never>): ComponentType<never> {
  let r = refused.get(type);
  if (!r) {
    r = (() => {
      throw new Error(
        `fu: async component <${nameOf(type)}> was rendered inside the tree, where nothing can ` +
          `await it. Only the page, routes/_error and routes/_app may be async; fetch what ` +
          `<${nameOf(type)}> needs in one of those, or in a handler, and pass it down.`,
      );
    }) as ComponentType<never>;
    refused.set(type, r);
  }
  return r;
}

const guarded = new WeakMap<object, ComponentType<never>>();
/**
 * A synchronous top-level component, with its result checked: a promise there
 * (a function that returns one without being declared `async`) cannot be
 * awaited, because the component runs inside the renderer, and would be
 * dropped. The guard takes the component's place rather than wrapping it, so
 * the tree, and with it the markup and the hooks, is what it was.
 */
function guard(type: ComponentType<never>, what: string): ComponentType<never> {
  const t = type as ComponentType<never> & { [ISLAND]?: string; contextType?: unknown };
  // An island is swapped by the vnode hook, and there fails on its props:
  // those of a top-level component are the request context, never JSON.
  if (t[ISLAND]) return type;
  let g = guarded.get(type);
  if (!g) {
    const checked = (out: unknown): unknown => {
      if (isThenable(out)) {
        // Not left dangling: its rejection would be an unhandled one.
        Promise.resolve(out).catch(() => {});
        throw new Error(
          `fu: ${what} (${nameOf(type)}) returned a promise, which cannot be rendered. ` +
            (isClass(type)
              ? `A class cannot be awaited: make it an \`async\` function instead.`
              : `Declare it \`async\` and fu awaits it before rendering.`),
        );
      }
      return out;
    };
    if (isClass(type)) {
      // A class cannot be called, but it can be extended: the same check, on
      // what render() returns. Statics, contextType among them, are inherited.
      const Base = type as unknown as new (...args: never[]) => { render(...a: never[]): unknown };
      g = class extends Base {
        override render(...args: never[]): unknown {
          return checked(super.render(...args));
        }
      } as unknown as ComponentType<never>;
    } else {
      const fn = type as unknown as (this: unknown, props: unknown, context: unknown) => unknown;
      g = function (this: unknown, props: unknown, context: unknown): unknown {
        return checked(fn.call(this, props, context));
      } as unknown as ComponentType<never>;
      if (t.contextType) (g as { contextType?: unknown }).contextType = t.contextType;
    }
    guarded.set(type, g);
  }
  return g;
}

function isClass(type: unknown): boolean {
  return typeof (type as { prototype?: { render?: unknown } }).prototype?.render === "function";
}

/**
 * A top-level component (the page, the error page, the shell) as something to
 * render. An async one is called here, outside the renderer, and awaited: it
 * cannot use hooks, and whatever it writes on `ctx` is there before anything
 * after it runs. A synchronous one becomes a vnode, rendered in the tree.
 */
function top(
  type: ComponentType<never>,
  props: unknown,
  what: string,
): ComponentChildren | Promise<ComponentChildren> {
  if (type.constructor === AsyncFunction) {
    // Called here it would be served with no hydration marker, and never
    // meet the check that an island's props are JSON, which these are not.
    if ((type as { [ISLAND]?: string })[ISLAND]) {
      throw new Error(
        `fu: ${what} (${nameOf(type)}) is an island, and an island cannot be async or ` +
          `take the request context as its props. Render the island inside it instead.`,
      );
    }
    return (type as unknown as (props: unknown) => Promise<ComponentChildren>)(props);
  }
  return h(guard(type, what), props as never);
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

/**
 * Per-process random token on every marker element fu renders. Text rendered
 * through Preact is escaped, so only raw HTML (`dangerouslySetInnerHTML`)
 * could contain a marker-shaped string, and raw HTML cannot know the token:
 * replacing the first occurrence of a token-bearing marker is therefore safe.
 * Exported for tests only.
 */
export const MARKER_TOKEN: string = Array.from(
  crypto.getRandomValues(new Uint8Array(8)),
  (b) => b.toString(16).padStart(2, "0"),
).join("");

/**
 * Placed by a shell that renders `<html>` itself, where fu's head tags go:
 * the `ctx.head` fields that were set, the stylesheet links, the
 * `modulepreload`s of what the boot module imports and of the islands this
 * page rendered (each with the chunks it imports), and the JSON-LD block.
 * `document()` replaces the marker element after rendering.
 */
export function FuHead(): VNode {
  return h("fu-marker", { "data-fu": "head", "data-k": MARKER_TOKEN }) as VNode;
}

/** Placed by a document-owning shell where the boot `<script>` tags go. */
export function FuScripts(): VNode {
  return h("fu-marker", { "data-fu": "scripts", "data-k": MARKER_TOKEN }) as VNode;
}

const PARTIAL_NAME = new RegExp(`^${REGION_NAME}$`);

/**
 * A region the client navigation runtime swaps on navigation, delimited by
 * comments so it can sit in `<head>` as well as in the body. The name is a
 * token, never user data: anything else fails the render.
 *
 * Raw HTML rendered with `dangerouslySetInnerHTML` is trusted. A region
 * comment inside it is indistinguishable from a real one and is served as
 * written; the client falls back to a full page load when the regions it
 * finds are duplicated, nested or unbalanced.
 */
export function Partial(props: { name: string; children?: ComponentChildren }): VNode {
  if (!PARTIAL_NAME.test(props.name)) {
    throw new Error(`fu: Partial name "${props.name}" must match ${PARTIAL_NAME}`);
  }
  return h(
    Fragment,
    null,
    h("fu-marker", { "data-fu": "p", "data-k": MARKER_TOKEN, "data-name": props.name }) as VNode,
    props.children,
    h("fu-marker", { "data-fu": "/p", "data-k": MARKER_TOKEN }) as VNode,
  );
}

const PARTIAL_OPEN = new RegExp(
  `<fu-marker data-fu="p" data-k="${MARKER_TOKEN}" data-name="(${REGION_NAME})"></fu-marker>`,
  "g",
);
const PARTIAL_CLOSE = `<fu-marker data-fu="/p" data-k="${MARKER_TOKEN}"></fu-marker>`;

/**
 * Marker elements to the comments the client runtime looks for. Only
 * token-bearing markers are rewritten, so a marker element in raw HTML stays
 * the inert element it is.
 */
function partialComments(html: string): string {
  if (!html.includes("<fu-marker data-fu=")) return html;
  return html.replace(PARTIAL_OPEN, "<!--fu:p:$1-->").replaceAll(PARTIAL_CLOSE, "<!--/fu:p-->");
}

/** The exact string `FuHead` renders to and `document()` replaces. */
export function headMarker(): string {
  return `<fu-marker data-fu="head" data-k="${MARKER_TOKEN}"></fu-marker>`;
}

/** The exact string `FuScripts` renders to and `document()` replaces. */
export function scriptsMarker(): string {
  return `<fu-marker data-fu="scripts" data-k="${MARKER_TOKEN}"></fu-marker>`;
}

/** Every token-bearing marker element, of either kind. A fresh regex: it is global. */
function strayMarkers(): RegExp {
  return new RegExp(
    `<fu-marker data-fu="(?:head|scripts)" data-k="${MARKER_TOKEN}"></fu-marker>`,
    "g",
  );
}

/**
 * Replace the one marker, or fail: two means the shell placed the component
 * twice. Returns null when the marker is absent.
 */
function replaceMarker(html: string, marker: string, name: string, tags: string): string | null {
  const at = html.indexOf(marker);
  if (at === -1) return null;
  if (html.indexOf(marker, at + marker.length) !== -1) {
    throw new Error(`fu: the shell renders <${name}/> more than once`);
  }
  return html.slice(0, at) + tags + html.slice(at + marker.length);
}

// Sticky, so each is tried at one position only and the scan never backs up.
const SPACE = /\s*/y;
const DOCTYPE = /<!doctype\s+html(?:\s[^>]*)?>/iy;
const HTML_TAG = /<html[\s>]/iy;

/**
 * Whether the shell rendered the whole document: nothing but whitespace,
 * comments and at most one doctype (any `<!doctype html ...>`, such as the
 * legacy compat one) before `<html`. Returns the comments, which are kept,
 * and where `<html` starts; null when the body is not a document.
 *
 * A scanner, not one regex: each comment ends at its first `-->`, found by
 * `indexOf`, so the work is linear in the length of the prologue. A regex
 * with a lazy comment body backtracked exponentially here, and let a comment
 * "end" at a later `-->`, swallowing content between two comments.
 */
function ownedDocument(body: string): { comments: string; at: number } | null {
  let at = 0;
  let comments = "";
  let doctype = false;
  for (;;) {
    SPACE.lastIndex = at;
    SPACE.test(body);
    at = SPACE.lastIndex;
    if (body.startsWith("<!--", at)) {
      const end = body.indexOf("-->", at + 4);
      if (end === -1) return null;
      comments += body.slice(at, end + 3);
      at = end + 3;
      continue;
    }
    DOCTYPE.lastIndex = at;
    if (!doctype && DOCTYPE.test(body)) {
      doctype = true;
      at = DOCTYPE.lastIndex;
      continue;
    }
    HTML_TAG.lastIndex = at;
    return HTML_TAG.test(body) ? { comments, at } : null;
  }
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * Forget which warnings were issued. For tests only.
 * @internal
 */
export function __resetWarningsForTest(): void {
  warned.clear();
}

export interface HandlerParts<S> {
  manifest: RouteManifest<S>;
  assets: Assets;
  /** Middleware chain. Omit for no middleware. */
  app?: App<S>;
  /**
   * `routes/_app.tsx` default export, if the project has one. May be an async
   * function, which fu awaits (after the page) instead of rendering.
   */
  Shell?:
    | ComponentType<ShellProps<S>>
    // The parameters of Preact's FunctionComponent, to the letter: with any
    // other list an inline `({ ctx, children }) => ...` loses its types.
    // deno-lint-ignore no-explicit-any
    | ((props: RenderableProps<ShellProps<S>>, context?: any) => Promise<ComponentChildren>);
  /**
   * `routes/_error.tsx` default export, if the project has one. It receives
   * `ctx` exactly like a page component, with `ctx.error` set, and like a page
   * it may be an async function.
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
): (req: Request, extra?: RequestExtra) => Promise<Response> {
  installIslandHook();
  const routes = buildRoutes(parts.manifest);
  const run = compose(parts.app?.middleware ?? [], (ctx) => renderRoute(ctx, routes, parts));

  return (req: Request, extra: RequestExtra = {}): Promise<Response> => {
    const url = new URL(req.url);
    const ctx: Ctx<S> = {
      req,
      url,
      params: {},
      rawParams: {},
      state: (parts.initialState?.() ?? {}) as S,
      head: {},
      response: { status: 200, headers: new Headers() },
      partial: url.searchParams.get(PARTIAL_PARAM) === "1",
      env: extra.env ?? {},
      waitUntil: extra.waitUntil ?? ignore,
      assets: extra.assets ?? null,
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
  handler: (req: Request, extra?: RequestExtra) => Promise<Response>,
  hosts: readonly string[],
): (req: Request, extra?: RequestExtra) => Promise<Response> {
  const allowed = new Set(hosts);
  return (req, extra) => {
    const host = new URL(req.url).hostname;
    if (allowed.has(host) || host.endsWith(".localhost")) return handler(req, extra);
    return Promise.resolve(
      new Response(
        `fu dev: not serving "${host}". Start the dev server with --host ${host} to allow it.\n`,
        { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
      ),
    );
  };
}

/** `waitUntil` when the runtime gave none: the work runs, nothing waits for it. */
function ignore(): void {}

function withoutBody(res: Response): Response {
  // Not awaited, and a failed cancel is nobody's business: unhandled, it
  // would end a Node process.
  res.body?.cancel().catch(() => {});
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
    ctx.rawParams = m.rawParams;

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
    const page = top(Page as never, ctx, `the page component of ${m.route.file}`);
    return htmlResponse(await renderTree(ctx, page, parts), ctx, parts);
  } catch (err) {
    return renderError(ctx, err, parts);
  }
}

/** A rendered body, and the island files that went into it. */
interface Rendered {
  body: string;
  islands: Set<string>;
}

/**
 * Render the page, wrapped in `routes/_app.tsx` when the project has one. An
 * async page has settled before the shell is so much as called, so the shell
 * reads what the page left on `ctx.state`.
 */
async function renderTree<S>(
  ctx: Ctx<S>,
  page: ComponentChildren | Promise<ComponentChildren>,
  parts: HandlerParts<S>,
): Promise<Rendered> {
  // Awaited only when there is something to wait for: a synchronous page
  // costs no extra turn of the event loop.
  const children = (isThenable(page) ? await page : page) as ComponentChildren;
  let tree = children;
  if (parts.Shell) {
    const shell = top(parts.Shell as never, { ctx, children }, "the shell, routes/_app");
    tree = (isThenable(shell) ? await shell : shell) as ComponentChildren;
  }
  const islands = new Set<string>();
  return { body: await renderToStringAsync(h(Scope.Provider, { value: islands }, tree)), islands };
}

function htmlResponse<S>(
  { body, islands }: Rendered,
  ctx: Ctx<S>,
  parts: HandlerParts<S>,
  /** The error status, or undefined on the page path, where `ctx.response` decides. */
  errorStatus?: number,
): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  let status: number;
  if (errorStatus === undefined) {
    status = ctx.response.status;
    if (
      !Number.isInteger(status) || status < 200 || status > 599 || status === 204 ||
      status === 205 || status === 304
    ) {
      throw new RangeError(
        `fu: ctx.response.status must be 200 to 599 and not 204, 205 or 304, got ${status}`,
      );
    }
    // forEach yields each set-cookie separately; append keeps them all.
    ctx.response.headers.forEach((v, k) => {
      if (k === "set-cookie") headers.append(k, v);
      else headers.set(k, v);
    });
  } else {
    status = errorStatus;
  }
  // No failure may be cached: during a deploy a valid URL can 404 for a few
  // seconds, and a shared cache would pin that.
  if (status >= 400) headers.set("cache-control", "no-store");
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
      const page = top(parts.ErrorPage as never, ctx, "the error page, routes/_error");
      const body = await renderTree(ctx, page, parts);
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
  errorDefault(head, "title", title);
  errorDefault(head, "robots", "noindex");
  Object.assign(head, lang && { lang }, links && { links });
}

/** The getters of the error defaults that nothing has replaced yet. */
const errorDefaults = new WeakSet<() => string>();
/** Heads that went through `resetHead`: the only ones worth inspecting. */
const errorHeads = new WeakSet<Head>();

/**
 * Give an error head a default that reads, lists, copies and deletes like the
 * plain value it used to be, but can be told apart from a value the app set:
 * assigning to the field makes it an ordinary property again. That is what
 * lets a document-owning shell be spared fu's defaults (see `ownedHead`)
 * without losing a title or robots value the app wrote there itself, even one
 * equal to the default.
 */
function errorDefault(head: Head, key: "title" | "robots", value: string): void {
  const get = (): string => value;
  errorDefaults.add(get);
  errorHeads.add(head);
  Object.defineProperty(head, key, {
    get,
    set(v: string | undefined) {
      Object.defineProperty(head, key, {
        value: v,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
    enumerable: true,
    configurable: true,
  });
}

/**
 * The head a document-owning shell gets: everything the app set, and none of
 * fu's error defaults. Such a shell writes its own `<title>` and robots tag,
 * and fu's beside them were duplicates.
 */
function ownedHead(head: Head): Head {
  if (!errorHeads.has(head)) return head;
  const out = { ...head };
  for (const key of ["title", "robots"] as const) {
    const get = Object.getOwnPropertyDescriptor(head, key)?.get;
    if (get && errorDefaults.has(get)) delete out[key];
  }
  return out;
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

/** The `ctx.head` tags, in the order the wrapped document has always used. */
function headTags(head: Head): string {
  const parts: string[] = [];
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
  return parts.join("");
}

/** Preloads of the islands a page rendered, and only those. */
function islandPreloads(assets: Assets, islands?: Iterable<string>): string {
  if (!assets.islands || !islands) return "";
  // The chunks the islands import first, then the islands' own: the order the
  // page-wide list of shared chunks and the island chunks always had.
  let imported = "";
  let own = "";
  // Only a list can repeat a chunk (two islands that import the same one).
  let seen: Set<string> | undefined;
  for (const file of islands) {
    const hrefs = assets.islands[file];
    if (!hrefs) continue;
    if (typeof hrefs === "string") {
      own += tag("link", { rel: "modulepreload", href: hrefs });
      continue;
    }
    seen ??= new Set();
    for (let i = 0; i < hrefs.length; i++) {
      const href = hrefs[i];
      if (seen.has(href)) continue;
      seen.add(href);
      const link = tag("link", { rel: "modulepreload", href });
      if (i === 0) own += link;
      else imported += link;
    }
  }
  return imported + own;
}

function jsonLdTag(head: Head): string {
  if (head.jsonLd === undefined) return "";
  // `<` escaped so a string value cannot close the script element early.
  const json = JSON.stringify(head.jsonLd).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * Assemble the HTML document from the page body, head metadata and assets.
 *
 * A shell that renders `<html>` itself owns the document: its markup is
 * returned as is, with the `FuHead` and `FuScripts` markers replaced by fu's
 * tags. Any other body is wrapped in fu's own document.
 */
export function document(
  body: string,
  head: Head,
  assets: Assets,
  /** Files of the islands in `body`; their chunks are preloaded. */
  islands?: Iterable<string>,
): string {
  body = partialComments(body);
  const tags = tagsFor(assets);
  const owned = ownedDocument(body);
  if (owned) {
    head = ownedHead(head);
    let out = body.slice(owned.at);
    const headHtml = headTags(head) + tags.head + islandPreloads(assets, islands) +
      jsonLdTag(head);
    const withHead = replaceMarker(out, headMarker(), "FuHead", headHtml);
    if (withHead !== null) out = withHead;
    else if (headHtml) {
      warnOnce(
        "head",
        "[fu] the shell renders <html> but has no <FuHead/>: stylesheets and preloads, and the " +
          "ctx.head title, robots and other fields, are not emitted",
      );
    }
    const withScripts = replaceMarker(out, scriptsMarker(), "FuScripts", tags.body);
    if (withScripts !== null) out = withScripts;
    else if (tags.body) {
      warnOnce(
        "scripts",
        "[fu] the shell renders <html> but has no <FuScripts/>: islands will not hydrate",
      );
    }
    return "<!doctype html>" + owned.comments + out;
  }
  // Not an owned document: a marker here has nothing to mean. Drop it so the
  // token never reaches a client.
  const stray = strayMarkers();
  if (stray.test(body)) {
    warnOnce(
      "stray",
      "[fu] <FuHead/> or <FuScripts/> outside a document-owning shell is ignored",
    );
    body = body.replace(stray, "");
  }
  const parts = '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    headTags(head) + tags.head + islandPreloads(assets, islands) + jsonLdTag(head);
  return `<!doctype html><html lang="${
    esc(head.lang ?? "en")
  }"><head>${parts}</head><body>${body}${tags.body}</body></html>`;
}
