// Production driver: rolldown builds the client, nitro builds the server.
import { rolldown } from "rolldown";
import { build as nitroBuild, copyPublicAssets, createNitro } from "nitro/builder";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import {
  clientInput,
  cssInput,
  emptyDir,
  nitroOptions,
  scanProject,
  writeSheets,
  writeSsrEntry,
} from "./driver.ts";
import type { FuOptions } from "./types.ts";

/** URL prefix of the built client files. */
const ASSETS = "/_fu/";

/**
 * Nitro writes into the output dir without clearing it, so an earlier build's
 * hashed assets, or a deno.json from another preset, would ship with this one.
 * The default dir is ours, and so is one nitro made (it leaves nitro.json, but
 * only at the very end, so a build that died half-way has none). In any other
 * dir only what this build is about to write is cleared.
 */
export function clearOutput(outDir: string, ours: boolean): void {
  if (ours || fs.existsSync(path.join(outDir, "nitro.json"))) {
    fs.rmSync(outDir, { recursive: true, force: true });
    return;
  }
  for (const sub of ["public" + ASSETS, "server"]) {
    fs.rmSync(path.join(outDir, sub), { recursive: true, force: true });
  }
}

/**
 * Nitro would pick a preset from whichever runtime runs the build, and its
 * deno-server output calls Deno.serve, so `node .output/...` crashes on a
 * Deno-built artefact. node-server runs on Node, Bun and Deno alike. A
 * NITRO_PRESET in the environment still wins, for a platform preset: nitro
 * reads it itself, so the option is simply left out.
 */
export function presetOption(fromEnv: string | undefined): { preset?: string } {
  return fromEnv ? {} : { preset: "node-server" };
}

export async function build(opts: FuOptions): Promise<void> {
  const project = scanProject(opts.root);
  const outDir = opts.outDir ? path.resolve(opts.outDir) : path.join(project.root, ".output");

  clearOutput(outDir, !opts.outDir);

  // ---- css ----
  // The stylesheet's hashed name goes into the server entry, but routes and the
  // shell import CSS only the server bundle would see. So walk the server entry
  // points first, just for their CSS; islands' CSS joins during the client build.
  const serverSheets = new Map<string, string>();
  const clientSheets = new Map<string, string>();
  const scan = await rolldown(cssInput(project, serverSheets));
  await scan.generate({ format: "esm" });
  await scan.close();

  // ---- client ----
  emptyDir(project.clientDir);
  const bundle = await rolldown(clientInput(project, clientSheets));
  const result = await bundle.write({
    dir: project.clientDir,
    format: "esm",
    entryFileNames: "[name]-[hash].js",
    chunkFileNames: "[name]-[hash].js",
    minify: true,
  });
  await bundle.close();

  const entry = result.output.find((o) => o.type === "chunk" && o.isEntry);
  if (!entry) throw new Error("fu: client build produced no entry chunk");
  const cssFile = writeSheets(project.clientDir, [serverSheets, clientSheets]);

  // ---- server ----
  // Shared chunks (preact, the JSX runtime) are imported by the islands, so the
  // browser would only discover them after fetching an island: one more round
  // trip before anything hydrates. Preloading them overlaps that.
  const shared = result.output.filter((o) => o.type === "chunk" && !o.isEntry && !o.isDynamicEntry);
  const ssrEntry = writeSsrEntry(project, {
    js: [{ href: ASSETS + entry.fileName }],
    css: cssFile ? [{ href: ASSETS + cssFile }] : [],
    preload: shared.map((c) => ({ href: ASSETS + c.fileName })),
    // An island's own chunk is a dynamic import of the entry, so the browser
    // would only ask for it once the entry had run. Each page preloads the
    // chunks of the islands it rendered.
    islands: Object.fromEntries(
      result.output.flatMap((o) => {
        if (o.type !== "chunk" || !o.isDynamicEntry || !o.facadeModuleId) return [];
        const file = "/" +
          path.relative(project.root, o.facadeModuleId.split("?")[0]).split(path.sep).join("/");
        return file.startsWith("/islands/") ? [[file, ASSETS + o.fileName]] : [];
      }),
    ),
  }, { assetsPrefix: ASSETS });
  const nitro = await createNitro({
    ...nitroOptions(project, ssrEntry),
    ...presetOption(process.env.NITRO_PRESET),
    output: { dir: outDir },
    // Every client file name carries a content hash, so it never changes under
    // the same URL and may be cached for good. Nitro sends max-age only for a
    // dir mounted below the root (one at `/` falls through to the app), hence
    // the prefix. Dev names are not hashed, so dev keeps serving from `/`.
    publicAssets: [{ dir: project.clientDir, baseURL: ASSETS, maxAge: 31536000 }],
    // That max-age becomes a route rule on everything under the prefix, set
    // after the handler answers, so the generated entry refuses to answer
    // there at all (see ssrModule).
    compressPublicAssets: true,
  });
  await copyPublicAssets(nitro);
  await nitroBuild(nitro);
}
