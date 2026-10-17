import type { Middleware } from "@janit/fu";
import type { State } from "../state.ts";

/**
 * Strict, because the framework allows it: every script the shell emits is an
 * external module with a `src`, and nothing writes an inline `<style>`. The
 * JSON-LD block is data, not script, so CSP leaves it alone. Only dev needs
 * more: the HMR socket is on port+1, a different origin. `fu dev` says so in
 * the environment, which reaches the app as `ctx.env` on every runtime.
 */
const csp = (dev: boolean) =>
  [
    "default-src 'self'",
    dev ? "connect-src 'self' ws://localhost:*" : "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

const headers = (dev: boolean): ReadonlyArray<[string, string]> => [
  ["Content-Security-Policy", csp(dev)],
  // DENY, to say the same as frame-ancestors 'none'.
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
];
const PROD = headers(false);
const DEV = headers(true);

/**
 * Registered first so it unwinds last: no inner middleware can clobber these,
 * and short-circuit responses from further in still pass through on the way out.
 */
export const securityHeaders: Middleware<State> = async (ctx) => {
  const res = await ctx.next();
  for (const [k, v] of ctx.env.FU_DEV === "1" ? DEV : PROD) res.headers.set(k, v);
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
