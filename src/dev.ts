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

export async function dev(opts: FuOptions): Promise<void> {
  const project = scanProject(opts.root);
  const { clientDir } = project;
  const port = opts.port ?? 1337;
  // Bind all interfaces so the dev server is reachable from other machines
  // and from inside containers, not just loopback.
  const hostname = opts.hostname ?? "0.0.0.0";
  const hmrPort = port + 1;

  emptyDir(clientDir);
  const sheets = new Map<string, string>();
  const peers = new Map<string, { send(data: string): void }>();
  let cssVersion = 0;
  const flushCss = () => writeSheets(clientDir, sheets, "style.css");

  // `implement` takes the runtime SOURCE, not a path — a path gets inlined
  // literally and parsed as a regex. `$ADDR` is only substituted in rolldown's
  // own default runtime, so do it here.
  const hmrRuntime = fs.readFileSync(runtime.hmr, "utf8").replaceAll(
    "$ADDR",
    `localhost:${hmrPort}`,
  );

  const engine = await DevEngine.create(
    {
      ...clientInput(project, sheets, true),
      experimental: { devMode: { host: "localhost", port: hmrPort, implement: hmrRuntime } },
    } as Parameters<typeof DevEngine.create>[0],
    { dir: clientDir, format: "esm", entryFileNames: "[name].js", chunkFileNames: "[name].js" },
    {
      watch: { enabled: true },
      onOutput(o) {
        if (o instanceof Error) return console.error("[fu] client build failed:", o.message);
        flushCss();
      },
      onHmrUpdates(r) {
        if (r instanceof Error) return console.error("[fu] hmr error:", r.message);
        flushCss();
        for (const { clientId, update } of r.updates) {
          const peer = peers.get(clientId);
          if (!peer || update.type === "Noop") continue;
          if (update.type === "FullReload") {
            peer.send(JSON.stringify({ type: "hmr:reload" }));
            continue;
          }
          // Always deliver the patch for real. Reporting a payload as delivered
          // when it was not corrupts per-client shipped-state and updates stop
          // firing silently.
          fs.writeFileSync(path.join(clientDir, update.filename), update.code);
          peer.send(JSON.stringify({
            type: "hmr:update",
            path: "/" + update.filename,
            url: "/" + update.filename,
            changedIds: update.changedIds,
          }));
          engine.notifyPayloadDelivered(update.filename);
          if ((update.changedIds ?? []).some((id) => id.endsWith(".css"))) {
            peer.send(JSON.stringify({ type: "fu:css", href: `/style.css?v=${++cssVersion}` }));
          }
        }
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
  serve(
    {
      port: hmrPort,
      fetch: () => new Response("fu hmr"),
      websocket: {
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

  // SSR.
  const ssrEntry = writeSsrEntry(project, {
    js: [{ href: "/boot.js" }],
    css: [{ href: "/style.css" }],
  });
  const nitro = await createNitro({ ...nitroOptions(project, ssrEntry), dev: true });
  const server = createDevServer(nitro);
  server.listen({ port, hostname });
  // Order matters: listen -> prepare -> build. `build` starts the dev runner.
  await prepare(nitro);
  await nitroBuild(nitro);
  console.log(`[fu] dev http://localhost:${port} (bound ${hostname}:${port})`);
}
