// Dev driver: rolldown DevEngine (HMR patches) + crossws (transport) + a
// rolldown watch over the Worker, served by srvx (SSR). No Vite anywhere.
import { watch } from "rolldown";
import { DevEngine } from "rolldown/experimental";
import { serve } from "crossws/server";
import { serve as serveHttp } from "srvx";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  clientInput,
  emptyDir,
  runtime,
  scanProject,
  serverInput,
  writeSheets,
  writeSsrEntry,
  writeWorkerEntry,
} from "./driver.ts";
import { onlyHosts } from "./render.ts";
import type { WorkerContext, WorkerModule } from "./serve.ts";
import { assetsFromDir } from "./static.ts";
import type { AssetStore, Env, FuOptions } from "./types.ts";
import { exitOnSignal, listening } from "./lifecycle.ts";

// Where they always were, for whoever imported them from here.
export { exitOnSignal, listening };

/** Set an env var on whichever runtime we are on; `Deno.env` is Deno-only. */
function setEnv(name: string, value: string): void {
  const g = globalThis as {
    Deno?: { env: { set(k: string, v: string): void } };
    process?: { env: Record<string, string | undefined> };
  };
  if (g.Deno) g.Deno.env.set(name, value);
  else if (g.process) g.process.env[name] = value;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a page at `origin` may open the HMR socket. A browser lets any site
 * open a WebSocket to localhost, and this one streams module source on every
 * save, so only the dev server's own pages get in: its port, on a loopback
 * name or the host it was bound to. The HMR runtime dials localhost, so a page
 * on another machine never gets a working socket anyway.
 */
export function hmrOriginAllowed(origin: string | null, port: number, hostname: string): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.port !== String(port)) return false;
  return LOOPBACK.has(url.hostname) || url.hostname === hostname;
}

/** The socket's upgrade hook: a 403 for a page that may not connect, nothing otherwise. */
export function hmrUpgrade(port: number, hostname: string): (req: Request) => Response | undefined {
  return (req) =>
    hmrOriginAllowed(req.headers.get("origin"), port, hostname)
      ? undefined
      : new Response("Forbidden", { status: 403 });
}

/** One entry of what rolldown's dev engine reports after a save. */
export interface ClientUpdate {
  clientId: string;
  update: { type: string; filename?: string; code?: string; changedIds?: string[] };
}

/** Hand each connected page its update. */
export function deliverUpdates(
  updates: readonly ClientUpdate[],
  peers: ReadonlyMap<string, { send(data: string): void }>,
  io: {
    write(filename: string, code: string): void;
    delivered(filename: string): void;
    cssHref(): string;
  },
): void {
  for (const { clientId, update } of updates) {
    const peer = peers.get(clientId);
    if (!peer || update.type === "Noop") continue;
    if (update.type === "FullReload" || !update.filename) {
      peer.send(JSON.stringify({ type: "hmr:reload" }));
      continue;
    }
    // Always deliver the patch for real. Reporting a payload as delivered
    // when it was not corrupts per-client shipped-state and updates stop
    // firing silently.
    io.write(update.filename, update.code ?? "");
    peer.send(JSON.stringify({
      type: "hmr:update",
      url: "/" + update.filename,
      changedIds: update.changedIds,
    }));
    io.delivered(update.filename);
    if ((update.changedIds ?? []).some((id) => id.endsWith(".css"))) {
      peer.send(JSON.stringify({ type: "fu:css", href: io.cssHref() }));
    }
  }
}

/**
 * The client's sheets that are still imported. The dev engine reports patches,
 * never its module graph, so the client collection keeps a sheet whose import
 * was removed. The server build does prune (see `css`), and it sees every
 * island a route renders: a sheet it once held and holds no longer is stale.
 * `seen` remembers what the server has held, across calls.
 */
export function liveClientSheets(
  server: ReadonlyMap<string, string>,
  client: ReadonlyMap<string, string>,
  seen: Set<string>,
): Map<string, string> {
  for (const id of server.keys()) seen.add(id);
  return new Map([...client].filter(([id]) => server.has(id) || !seen.has(id)));
}

/**
 * The latest dev build of the Worker, loaded. Each rebuild is written to the
 * same file and imported under a new query string, so the runtime loads it
 * afresh; requests go to the newest module that loaded, and one that fails to
 * load leaves the previous one serving. The old module graphs are not freed:
 * the runtime keeps every module it ever loaded, so a long session grows.
 */
export class DevWorker {
  #current: WorkerModule | null = null;
  #version = 0;
  #applied = 0;
  readonly #file: string;
  readonly #load: (url: string) => Promise<unknown>;

  constructor(file: string, load: (url: string) => Promise<unknown> = (url) => import(url)) {
    this.#file = file;
    this.#load = load;
  }

  /**
   * Load what was just written. Resolves once requests go to it, or rejects
   * and changes nothing. Loads can finish out of order (two quick saves, the
   * first a bigger graph), so an older one never replaces a newer.
   */
  async reload(): Promise<void> {
    const version = ++this.#version;
    const loaded = await this.#load(`${pathToFileURL(this.#file).href}?v=${version}`);
    if (version < this.#applied) return;
    this.#applied = version;
    this.#current = (loaded as { default: WorkerModule }).default;
  }

  /**
   * The module to answer with: the latest that loaded. Until one has, a
   * Worker that answers every request with a 500 saying so: the build error
   * is in the terminal, and a request left hanging would say nothing.
   */
  get current(): WorkerModule {
    return this.#current ?? NOT_BUILT;
  }
}

const NOT_BUILT: WorkerModule = {
  fetch: () =>
    new Response("fu dev: the server has not built yet; the error is in the terminal.\n", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    }),
};

/**
 * The dev server's answer to a request: a client file from `/` when there is
 * one (the HMR runtime loads modules by their plain names), else the Worker.
 * Client files are never cached: their names do not change when they do.
 */
export function devFetch(
  clientFiles: AssetStore,
  worker: () => WorkerModule,
  env: Env,
  ctx: WorkerContext,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "GET" || req.method === "HEAD") {
      const file = await clientFiles.fetch(req);
      if (file.status === 200 || file.status === 304) {
        const headers = new Headers(file.headers);
        headers.set("cache-control", "no-cache");
        return new Response(file.body, { status: file.status, headers });
      }
      await file.body?.cancel();
    }
    return worker().fetch(req, env, ctx);
  };
}

/** How long shutdown waits for the dev server to close before going on without it. */
const SERVER_CLOSE_MS = 250;

/** Addresses that mean "every interface", where any Host name may be legitimate. */
const ANY = new Set(["0.0.0.0", "::", "[::]"]);

export async function dev(opts: FuOptions): Promise<void> {
  const project = scanProject(opts.root);
  const { clientDir } = project;
  const port = opts.port ?? 1337;
  // Loopback unless told otherwise: the dev server hands out source and stack
  // traces, which is not for everyone on the network. `--host 0.0.0.0` opens
  // it up, for a container or a phone on the same LAN.
  const hostname = opts.hostname ?? "127.0.0.1";
  const hmrPort = port + 1;
  // An app cannot otherwise tell dev from production: nothing in the
  // environment says so, and the same middleware runs in both. Anything that
  // must be laxer in dev — a CSP that has to allow the HMR socket on
  // `hmrPort`, a verbose error page — reads this.
  setEnv("FU_DEV", "1");

  // Registered before anything is started, so a signal during startup stops
  // whatever is up by then.
  const closers: (() => Promise<unknown>)[] = [];
  exitOnSignal(() => Promise.allSettled(closers.map((close) => close())));

  emptyDir(clientDir);
  const serverSheets = new Map<string, string>();
  const clientSheets = new Map<string, string>();
  const peers = new Map<
    string,
    { send(data: string): void; terminate(): void; close(): void }
  >();
  // Open pages first: a server asked to close waits for its sockets to go,
  // and a page never hangs up by itself.
  closers.push(() => {
    for (const peer of peers.values()) {
      try {
        peer.terminate();
      } catch {
        // Deno's sockets have no terminate(); closing is the nearest thing.
        peer.close();
      }
    }
    return Promise.resolve();
  });
  let cssVersion = 0;
  const serverSeen = new Set<string>();
  const flushCss = () =>
    writeSheets(
      clientDir,
      [serverSheets, liveClientSheets(serverSheets, clientSheets, serverSeen)],
      "style.css",
    );
  const cssHref = () => `/style.css?v=${++cssVersion}`;

  // `implement` takes the runtime SOURCE, not a path — a path gets inlined
  // literally and parsed as a regex. `$ADDR` is only substituted in rolldown's
  // own default runtime, so do it here.
  const hmrRuntime = fs.readFileSync(runtime.hmr, "utf8").replaceAll(
    "$ADDR",
    `localhost:${hmrPort}`,
  );

  const engine = await DevEngine.create(
    {
      ...clientInput(project, clientSheets, true),
      experimental: { devMode: { host: "localhost", port: hmrPort, implement: hmrRuntime } },
    } as Parameters<typeof DevEngine.create>[0],
    { dir: clientDir, format: "esm", entryFileNames: "[name].js", chunkFileNames: "[name].js" },
    {
      watch: { enabled: true },
      // A patch updates the open page, not the bundle on disk. Without a
      // rebuild after it, the next reload would hydrate the page's new markup
      // with the code from before the edit.
      rebuildStrategy: "always",
      onOutput(o) {
        if (o instanceof Error) return console.error("[fu] client build failed:", o.message);
        flushCss();
      },
      onHmrUpdates(r) {
        if (r instanceof Error) return console.error("[fu] hmr error:", r.message);
        flushCss();
        deliverUpdates(r.updates as ClientUpdate[], peers, {
          write: (file, code) => fs.writeFileSync(path.join(clientDir, file), code),
          delivered: (file) => engine.notifyPayloadDelivered(file),
          cssHref,
        });
      },
    },
  );
  closers.push(() => engine.close());
  await engine.run();
  await engine.ensureLatestBuildOutput();

  // Transport. Inline hooks behave uniformly across node/deno/bun; returning a
  // plain `{crossws}` object from `fetch` fails on Deno.
  const clientIdOf = (peer: { request?: { url?: string } }): string | null => {
    const raw = peer?.request?.url;
    if (!raw) return null;
    try {
      return new URL(raw, "http://localhost").searchParams.get("clientId");
    } catch {
      return null;
    }
  };
  const socket = serve(
    {
      port: hmrPort,
      hostname,
      fetch: () => new Response("fu hmr"),
      // Its handler would close this socket alone, after waiting up to five
      // seconds for open pages to hang up; exitOnSignal stops everything.
      gracefulShutdown: false,
      websocket: {
        upgrade: hmrUpgrade(port, hostname),
        async open(peer) {
          const id = clientIdOf(peer as never);
          if (!id) return;
          peers.set(id, peer as never);
          await engine.registerClient(id);
          (peer as never as { send(d: string): void }).send(JSON.stringify({ type: "connected" }));
        },
        async close(peer) {
          const id = clientIdOf(peer as never);
          if (!id) return;
          peers.delete(id);
          await engine.removeClient(id);
        },
      },
    } as Parameters<typeof serve>[0],
  );
  // `true`: open pages hold the socket, and they are not asked first.
  closers.push(() => socket.close(true));
  await listening(socket, "the HMR socket (it takes the port above --port)", hostname, hmrPort);

  // SSR: the Worker, as a build makes it, rebuilt on every save.
  writeSsrEntry(
    project,
    { js: [{ href: "/boot.js" }], css: [{ href: "/style.css" }] },
    { devCssFile: path.join(clientDir, "style.css") },
  );
  const workerEntry = writeWorkerEntry(project);
  const devFile = path.join(project.genDir, "dev", "worker.mjs");
  const worker = new DevWorker(devFile);
  // CSS that only a route or the shell imports is seen by the server build
  // alone, so that build flushes /style.css too, and tells every open page:
  // the client engine has no update to send for a file it never bundled.
  const onCss = () => {
    flushCss();
    const swap = JSON.stringify({ type: "fu:css", href: cssHref() });
    for (const peer of peers.values()) peer.send(swap);
  };
  let failed = false;
  // The first build, whichever way it ends: the server listens either way.
  let firstBuilt!: () => void;
  const firstBuild = new Promise<void>((resolve) => firstBuilt = resolve);
  const watcher = watch({
    ...serverInput(project, workerEntry, { sheets: serverSheets, onCss, dev: true }),
    output: { file: devFile, format: "esm", codeSplitting: false },
    logLevel: "warn",
  });
  closers.push(() => watcher.close());
  watcher.on("event", async (event) => {
    if (event.code === "ERROR") {
      failed = true;
      console.error("[fu] server build failed:", event.error.message);
      await event.result.close();
      firstBuilt();
    } else if (event.code === "BUNDLE_END") {
      await event.result.close();
      try {
        await worker.reload();
        if (failed) console.log("[fu] server build fixed");
        failed = false;
      } catch (err) {
        console.error("[fu] the server build does not load:", err);
      }
      firstBuilt();
    }
  });

  const clientFiles = assetsFromDir(clientDir);
  const env: Env = { ...process.env, ASSETS: clientFiles };
  const context: WorkerContext = {
    waitUntil: (p) => void Promise.resolve(p).catch((err) => console.error("[fu] waitUntil:", err)),
    passThroughOnException() {},
  };
  const answer = devFetch(clientFiles, () => worker.current, env, context);
  const guarded = ANY.has(hostname) ? answer : onlyHosts(answer, [...LOOPBACK, hostname]);
  const server = serveHttp({
    port,
    hostname,
    silent: true,
    // exitOnSignal stops everything; srvx's own handler would stop this alone.
    gracefulShutdown: false,
    fetch: (req: Request) => guarded(req),
  });
  // By force, and not waited for beyond a moment: Deno's server finishes the
  // requests it is answering first, and has no way to be told otherwise, so
  // a slow one would hold the exit for the whole grace period. Nothing of it
  // outlives the process.
  closers.unshift(() =>
    Promise.race([server.close(true), new Promise((r) => setTimeout(r, SERVER_CLOSE_MS))])
  );
  await listening(server, "the dev server", hostname, port);
  await firstBuild;
  console.log(`[fu] dev http://localhost:${port} (bound ${hostname}:${port})`);
}
