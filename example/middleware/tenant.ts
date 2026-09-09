import type { Middleware } from "@janit/fu";
import type { State } from "../state.ts";

/** Resolve the tenant for every request and stamp it on state. */
export const resolveTenant: Middleware<State> = (ctx) => {
  ctx.state.tenant = ctx.url.hostname.split(".")[0] || "default";
  ctx.state.requestId = crypto.randomUUID().slice(0, 8);
  return ctx.next();
};

/** Health probe, answered before any per-request work. */
export const healthz: Middleware<State> = (ctx) =>
  ctx.url.pathname === "/healthz"
    ? new Response("ok", { headers: { "content-type": "text/plain" } })
    : ctx.next();

/** Per-tenant robots.txt, generated from state set upstream. */
export const robotsTxt: Middleware<State> = (ctx) => {
  if (ctx.url.pathname !== "/robots.txt") return ctx.next();
  const body = `User-agent: *\nAllow: /\n# tenant: ${ctx.state.tenant}\n`;
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};

/** Surface render-time exceptions instead of a bare 500 with no trace. */
export const logErrors: Middleware<State> = async (ctx) => {
  try {
    return await ctx.next();
  } catch (e) {
    console.error("[ssr-error]", ctx.url.pathname, e);
    throw e;
  }
};
