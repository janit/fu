/** One client asset the HTML shell should reference. */
export interface Asset {
  href: string;
}

/** Client assets for a page, as produced by a driver. */
export interface Assets {
  js: Asset[];
  css: Asset[];
  /**
   * Modules every page will fetch, announced on every page as `modulepreload`:
   * in a build, what the entry imports statically.
   */
  preload?: Asset[];
  /**
   * Island file ("/islands/Counter.tsx") to what a page that renders it
   * preloads: the URL of its chunk, or a list, the chunk first and then the
   * chunks that one imports statically. A page names each URL once, however
   * many of its islands list it: the imported chunks, then the islands' own.
   */
  islands?: Record<string, string | string[]>;
}

/**
 * Document metadata the shell renders into `<head>`.
 *
 * Middleware and route handlers both write here; it is deliberately separate
 * from user `state` so the shell's contract stays explicit and typing an app's
 * own state does not mean re-declaring these.
 */
export interface Head {
  title?: string;
  description?: string;
  canonical?: string;
  /** `<meta name="robots">` content, e.g. "noindex, nofollow". */
  robots?: string;
  /** og:image URL. */
  image?: string;
  /**
   * `<html lang>` of the document fu writes; defaults to "en". A shell that
   * owns the document (returns `<html>`) writes its own `lang`: this field is
   * then emitted nowhere.
   */
  lang?: string;
  /** Raw `<link>` descriptors, e.g. hreflang alternates or preloads. */
  links?: Record<string, string>[];
  /** Serialized as a JSON-LD script tag when present. */
  jsonLd?: unknown;
}

/** A request that failed, normalised for the error page. */
export interface RouteError {
  status: number;
  /** Safe to render. For a 500 this is generic, never the underlying message. */
  message: string;
  /** Headers the error response must carry, from an `HttpError`. */
  headers?: Headers;
  /** What was actually thrown. Log it; do not render it. */
  cause?: unknown;
}

/**
 * Status and headers for a rendered page, written by a handler or middleware
 * and applied by the renderer. Ignored when a handler returns a `Response`
 * (that Response is authoritative) and on the error path (an error response
 * is built from the error alone, so a handler that set `Cache-Control:
 * public` and then threw cannot make a 404 cacheable).
 */
export interface ResponseOverride {
  /**
   * Status of the rendered page. Default 200. Must be 200 to 599, except 204,
   * 205 and 304, which cannot carry a body: those fail the render with a
   * RangeError. A status of 400 or more forces cache-control: no-store.
   */
  status: number;
  /** Headers merged onto the rendered page's response (set-cookie is appended, others set). */
  headers: Headers;
}

/**
 * The bindings the runtime hands the app: on celld, the Worker's `env` (vars,
 * KV, Durable Object namespaces, `ASSETS`); under `serve.mjs`, the process
 * environment. Augment it to type an app's own bindings:
 * `declare module "@janit/fu" { interface Env { API_URL: string } }`.
 */
export interface Env {
  [key: string]: unknown;
}

/**
 * Where static files come from: celld's assets binding, or `assetsFromDir()`
 * under `serve.mjs` and `fu dev`. The shape of a Workers `Fetcher`, as far as
 * reading files goes.
 */
export interface AssetStore {
  fetch(input: Request | string | URL): Promise<Response>;
}

/** What the runtime passes beside the request. Every field is optional. */
export interface RequestExtra {
  env?: Env;
  waitUntil?(promise: Promise<unknown>): void;
  assets?: AssetStore | null;
}

/** Request context handed to middleware, handlers and page components. */
export interface Ctx<S = Record<string, unknown>> {
  req: Request;
  url: URL;
  /**
   * Route params, percent-decoded one path segment at a time. Empty until
   * routing has run, so middleware sees `{}` before `next()`. Decoding never
   * makes a separator: `%2F` and `%5C` stay as written, so a value has a `/`
   * only between the segments of a wildcard, and is never `.` or `..`. A
   * segment with a malformed escape is left as written.
   */
  params: Record<string, string>;
  /**
   * The same keys as `params`, spelled as in `url.pathname`, undecoded. A
   * wildcard is its segments joined with `/`. It tells `%2F` from `%252F`,
   * which are both `%2F` in `params`.
   */
  rawParams: Record<string, string>;
  /** Whatever the app puts here. Shared across middleware, handler and page. */
  state: S;
  /** Document metadata for the shell. */
  head: Head;
  /** Value returned by the route's matching handler, if any. */
  data?: unknown;
  /** Set only when rendering the error page. */
  error?: RouteError;
  /** Status and headers for a rendered page. See `ResponseOverride`. */
  response: ResponseOverride;
  /** True when the request is a partial-navigation fetch (`?fu-partial=1`). */
  partial: boolean;
  /** The runtime's bindings. `{}` when the handler was called without them. */
  env: Env;
  /**
   * Keep the runtime alive until `promise` settles, for work the response does
   * not wait for (a log write, a cache refresh). On celld an isolate may be
   * stopped once the response is sent, so work not handed over here can be cut
   * off. Under `serve.mjs` the process keeps running anyway, and a rejection is
   * logged. A no-op when the handler was called without it.
   */
  waitUntil(promise: Promise<unknown>): void;
  /** The static file store, or null when the runtime has none. */
  assets: AssetStore | null;
  /** Run the rest of the chain. Returns the Response for outer middleware. */
  next(): Promise<Response>;
}

/**
 * A middleware. Return a Response to short-circuit, or `ctx.next()` to
 * continue — optionally awaiting it first to inspect or mutate the result.
 * Registration order is outermost first, so the first registered unwinds last.
 */
export type Middleware<S = Record<string, unknown>> = (
  ctx: Ctx<S>,
) => Response | Promise<Response>;

/** What a page component receives. */
export type PageContext<S = Record<string, unknown>> = Ctx<S>;

/** A route handler: return a Response to short-circuit, or data for the page. */
export type RouteHandler<S = Record<string, unknown>> = (
  ctx: Ctx<S>,
) => unknown | Promise<unknown>;

/**
 * A route's handlers, keyed by HTTP method. Annotate with it so `ctx` is typed:
 * `export const handlers: Handlers<State> = { GET(ctx) { ... } };`
 */
export type Handlers<S = Record<string, unknown>> = Record<string, RouteHandler<S>>;

/** A user-authored route module. */
export interface RouteModule<S = Record<string, unknown>> {
  default?: (ctx: Ctx<S>) => unknown;
  handlers?: Handlers<S>;
}

/**
 * Lazy map of route file path to module loader — the only shape the core needs
 * from a driver. Keys are root-relative, e.g. "/routes/blog/[slug].tsx".
 */
export type RouteManifest<S = Record<string, unknown>> = Record<
  string,
  () => Promise<RouteModule<S>>
>;

/** Options shared by the dev and build drivers. */
export interface FuOptions {
  /** Project root containing `routes/` and `islands/`. */
  root: string;
  /** Dev server port. Defaults to 1337. */
  port?: number;
  /** Dev server bind address. Defaults to 127.0.0.1; `0.0.0.0` opens it to the network. */
  hostname?: string;
  /** Build output directory. Defaults to `<root>/.output`. */
  outDir?: string;
}
