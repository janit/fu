/** One client asset the HTML shell should reference. */
export interface Asset {
  href: string;
}

/** Client assets for a page, as produced by a driver. */
export interface Assets {
  js: Asset[];
  css: Asset[];
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
  /** `<html lang>`; defaults to "en". */
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
  /** What was actually thrown. Log it; do not render it. */
  cause?: unknown;
}

/** Request context handed to middleware, handlers and page components. */
export interface Ctx<S = Record<string, unknown>> {
  req: Request;
  url: URL;
  /** Route params. Empty until routing has run, so middleware sees `{}`. */
  params: Record<string, string>;
  /** Whatever the app puts here. Shared across middleware, handler and page. */
  state: S;
  /** Document metadata for the shell. */
  head: Head;
  /** Value returned by the route's matching handler, if any. */
  data?: unknown;
  /** Set only when rendering the error page. */
  error?: RouteError;
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

/** A user-authored route module. */
export interface RouteModule<S = Record<string, unknown>> {
  default?: (ctx: Ctx<S>) => unknown;
  handlers?: Record<string, RouteHandler<S>>;
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
  /** Dev server bind address. Defaults to 0.0.0.0 (all interfaces). */
  hostname?: string;
  /** Build output directory. Defaults to `<root>/.output`. */
  outDir?: string;
}
