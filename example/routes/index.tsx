import type { PageContext } from "@janit/fu";
import type { State } from "../state.ts";
import Counter from "../islands/Counter.tsx";
import { Toggle } from "../islands/Toggle.tsx";
import Anon from "../islands/Anon.tsx";

export const handlers = {
  GET: (ctx: PageContext<State>) => {
    ctx.head.title = "Fresh Urquell";
    ctx.head.description = "A minimal islands framework on Preact, rolldown and Nitro.";
    ctx.head.canonical = ctx.url.origin + "/";
    return null;
  },
};

export default function Home() {
  return (
    <>
      <h1>Fresh Urquell</h1>
      <p>A minimal islands framework on Preact, rolldown and Nitro.</p>
      <Counter start={41} label="clicks" />
      <Toggle />
      <Anon />
    </>
  );
}
