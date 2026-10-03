// Routing on the web-standard URLPattern API.
// Native on Deno, Bun and Node >= 24; polyfilled only where it is missing.
import type { RouteManifest, RouteModule } from "./types.ts";

if (typeof globalThis.URLPattern === "undefined") {
  await import("urlpattern-polyfill");
}

export interface Route<S = Record<string, unknown>> {
  /** URLPattern pathname, e.g. "/blog/:slug". */
  pattern: string;
  urlPattern: URLPattern;
  load: () => Promise<RouteModule<S>>;
  /** Lower sorts first: static beats dynamic beats wildcard. */
  score: number;
  /**
   * The canonical pathname when the pattern has no pattern syntax at all, so
   * the route can be matched by string equality instead of `URLPattern.exec`.
   */
  literal: string | null;
  /** Segments in the pattern. A wildcard matches one fewer or more; the rest exactly this many. */
  segments: number;
  /** The loaded module, cached by the renderer after the first request. */
  module?: RouteModule<S>;
}

export interface Matched<S = Record<string, unknown>> {
  route: Route<S>;
  params: Record<string, string>;
}

/** `[name]` or `[...name]`, as a whole path segment. */
const PARAM = /^\[(\.\.\.)?(.*)\]$/;
/** What URLPattern reads as one param name; `[my-id]` would become `:my` plus a literal `-id`. */
const PARAM_NAME = /^[A-Za-z_$][\w$]*$/;
/** Anything URLPattern would read as syntax rather than as a literal character. */
const PATTERN_SYNTAX = /[:*?+(){}\\]/g;

interface Parsed {
  pattern: string;
  /** The pattern with param names dropped: two files with the same shape collide. */
  shape: string;
  /** The path itself when no segment is a param, else null. */
  literal: string | null;
  /** 0 static, 1 dynamic, 2 wildcard. */
  score: number;
}

function parse(file: string): Parsed {
  let p = file.replace(/^\/routes/, "").replace(/\.[tj]sx?$/, "");
  if (p.endsWith("/index")) p = p.slice(0, -"/index".length);
  let score = 0;
  const shape: string[] = [];
  const pattern = p.split("/").map((s) => {
    const m = PARAM.exec(s);
    if (!m) {
      // A file name is a literal: `a+b.tsx` answers `/a+b`.
      const escaped = s.replace(PATTERN_SYNTAX, "\\$&");
      shape.push(escaped);
      return escaped;
    }
    const [, rest, name] = m;
    if (!PARAM_NAME.test(name)) {
      throw new Error(
        `fu: ${file}: the param name "${name}" must be letters, digits, _ or $, ` +
          `and not start with a digit`,
      );
    }
    score = Math.max(score, rest ? 2 : 1);
    shape.push(rest ? ":*" : ":");
    return ":" + name + (rest ? "*" : "");
  }).join("/") || "/";
  return { pattern, shape: shape.join("/") || "/", literal: score === 0 ? p || "/" : null, score };
}

/**
 * `/routes/blog/[slug].tsx` -> `/blog/:slug`
 * `/routes/files/[...rest].tsx` -> `/files/:rest*`
 * `/routes/index.tsx` -> `/`
 */
export function filePathToPattern(file: string): string {
  return parse(file).pattern;
}

/** A path the way a request URL's `pathname` spells it. */
function asPathname(path: string): string {
  const url = new URL("http://x");
  url.pathname = path;
  return canonical(url.pathname);
}

const ESCAPE = /%[0-9a-fA-F]{2}/g;
const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * One spelling per path: an escape that did not need to be one is decoded and
 * the rest are upper-cased, so `/%61bout` and `/caf%c3%a9` reach the routes
 * `/about` and `/café` instead of falling through to a param route.
 */
function canonical(pathname: string): string {
  if (!pathname.includes("%")) return pathname;
  return pathname.replace(ESCAPE, (e) => {
    const c = String.fromCharCode(parseInt(e.slice(1), 16));
    return UNRESERVED.test(c) ? c : e.toUpperCase();
  });
}

export function buildRoutes<S = Record<string, unknown>>(
  manifest: RouteManifest<S>,
): Route<S>[] {
  const out: Route<S>[] = [];
  const shapes = new Map<string, string>();
  for (const [file, load] of Object.entries(manifest)) {
    const { pattern, shape, literal, score } = parse(file);
    // Which of two such files answered used to depend on the order they were
    // listed in, with no word about the other.
    const twin = shapes.get(shape);
    if (twin) throw new Error(`fu: ${twin} and ${file} both answer ${pattern}; remove one`);
    shapes.set(shape, file);
    out.push({
      pattern,
      urlPattern: new URLPattern({ pathname: pattern }),
      load,
      score,
      literal: literal === null ? null : asPathname(literal),
      segments: countSegments(pattern),
    });
  }
  return out.sort((a, b) =>
    a.score - b.score || b.segments - a.segments || bySegment(a.pattern, b.pattern)
  );
}

/**
 * Tie-break between routes of the same kind and length, so the winner never
 * depends on the order the file system listed them in: compared segment by
 * segment, a literal beats a param (`/blog/:slug` before `/:lang/about`), and
 * what is still tied sorts by pattern.
 */
function bySegment(a: string, b: string): number {
  const as = a.split("/"), bs = b.split("/");
  for (let i = 0; i < as.length && i < bs.length; i++) {
    const d = Number(as[i].startsWith(":")) - Number(bs[i].startsWith(":"));
    if (d) return d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function countSegments(pathname: string): number {
  let n = 1;
  for (let i = 0; i < pathname.length; i++) if (pathname.charCodeAt(i) === 47 /* / */) n++;
  return n;
}

/**
 * First route that matches, in `buildRoutes` order.
 *
 * `URLPattern.exec` costs microseconds per call, so it only runs for routes
 * that could match: literal routes compare by equality, and a pattern whose
 * segment count cannot fit the path is skipped. The string input form is used
 * because the `{ pathname }` dictionary form is several times slower on Deno.
 */
export function match<S = Record<string, unknown>>(
  routes: Route<S>[],
  pathname: string,
): Matched<S> | null {
  pathname = canonical(pathname);
  const n = countSegments(pathname);
  const input = "http://x" + pathname;
  for (const route of routes) {
    if (route.literal !== null) {
      if (route.literal === pathname) return { route, params: {} };
      continue;
    }
    if (route.score === 2 ? n < route.segments - 1 : n !== route.segments) continue;
    const m = route.urlPattern.exec(input);
    if (!m) continue;
    const params = decodeParams(route.pattern, m.pathname.groups);
    if (params) return { route, params };
  }
  return null;
}

/**
 * Decoded params, or null when the request should not match this route.
 *
 * URLPattern matches the encoded path, so `%2F` passes as part of one segment
 * and only becomes a separator on decoding: `[slug]` would hand the app
 * `../../etc/passwd`, a traversal for the first handler that joins it onto a
 * directory. So a value may not hold NUL, a backslash, or a `.`/`..` segment,
 * and only a wildcard may hold `/`. A malformed escape is no match either,
 * rather than a throw.
 */
function decodeParams(
  pattern: string,
  groups: Record<string, string | undefined>,
): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (const [k, raw] of Object.entries(groups)) {
    if (raw === undefined) continue;
    let v: string;
    try {
      v = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (v.includes("\0") || v.includes("\\")) return null;
    if (v.includes("/") && !pattern.includes(`:${k}*`)) return null;
    if (v.split("/").some((s) => s === "." || s === "..")) return null;
    params[k] = v;
  }
  return params;
}
