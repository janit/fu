// Dev driver: rolldown DevEngine (HMR patches) + crossws (transport) +
// nitro dev server (SSR). No Vite anywhere.
import { DevEngine } from "rolldown/experimental";
import { serve } from "crossws/server";
import { build as nitroBuild, createDevServer, createNitro, prepare } from "nitro/builder";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  clientInput,
  emptyDir,
  nitroOptions,
  runtime,
  scanProject,
  writeSheets,
  writeSsrEntry,
} from "./driver.ts";
import type { FuOptions } from "./types.ts";

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

  emptyDir(clientDir);
  const serverSheets = new Map<string, string>();
  const clientSheets = new Map<string, string>();
  const peers = new Map<string, { send(data: string): void }>();
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
  await listening(socket, "the HMR socket (it takes the port above --port)", hostname, hmrPort);

  // SSR.
  const ssrEntry = writeSsrEntry(
    project,
    { js: [{ href: "/boot.js" }], css: [{ href: "/style.css" }] },
    { hosts: ANY.has(hostname) ? undefined : [...LOOPBACK, hostname] },
  );
  // CSS that only a route or the shell imports is seen by the server build
  // alone, so that build flushes /style.css too, and tells every open page:
  // the client engine has no update to send for a file it never bundled.
  const nitro = await createNitro({
    ...nitroOptions(project, ssrEntry, serverSheets, () => {
      flushCss();
      const swap = JSON.stringify({ type: "fu:css", href: cssHref() });
      for (const peer of peers.values()) peer.send(swap);
    }),
    dev: true,
  });
  const server = createDevServer(nitro).listen({ port, hostname });
  await listening(server, "the dev server", hostname, port);
  // Order matters: listen -> prepare -> build. `build` starts the dev runner.
  await prepare(nitro);
  await nitroBuild(nitro);
  console.log(`[fu] dev http://localhost:${port} (bound ${hostname}:${port})`);
}
