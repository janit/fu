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
  if (p === "/index" || p === "") p = "/";
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

export function buildRoutes<S = Record<string, unknown>>(
  manifest: RouteManifest<S>,
): Route<S>[] {
  const out: Route<S>[] = [];
  for (const [file, load] of Object.entries(manifest)) {
    const pattern = filePathToPattern(file);
    const score = pattern.includes("*") ? 2 : pattern.includes(":") ? 1 : 0;
    out.push({ pattern, urlPattern: new URLPattern({ pathname: pattern }), load, score });
  }
  return out.sort((a, b) =>
    a.score - b.score || b.pattern.split("/").length - a.pattern.split("/").length
  );
}

export function match<S = Record<string, unknown>>(
  routes: Route<S>[],
  pathname: string,
): Matched<S> | null {
  for (const route of routes) {
    const m = route.urlPattern.exec({ pathname });
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.pathname.groups)) {
      if (v !== undefined) params[k] = decodeURIComponent(v);
    }
    return { route, params };
  }
  return null;
}
