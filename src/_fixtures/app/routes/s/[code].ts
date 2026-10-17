import { h } from "preact";
import type { Ctx } from "../../../../types.ts";

export default function Short(ctx: Ctx) {
  return h("code", { "data-raw": ctx.rawParams.code }, ctx.params.code);
}
