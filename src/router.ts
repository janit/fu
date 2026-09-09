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

/**
 * `/routes/blog/[slug].tsx` -> `/blog/:slug`
 * `/routes/files/[...rest].tsx` -> `/files/:rest*`
 * `/routes/index.tsx` -> `/`
 */
export function filePathToPattern(file: string): string {
  let p = file.replace(/^\/routes/, "").replace(/\.[tj]sx?$/, "");
  if (p.endsWith("/index")) p = p.slice(0, -"/index".length);
  const out = p
    .split("/")
    .map((s) =>
      s.startsWith("[...") && s.endsWith("]")
        ? ":" + s.slice(4, -1) + "*"
        : s.startsWith("[") && s.endsWith("]")
        ? ":" + s.slice(1, -1)
        : s
    )
    .join("/");
  return out || "/";
}

/** Anything URLPattern would read as syntax rather than as a literal character. */
const PATTERN_SYNTAX = /[:*?+(){}\\]/;

export function buildRoutes<S = Record<string, unknown>>(
  manifest: RouteManifest<S>,
): Route<S>[] {
  const out: Route<S>[] = [];
  for (const [file, load] of Object.entries(manifest)) {
    const pattern = filePathToPattern(file);
    const urlPattern = new URLPattern({ pathname: pattern });
    out.push({
      pattern,
      urlPattern,
      load,
      score: pattern.includes("*") ? 2 : pattern.includes(":") ? 1 : 0,
      literal: PATTERN_SYNTAX.test(pattern) ? null : urlPattern.pathname,
      segments: countSegments(pattern),
    });
  }
  return out.sort((a, b) => a.score - b.score || b.segments - a.segments);
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
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.pathname.groups)) {
      if (v !== undefined) params[k] = decodeURIComponent(v);
    }
    return { route, params };
  }
  return null;
}
