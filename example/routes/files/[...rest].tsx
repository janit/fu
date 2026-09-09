import type { PageContext } from "@janit/fu";
import type { State } from "../../state.ts";

export default function Files(ctx: PageContext<State>) {
  return <h1 id="rest">{ctx.params.rest}</h1>;
}
