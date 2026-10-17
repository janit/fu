import { h } from "preact";
import type { ShellProps } from "../../../render.ts";

export default function Shell({ ctx, children }: ShellProps<{ tenant?: string }>) {
  return h("div", { id: "shell", "data-tenant": ctx.state.tenant }, children);
}
