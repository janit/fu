import type { PageContext } from "@janit/fu";
import type { State } from "../state.ts";

export default function ErrorPage(ctx: PageContext<State>) {
  const { status = 500, message = "Error" } = ctx.error ?? {};
  return (
    <>
      <h1>{status}</h1>
      <p id="error-message">{message}</p>
      <p>
        <a href="/">Back home</a>
      </p>
    </>
  );
}
