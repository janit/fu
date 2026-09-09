import { HttpError } from "@janit/fu";
import type { PageContext } from "@janit/fu";
import type { State } from "../state.ts";

/** Demonstrates both failure paths: a chosen status, and an unexpected throw. */
export const handlers = {
  GET(ctx: PageContext<State>) {
    if (ctx.url.searchParams.has("forbidden")) throw new HttpError(403, "Not yours");
    throw new Error("a database connection string that must never be rendered");
  },
};
