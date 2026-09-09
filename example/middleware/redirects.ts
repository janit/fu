import type { Middleware } from "@janit/fu";
import type { State } from "../state.ts";

/** Configured redirects: from -> [to, status]. */
const TABLE: Record<string, [string, number]> = {
  "/old-about": ["/about", 301],
  "/blog": ["/blog/hello-world", 302],
};

/** Short-circuit redirects: read the URL, return a Response. */
export const redirects: Middleware<State> = (ctx) => {
  const hit = TABLE[ctx.url.pathname];
  if (!hit) return ctx.next();
  const [target, status] = hit;
  return new Response(null, { status, headers: { location: target } });
};

/** Any non-root path ending in "/" 301s to the slash-free form. */
export const trailingSlash: Middleware<State> = (ctx) => {
  const { pathname, search } = ctx.url;
  if (pathname === "/" || !pathname.endsWith("/")) return ctx.next();
  // Refuse to emit a protocol-relative Location ("//evil.com") as an open
  // redirect; fall through and let the request 404 instead.
  const target = pathname.replace(/\/+$/, "");
  if (target.startsWith("//")) return ctx.next();
  return new Response(null, { status: 301, headers: { location: target + search } });
};
