import type { ShellProps } from "@janit/fu";
import type { State } from "../state.ts";

/**
 * Wraps every page. `<head>` is assembled by the framework from ctx.head, so
 * this is only the surrounding body markup.
 */
export default function Shell({ ctx, children }: ShellProps<State>) {
  return (
    <div class="shell">
      <header>
        <a href="/">Fresh Urquell</a>
        <small>tenant: {ctx.state.tenant} · req: {ctx.state.requestId}</small>
      </header>
      <main>{children}</main>
      <footer>
        <a href="/about">about</a> · <a href="/blog/hello-world">a post</a> ·{" "}
        <a href="/files/deep/nested/path">wildcard</a> · <a href="/old-about">redirect</a>
      </footer>
    </div>
  );
}
