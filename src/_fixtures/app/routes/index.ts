import { h } from "preact";
import type { Ctx } from "../../../types.ts";

export const handlers = {
  GET: (ctx: Ctx) => {
    ctx.head.title = "Fixture";
    return { n: 1 };
  },
};

export default function Home(ctx: Ctx) {
  return h("p", null, `home ${(ctx.data as { n: number }).n}`);
}
