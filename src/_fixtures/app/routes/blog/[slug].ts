import { h } from "preact";
import type { Ctx } from "../../../../types.ts";

export default function Post(ctx: Ctx) {
  return h("h1", null, ctx.params.slug);
}
