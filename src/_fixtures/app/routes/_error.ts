import { h } from "preact";
import type { Ctx } from "../../../types.ts";

export default function ErrorPage(ctx: Ctx) {
  return h("main", { id: "err" }, `${ctx.error?.status}`);
}
