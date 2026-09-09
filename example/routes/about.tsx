import type { PageContext } from "@janit/fu";
import type { State } from "../state.ts";

export const handlers = {
  GET: (ctx: PageContext<State>) => {
    ctx.head.title = "About — Fresh Urquell";
    ctx.head.description = "What this is and who it is for.";
    ctx.head.robots = "noindex";
    return { renderedAt: new Date().toISOString(), tenant: ctx.state.tenant };
  },
};

export default function About(ctx: PageContext<State>) {
  const data = ctx.data as { renderedAt: string; tenant: string };
  return (
    <>
      <h1>About</h1>
      <p>Handler data, computed on the server:</p>
      <p id="rendered-at">{data.renderedAt}</p>
      <p id="tenant">{data.tenant}</p>
    </>
  );
}
