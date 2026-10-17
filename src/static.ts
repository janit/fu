// Static files from a directory: as an asset store (`assetsFromDir`), what
// serve.mjs and fu dev hand the app where celld has its assets binding, and as
// middleware (`staticFiles`). Node-only: the Worker never imports this file.
import { constants, type Stats, statSync } from "node:fs";
import { access, type FileHandle, open, stat } from "node:fs/promises";
import * as path from "node:path";
import type { AssetStore, Middleware } from "./types.ts";

export interface StaticOptions {
  /**
   * Directory to serve. Pass an absolute path. A relative one is resolved
   * against the working directory once, when the middleware is made, so it
   * depends on where the server was started from. If the result is not a
   * directory, a warning is logged once and every request falls through.
   *
   * Symlinks inside `dir` are followed, and their targets are NOT re-checked
   * against `dir`: a link to a file outside it serves that file. Only put links
   * you trust there.
   */
  dir: string;
  /** Cache-Control for a served file, or null for none. Default: none. */
  cacheControl?: (pathname: string, url: URL) => string | null;
  /**
   * The ETag of a served file, or null for the built-in one. The built-in tag
   * is made of size and modification time, so it changes whenever the file is
   * written again, identical bytes or not (every image build does that); an
   * app that knows a content hash returns it here. The value is the complete
   * header value, quotes included: `"abc123"`, or `W/"abc123"` for a weak
   * one. It is what is sent, on a 200 and a 304 alike, and what
   * `If-None-Match` is compared with. A value that is not an entity-tag, one
   * that holds a comma, or a throw, is logged once and the built-in tag used. `Last-Modified` is
   * still the file's own.
   */
  etag?: (pathname: string, stat: { size: number; mtimeMs: number }) => string | null;
}

/**
 * RFC 9110 entity-tag: optionally weak, quoted, no quote or control character
 * inside. And no comma, which the grammar allows: `If-None-Match` is a
 * comma-separated list and is split on commas here, so a tag holding one
 * could be sent and never matched.
 */
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x2b\x2d-\x7e\x80-\xff]*"$/;

/**
 * The extensions a real static directory holds (frontend4/static, 936 files:
 * 512 pbf glyphs, 272 svg, 88 webp, 31 png, 15 css, 7 woff2, 2 mjs, 2 json,
 * 2 js, and one each of xml, txt, ico, html), plus the ones a later addition
 * is likely to be and that `nosniff` makes unusable when mistyped (wasm, the
 * other image formats, source maps, a web manifest). This list is the
 * contract: anything else is `application/octet-stream`, a download.
 */
const TYPES: Record<string, string> = {
  wasm: "application/wasm",
  avif: "image/avif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  pbf: "application/x-protobuf",
  svg: "image/svg+xml",
  webp: "image/webp",
  png: "image/png",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  mjs: "text/javascript; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  ico: "image/x-icon",
  html: "text/html; charset=utf-8",
};

export function contentType(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return TYPES[base.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The path segments a request may address, or null when it may not. The RAW
 * pathname is split on `/` first and each segment decoded on its own, so an
 * encoded slash (`%2f`) can never act as a separator: the path policy and the
 * filesystem see the same segments. Refused: a malformed escape, a decoded
 * segment containing `/`, `\` or NUL, an empty segment (`//`, a trailing slash,
 * the root), `.`, `..` and dotfiles. Decided before any filesystem call.
 */
export function safeSegments(pathname: string): string[] | null {
  if (!pathname.startsWith("/")) return null;
  const segments: string[] = [];
  for (const raw of pathname.slice(1).split("/")) {
    let s: string;
    try {
      s = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // A leading dot covers `.`, `..` and dotfiles alike.
    if (s === "" || s.startsWith(".")) return null;
    if (s.includes("/") || s.includes("\\") || s.includes("\0")) return null;
    segments.push(s);
  }
  return segments;
}

/** Whether `file` (already resolved) lies strictly below `root`. Defence in depth. */
export function isUnder(root: string, file: string): boolean {
  return file.startsWith(root + path.sep);
}

/** `If-None-Match` against our etag: `*`, a list, weak comparison. */
function etagMatches(header: string, etag: string): boolean {
  const weak = (v: string) => (v.startsWith("W/") ? v.slice(2) : v);
  const ours = weak(etag);
  for (const part of header.split(",")) {
    const v = part.trim();
    if (v === "*" || weak(v) === ours) return true;
  }
  return false;
}

let openHandles = 0;

/**
 * How many files a response body currently holds open. For tests only.
 * @internal
 */
export function __openHandlesForTest(): number {
  return openHandles;
}

const CHUNK = 64 * 1024;

/**
 * The body of a served file: `size` bytes of `file`, read on demand.
 *
 * Nothing is opened until the body is pulled, so a response that is dropped
 * unread (an outer middleware answered instead) holds no file handle; one left
 * for the garbage collector to close is an uncaught exception on Node. Once
 * open, the handle is closed on the last byte, on cancel and on any error.
 *
 * The headers were written from a stat by path. The first pull stats again
 * through the handle and errors the stream if size or mtime differ: a body
 * shorter or longer than the content-length already sent is worse than a
 * failed download. At most `size` bytes are read.
 */
function fileBody(file: string, size: number, mtimeMs: number): ReadableStream<Uint8Array> {
  let handle: FileHandle | null = null;
  let sent = 0;
  let cancelled = false;
  const close = async (): Promise<void> => {
    const h = handle;
    handle = null;
    if (!h) return;
    openHandles--;
    await h.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!handle) {
          const h = await open(file, "r");
          handle = h;
          openHandles++;
          const st = await h.stat();
          if (!st.isFile() || st.size !== size || Math.floor(st.mtimeMs) !== mtimeMs) {
            throw new Error(`fu: ${file} changed while it was being served`);
          }
        }
        // A cancel that arrived while the file was being opened found nothing
        // to close; close it here.
        if (cancelled || !handle) return await close();
        const want = Math.min(CHUNK, size - sent);
        const buf = new Uint8Array(want);
        const { bytesRead } = await handle.read(buf, 0, want, sent);
        if (cancelled) return await close();
        if (bytesRead === 0) throw new Error(`fu: ${file} was truncated while it was being served`);
        sent += bytesRead;
        controller.enqueue(bytesRead === want ? buf : buf.subarray(0, bytesRead));
        if (sent >= size) {
          await close();
          controller.close();
        }
      } catch (err) {
        await close().catch(() => {});
        if (!cancelled) controller.error(err);
      }
    },
    cancel(): Promise<void> {
      cancelled = true;
      return close();
    },
    // No read-ahead: with the default of one chunk the stream would pull, and
    // open the file, as soon as it is constructed.
  }, { highWaterMark: 0 });
}
export interface DirStoreOptions {
  /** See `StaticOptions.etag`. */
  etag?: StaticOptions["etag"];
}

/** A directory's files, answered by pathname. Shared by `assetsFromDir` and `staticFiles`. */
interface DirFiles {
  /**
   * The answer for `pathname` (raw, as in a URL), or null when there is no
   * file to serve there. `req` supplies the method and the conditional headers.
   */
  serve(pathname: string, req: Request): Promise<{ res: Response; segments: string[] } | null>;
}

function dirFiles(dir: string, etag: DirStoreOptions["etag"], label: string): DirFiles {
  const root = path.resolve(dir);
  // One look at startup, nothing per request: a wrong directory (a relative
  // one, and a server started from elsewhere) would otherwise be a 404 for
  // every file with no word about why.
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    console.warn(`[fu] ${label}: ${root} is not a directory; every request will fall through`);
  }
  let warnedEtag = false;
  return {
    async serve(pathname, req) {
      const method = req.method;
      if (method !== "GET" && method !== "HEAD") return null;
      const segments = safeSegments(pathname);
      if (!segments) return null;
      const file = path.join(root, ...segments);
      if (!isUnder(root, file)) return null;

      let st: Stats;
      try {
        st = await stat(file);
        // A file that cannot be read is not served: found out now, while the
        // request can still fall through, not when the body is pulled.
        // HEAD too, or it would promise a file that GET then does not send.
        if (st.isFile()) await access(file, constants.R_OK);
      } catch {
        return null;
      }
      if (!st.isFile()) return null;

      const mtimeMs = Math.floor(st.mtimeMs);
      let own: string | null | undefined;
      try {
        own = etag?.("/" + segments.join("/"), { size: st.size, mtimeMs: st.mtimeMs });
        if (own != null && !ENTITY_TAG.test(own)) {
          throw new Error(`${JSON.stringify(own)} is not an entity-tag such as "abc" or W/"abc"`);
        }
      } catch (err) {
        own = null;
        if (!warnedEtag) {
          warnedEtag = true;
          console.error(`[fu] ${label} etag: using the built-in tag instead`, err);
        }
      }
      const tag = own ?? `W/"${st.size}-${mtimeMs}"`;
      const headers = new Headers({
        "content-type": contentType(file),
        etag: tag,
        "last-modified": new Date(mtimeMs).toUTCString(),
        "accept-ranges": "none",
        "x-content-type-options": "nosniff",
      });
      const inm = req.headers.get("if-none-match");
      const ims = req.headers.get("if-modified-since");
      let fresh: boolean;
      if (inm !== null) fresh = etagMatches(inm, tag);
      else {
        // Only a value that round-trips as an HTTP date counts. HTTP dates
        // have second precision; compare on whole seconds.
        const t = ims !== null ? Date.parse(ims) : NaN;
        fresh = ims !== null && new Date(t).toUTCString() === ims &&
          t >= Math.floor(mtimeMs / 1000) * 1000;
      }
      if (fresh) return { res: new Response(null, { status: 304, headers }), segments };
      headers.set("content-length", String(st.size));
      // Nothing is opened here: the body opens the file when it is first read.
      const body = method === "GET" && st.size > 0 ? fileBody(file, st.size, mtimeMs) : null;
      return { res: new Response(body, { status: 200, headers }), segments };
    },
  };
}

/**
 * An `AssetStore` over a directory: what `serve.mjs` and `fu dev` hand the app
 * as `ctx.assets`, where celld hands it the assets binding. It answers like
 * that binding does, as far as an app can tell: the file, or a 304; 404 for a
 * miss; 405 for a method other than GET and HEAD.
 *
 * Files only: no directory listing, no `index.html`, no compression (a CDN or
 * proxy does that), no byte ranges (`accept-ranges: none`; a `Range` header
 * gets the whole file). A weak ETag from size and mtime (or `opts.etag`),
 * `Last-Modified`, and 304 for a matching `If-None-Match` (which wins) or
 * `If-Modified-Since`. Paths are decoded one segment at a time and refused
 * when a segment is empty, a dot segment, a dotfile, or decodes to a
 * separator or NUL. Symlinks inside `dir` are followed; see `StaticOptions.dir`.
 */
export function assetsFromDir(dir: string, opts: DirStoreOptions = {}): AssetStore {
  const files = dirFiles(dir, opts.etag, "assetsFromDir");
  return {
    async fetch(input) {
      const req = input instanceof Request ? input : new Request(input);
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const hit = await files.serve(new URL(req.url).pathname, req);
      return hit?.res ?? new Response(req.method === "HEAD" ? null : "Not Found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
  };
}

/**
 * Middleware: answer `GET`/`HEAD` of a regular file under `dir`, else `next()`.
 * What `assets()` does over `assetsFromDir(dir)`, with the path the app's
 * middleware left in `ctx.url`. `cacheControl` is given the decoded path, and
 * is asked only about a file that is served; a 304 carries the same
 * `Cache-Control` as the 200 would (RFC 9110, 15.4.5).
 */
export function staticFiles<S = Record<string, unknown>>(opts: StaticOptions): Middleware<S> {
  const files = dirFiles(opts.dir, opts.etag, "staticFiles");
  let warnedCc = false;
  return async (ctx) => {
    const hit = await files.serve(ctx.url.pathname, ctx.req);
    if (!hit) return ctx.next();
    // Asked only now: the policy is for files that are served, not for misses.
    let cc: string | null | undefined;
    try {
      cc = opts.cacheControl?.("/" + hit.segments.join("/"), ctx.url);
    } catch (err) {
      if (!warnedCc) {
        warnedCc = true;
        console.error("[fu] staticFiles cacheControl threw", err);
      }
    }
    if (cc) hit.res.headers.set("cache-control", cc);
    return hit.res;
  };
}

// The runtime-neutral half of `@janit/fu/static`, so one import path serves both.
export { assets, type AssetsOptions } from "./assets.ts";
