// Static files through an asset store: celld's assets binding, or a directory
// under serve.mjs and fu dev (`assetsFromDir` in static.ts). Nothing here may
// import `node:` code: this module is bundled into the Worker.
import type { AssetStore, Middleware, RequestExtra } from "./types.ts";

/** What a client file is served with: its name carries a content hash. */
export const IMMUTABLE = "public, max-age=31536000, immutable";

/** Statuses that mean the store served the file, or confirmed the copy the client has. */
const SERVED = new Set([200, 206, 304]);

export interface AssetsOptions {
  /**
   * Whether `pathname` (as in `ctx.url.pathname`, undecoded) is a file worth
   * asking the store for. Default: every path. An app that knows its asset
   * directory passes a set of its paths, so a page request costs no lookup
   * and the store's own 404 never reaches anyone.
   */
  isStatic?: (pathname: string) => boolean;
  /** Cache-Control for a served file, or null to keep the store's. */
  cacheControl?: (pathname: string, url: URL) => string | null;
  /** Content-Type for a served file the store sent none for (celld sends none for an unknown extension). */
  contentType?: (pathname: string) => string | null;
  /** The store to read from. Default: `ctx.assets`, the runtime's. */
  store?: AssetStore;
}

/**
 * Middleware: answer `GET`/`HEAD` of a static file from the asset store, with
 * the app's headers on it; anything else, a miss included, goes to `next()`.
 * Inside the chain, so the app's own middleware (security headers, an
 * override for one path) runs for files as it does for pages. On celld that
 * needs `run_worker_first`, or the store answers before the Worker is asked.
 *
 * A 200, 206 or 304 from the store is passed on with `cacheControl` applied
 * (to a 304 as well: RFC 9110 15.4.5); any other status falls through and its
 * body is dropped. What is passed on is a copy: a Workers fetch returns
 * immutable headers, and an outer middleware must be able to add its own.
 */
export function assets<S = Record<string, unknown>>(opts: AssetsOptions = {}): Middleware<S> {
  let warnedStore = false;
  let warnedCc = false;
  return async (ctx) => {
    const method = ctx.req.method;
    if (method !== "GET" && method !== "HEAD") return ctx.next();
    const pathname = ctx.url.pathname;
    if (opts.isStatic && !opts.isStatic(pathname)) return ctx.next();
    const store = opts.store ?? ctx.assets;
    if (!store) {
      if (!warnedStore) {
        warnedStore = true;
        console.warn(
          "[fu] assets(): this runtime has no asset store (on celld: `assets.binding` " +
            `"ASSETS" in wrangler.jsonc); every request falls through`,
        );
      }
      return ctx.next();
    }
    const res = await store.fetch(ctx.req);
    if (!SERVED.has(res.status)) {
      await res.body?.cancel();
      return ctx.next();
    }
    let cc: string | null | undefined;
    try {
      cc = opts.cacheControl?.(pathname, ctx.url);
    } catch (err) {
      if (!warnedCc) {
        warnedCc = true;
        console.error("[fu] assets() cacheControl threw", err);
      }
    }
    const type = res.headers.has("content-type") ? null : opts.contentType?.(pathname);
    return withHeaders(res, {
      ...(cc ? { "cache-control": cc } : {}),
      ...(type ? { "content-type": type } : {}),
    });
  };
}

/**
 * The same response with headers set. A copy, because what a Workers fetch
 * returns has immutable headers.
 */
function withHeaders(res: Response, set: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(set)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

type Handler = (req: Request, extra?: RequestExtra) => Promise<Response>;

/**
 * The asset prefix of a built app, in front of its handler. A request for one
 * of `files`, by that exact URL, with GET or HEAD, is served from the runtime's
 * asset store and may be cached for good: its name carries a content hash.
 * Anything else under the prefix (a chunk of an earlier build, another
 * spelling of a file, a POST) is a 404 nobody may cache; a page open across a
 * deploy asks for exactly that, and a CDN that kept the 404 would go on
 * serving it after a rollback brought the file back. The app is never asked
 * about the prefix.
 *
 * No path is interpreted: a file is its URL to the letter, so a spelling this
 * test does not know costs a cache hit and nothing else.
 */
export function clientFiles(
  handler: Handler,
  { prefix, files }: { prefix: string; files: readonly string[] },
): Handler {
  const known = new Set(files);
  const bare = prefix.replace(/\/$/, "");
  let warned = false;
  return async (req, extra = {}) => {
    const path = new URL(req.url).pathname;
    if (path !== bare && !path.startsWith(prefix)) return handler(req, extra);
    const read = req.method === "GET" || req.method === "HEAD";
    if (!read || !known.has(path)) return failure(404, "Not Found", req);
    if (!extra.assets) {
      if (!warned) {
        warned = true;
        console.error(
          `[fu] ${path} is a client file, but this runtime has no asset store to serve it ` +
            `from. On celld, add "assets": { "directory": ".output/public", "binding": ` +
            `"ASSETS" } to wrangler.jsonc.`,
        );
      }
      return failure(500, "Internal Server Error", req);
    }
    const res = await extra.assets.fetch(req);
    return withHeaders(res, { "cache-control": SERVED.has(res.status) ? IMMUTABLE : "no-store" });
  };
}

function failure(status: number, text: string, req: Request): Response {
  return new Response(req.method === "HEAD" ? null : text, {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}
