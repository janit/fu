// Dev driver: rolldown DevEngine (HMR patches) + crossws (transport) +
// nitro dev server (SSR). No Vite anywhere.
import { DevEngine } from "rolldown/experimental";
import { serve } from "crossws/server";
import { build as nitroBuild, createDevServer, createNitro, prepare } from "nitro/builder";
import * as fs from "node:fs";
import * as path from "node:path";
import { bootModule, css, jsx, optional, ssrModule, virtual, walk } from "./plugins.ts";
import type { FuOptions } from "./types.ts";

const HERE = import.meta.dirname!;

export async function dev(opts: FuOptions): Promise<void> {
  const root = path.resolve(opts.root);
  const port = opts.port ?? 1337;
  // Bind all interfaces so the dev server is reachable from other machines
  // and from inside containers, not just loopback.
  const hostname = opts.hostname ?? "0.0.0.0";
  const hmrPort = port + 1;
  const clientDir = path.join(root, "dist/client");
  const genDir = path.join(root, ".fu");

  const routeFiles = walk(root, path.join(root, "routes"));
  const islandFiles = walk(root, path.join(root, "islands"));

  fs.rmSync(clientDir, { recursive: true, force: true });
  fs.mkdirSync(clientDir, { recursive: true });

  const sheets = new Map<string, string>();
  const peers = new Map<string, { send(data: string): void }>();
  let cssVersion = 0;

  const writeSheets = () => {
    if (sheets.size) fs.writeFileSync(path.join(clientDir, "style.css"), [...sheets.values()].join("\n"));
  };

  // `implement` takes the runtime SOURCE, not a path — a path gets inlined
  // literally and parsed as a regex. `$ADDR` is only substituted in rolldown's
  // own default runtime, so do it here.
  const hmrRuntime = fs.readFileSync(path.join(HERE, "hmr-runtime.js"), "utf8")
    .replaceAll("$ADDR", `localhost:${hmrPort}`);

  const engine = await DevEngine.create(
    {
      input: { boot: "fu:boot" },
      plugins: [
        virtual({ "fu:boot": bootModule(path.join(HERE, "client.ts"), islandFiles, root) }),
        css(sheets),
        jsx({ hmr: true }),
      ],
      platform: "browser",
      moduleTypes: { ".css": "js" },
      experimental: { devMode: { host: "localhost", port: hmrPort, implement: hmrRuntime } },
    } as Parameters<typeof DevEngine.create>[0],
    { dir: clientDir, format: "esm", entryFileNames: "[name].js", chunkFileNames: "[name].js" },
    {
      watch: { enabled: true },
      onOutput(o) {
        if (o instanceof Error) return console.error("[fu] client build failed:", o.message);
        writeSheets();
      },
      onHmrUpdates(r) {
        if (r instanceof Error) return console.error("[fu] hmr error:", r.message);
        writeSheets();
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
    try { return new URL(raw, "http://localhost").searchParams.get("clientId"); } catch { return null; }
  };
  serve({
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
  } as Parameters<typeof serve>[0]);

  // SSR.
  fs.rmSync(genDir, { recursive: true, force: true });
  fs.mkdirSync(genDir, { recursive: true });
  const ssrEntry = path.join(genDir, "ssr.ts");
  const assets = `{ js: [{ href: "/boot.js" }], css: [{ href: "/style.css" }] }`;
  fs.writeFileSync(
    ssrEntry,
    ssrModule({
      renderPath: path.join(HERE, "render.ts"),
      routeFiles,
      root,
      assets,
      appPath: optional(root, "app.ts", "app.tsx"),
      shellPath: optional(root, "routes/_app.tsx"),
      errorPath: optional(root, "routes/_error.tsx"),
    }),
  );

  const nitro = await createNitro({
    dev: true,
    rootDir: root,
    serverDir: genDir,
    scanDirs: [],
    publicAssets: [{ dir: clientDir, baseURL: "/" }],
    handlers: [{ route: "/**", handler: ssrEntry, format: "web", lazy: false }],
    rollupConfig: {
      plugins: [css(new Map()), jsx({ stampIslands: true })],
      moduleTypes: { ".css": "js" },
    },
  } as Parameters<typeof createNitro>[0]);
  const server = createDevServer(nitro);
  server.listen({ port, hostname });
  // Order matters: listen -> prepare -> build. `build` starts the dev runner.
  await prepare(nitro);
  await nitroBuild(nitro);
  console.log(`[fu] dev http://localhost:${port} (bound ${hostname}:${port})`);
}
