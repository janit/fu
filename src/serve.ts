// A built Worker served from Node, Deno or Bun: what celld does with it, as far
// as the app can tell. The same module runs in both places, so there is one
// code path and it is the Worker's. Bundled into `.output/server/serve.mjs`.
import { serve as serveBun } from "srvx/bun";
import { serve as serveDeno } from "srvx/deno";
import { serve as serveNode } from "srvx/node";
import process from "node:process";
import { exitOnSignal, listening } from "./lifecycle.ts";
import { assetsFromDir } from "./static.ts";
import type { Env } from "./types.ts";

/** The `ctx` a Workers runtime passes beside `env`, as far as fu's Worker uses it. */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** What `.output/server/index.mjs` exports by default. */
export interface WorkerModule {
  fetch(request: Request, env: Env, ctx: WorkerContext): Response | Promise<Response>;
}

export interface ServeOptions {
  /** Directory handed to the app as `env.ASSETS` (and so `ctx.assets`). Default: none. */
  publicDir?: string;
  /** Default: `PORT` from the environment, else 3000. */
  port?: number;
  /** Default: `HOST` from the environment, else every interface. */
  hostname?: string;
  /** The Worker's `env`. Default: the process environment. `ASSETS` is added when `publicDir` is given. */
  env?: Env;
  /** End the process on SIGINT and SIGTERM. Default: true. */
  exitOnSignal?: boolean;
}

export interface Served {
  /** Where it listens, e.g. `http://127.0.0.1:3000/`. */
  url: string;
  close(): Promise<void>;
}

/**
 * `waitUntil` as a Workers runtime has it: the work runs on after the
 * response, a failure is reported rather than left an unhandled rejection
 * (which ends a Node process), and stopping the server waits for what is
 * still running, within the signal's grace period.
 */
function workerContext(): { context: WorkerContext; settled(): Promise<unknown> } {
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
  return { context, settled: () => Promise.all(pending) };
}

/**
 * The port from `PORT`, digits only (Number() also takes "0x50", "1e3" and
 * " 80"), so a typo is an error naming PORT and not a listen failure naming
 * nothing, or a random port.
 */
function envPort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 3000;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new Error(`PORT must be a port number, not ${JSON.stringify(raw)}`);
  }
  return port;
}

/** srvx's adapter for the runtime this runs on: each serves with its own native server. */
function adapter(): typeof serveNode {
  const g = globalThis as { Deno?: unknown; Bun?: unknown };
  if (g.Bun) return serveBun as unknown as typeof serveNode;
  if (g.Deno) return serveDeno as unknown as typeof serveNode;
  return serveNode;
}

/** Serve `worker` over HTTP until the process is told to stop. */
export async function serveWorker(worker: WorkerModule, opts: ServeOptions = {}): Promise<Served> {
  const port = opts.port ?? envPort(process.env.PORT);
  // An empty HOST means every interface, but srvx reads HOST itself when given
  // no hostname, and Deno refuses an empty one: so name the wildcard.
  const hostname = opts.hostname ?? (process.env.HOST === "" ? "0.0.0.0" : process.env.HOST);
  const { context, settled } = workerContext();
  const env: Env = {
    ...(opts.env ?? { ...process.env }),
    ...(opts.publicDir ? { ASSETS: assetsFromDir(opts.publicDir) } : {}),
  };
  const server = adapter()({
    port,
    hostname,
    silent: true,
    // exitOnSignal below stops the server and the process together.
    gracefulShutdown: false,
    async fetch(request: Request): Promise<Response> {
      try {
        return await worker.fetch(request, env, context);
      } catch (err) {
        // The app's own failures are its error page; this is the Worker not
        // starting (a `prepare` that threw), which the next request retries.
        console.error("[fu] the worker failed:", err);
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
        });
      }
    },
  });
  const close = async (): Promise<void> => {
    await server.close(true);
    await settled();
  };
  if (opts.exitOnSignal !== false) exitOnSignal(close);
  await listening(server, "the server", hostname ?? "*", port);
  const url = server.url ?? `http://${hostname ?? "localhost"}:${port}/`;
  return { url, close };
}
