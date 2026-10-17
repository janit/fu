import { App } from "../../app.ts";

const app = new App<{ tenant?: string }>();
app.use((ctx) => ctx.url.pathname === "/healthz" ? new Response("ok") : ctx.next());
app.use((ctx) => {
  ctx.state.tenant = "fixture";
  return ctx.next();
});
// On the way out, once routing has run.
app.use(async (ctx) => {
  const res = await ctx.next();
  if (ctx.rawParams.code) res.headers.set("x-raw-code", ctx.rawParams.code);
  return res;
});
export default app;
