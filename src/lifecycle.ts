// Starting and stopping a server process, shared by fu dev and serve.mjs.
// No bundler here: serve.mjs bundles this file.
import process from "node:process";

/**
 * Wait until a server is listening, or fail saying which one could not. Node
 * reports a failed listen out of band and carries on, so without this the dev
 * server would announce an address nothing answers on, or serve pages with
 * hot reload silently dead.
 */
export async function listening(
  server: { ready(): Promise<unknown> },
  what: string,
  hostname: string,
  port: number,
): Promise<void> {
  try {
    await server.ready();
  } catch (err) {
    throw new Error(
      `${what} could not listen on ${hostname}:${port} (${
        err instanceof Error ? err.message : err
      })`,
    );
  }
}

/**
 * End the process on SIGINT and SIGTERM: run `close`, then exit with code 0.
 *
 * Nothing else would. The servers and the file watchers each keep the
 * process alive, and once any signal handler is registered the
 * runtime no longer dies on the signal by itself. (That is how the dev server
 * came to ignore SIGTERM: the HMR socket's server registered one, to close
 * that one socket.)
 *
 * `close` gets `graceMs` to finish and is not waited for beyond it; a second
 * signal ends the process at once.
 */
export function exitOnSignal(
  close: () => Promise<unknown>,
  graceMs = 2000,
  proc: {
    on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    exit(code: number): void;
  } = process,
): void {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return proc.exit(0);
    stopping = true;
    const timer = setTimeout(() => proc.exit(0), graceMs);
    // Through a promise, so a `close` that throws before returning one is a
    // rejection like any other and the process still ends.
    Promise.resolve().then(close).catch((err) => console.error("[fu] while stopping:", err))
      .finally(() => {
        clearTimeout(timer);
        proc.exit(0);
      });
  };
  proc.on("SIGINT", stop);
  proc.on("SIGTERM", stop);
}
