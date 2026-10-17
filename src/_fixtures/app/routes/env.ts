import { h } from "preact";
import type { Ctx } from "../../../types.ts";

export default function Env(ctx: Ctx) {
  return h("p", null, `env ${String(ctx.env.KEY)} ${ctx.assets ? "store" : "none"}`);
}
