import type { Middleware } from "@janit/fu";
import type { State } from "../state.ts";

/** A host name or IP literal, nothing that could end the directive. */
const PLAIN_HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)$/i;

/**
 * The HMR client dials the host the page came from (localhost, or a LAN
 * address under `fu dev --host 0.0.0.0`), so dev names that host, unless it is
 * not a plain name: URL keeps ";" in a host, which would open a directive.
 */
const devConnectSrc = (url: URL): string => {
  const host = url.hostname;
  return host !== "localhost" && PLAIN_HOST.test(host)
    ? `connect-src 'self' ws://localhost:* ws://${host}:* wss://${host}:*`
    : "connect-src 'self' ws://localhost:*";
};

/**
 * Strict, because the framework allows it: every script the shell emits is an
 * external module with a `src`, and nothing writes an inline `<style>`. The
 * JSON-LD block is data, not script, so CSP leaves it alone. Only dev needs
 * more: the HMR socket is on port+1, a different origin. `fu dev` says so in
 * the environment, which reaches the app as `ctx.env` on every runtime.
 */
const csp = (connectSrc: string) =>
  [
    "default-src 'self'",
    connectSrc,
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

const headers = (connectSrc: string): ReadonlyArray<[string, string]> => [
  ["Content-Security-Policy", csp(connectSrc)],
  // DENY, to say the same as frame-ancestors 'none'.
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
];
const PROD = headers("connect-src 'self'");

/**
 * Registered first so it unwinds last: no inner middleware can clobber these,
 * and short-circuit responses from further in still pass through on the way out.
 */
export const securityHeaders: Middleware<State> = async (ctx) => {
  const res = await ctx.next();
  for (const [k, v] of ctx.env.FU_DEV === "1" ? headers(devConnectSrc(ctx.url)) : PROD) {
    res.headers.set(k, v);
  }
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
