import type { Middleware } from "@janit/fu";
import type { State } from "../state.ts";

const HEADERS: ReadonlyArray<[string, string]> = [
  ["X-Frame-Options", "SAMEORIGIN"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
];

/**
 * Registered first so it unwinds last: no inner middleware can clobber these,
 * and short-circuit responses from further in still pass through on the way out.
 */
export const securityHeaders: Middleware<State> = async (ctx) => {
  const res = await ctx.next();
  for (const [k, v] of HEADERS) res.headers.set(k, v);
  return res;
};

/** Defense in depth: no error response may be cacheable. */
export const noCacheErrors: Middleware<State> = async (ctx) => {
  const res = await ctx.next();
  if (res.status >= 400) {
    res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  return res;
};
