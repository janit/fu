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
    throw listenFailure(what, hostname, port, err);
  }
}

/**
 * Build a server, failing the way `listening` does. Deno binds as the server
 * is built, so a taken port throws here, before `ready()`, as a bare "Address
 * already in use" that names neither the server nor the port.
 */
export function started<S>(start: () => S, what: string, hostname: string, port: number): S {
  try {
    return start();
  } catch (err) {
    throw listenFailure(what, hostname, port, err);
  }
}

function listenFailure(what: string, hostname: string, port: number, err: unknown): Error {
  return new Error(
    `${what} could not listen on ${hostname}:${port} (${err instanceof Error ? err.message : err})`,
  );
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

/** The `ctx` a Workers runtime passes beside `env`, as far as fu's Worker uses it. */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * `waitUntil` as a Workers runtime has it: the work runs on after the
 * response, a failure is reported rather than left an unhandled rejection
 * (which ends a Node process), and stopping the server waits for what is
 * still running, within the signal's grace period.
 */
export function workerContext(): { context: WorkerContext; settled(): Promise<void> } {
  const pending = new Set<Promise<unknown>>();
  const context: WorkerContext = {
    waitUntil(promise) {
      const p = Promise.resolve(promise)
        .catch((err) => console.error("[fu] waitUntil:", err))
        .finally(() => pending.delete(p));
      pending.add(p);
    },
    passThroughOnException() {},
  };
  // Until none is left: work that is waited for may itself call waitUntil.
  const settled = async (): Promise<void> => {
    while (pending.size) await Promise.all(pending);
  };
  return { context, settled };
}

/**
 * The answer when the Worker itself fails: not the app's error page (that is
 * the app's own), but the Worker not starting, a `prepare` that threw, which
 * the next request tries again. Logged, and never cached.
 */
export function workerFailed(err: unknown): Response {
  console.error("[fu] the worker failed:", err);
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}
