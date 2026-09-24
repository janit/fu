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

export async function build(opts: FuOptions): Promise<void> {
  const project = scanProject(opts.root);
  const outDir = opts.outDir ? path.resolve(opts.outDir) : path.join(project.root, ".output");

  // Nitro writes into the output dir without clearing it, so an earlier
  // build's hashed assets, or a deno.json from another preset, would ship with
  // this one. Only a dir nitro made (it leaves nitro.json) is cleared.
  if (fs.existsSync(path.join(outDir, "nitro.json"))) fs.rmSync(outDir, { recursive: true });

  // ---- css ----
  // The stylesheet's hashed name goes into the server entry, but routes and the
  // shell import CSS only the server bundle would see. So walk the server entry
  // points first, just for their CSS; islands' CSS joins during the client build.
  const sheets = new Map<string, string>();
  const scan = await rolldown(cssInput(project, sheets));
  await scan.generate({ format: "esm" });
  await scan.close();

  // ---- client ----
  emptyDir(project.clientDir);
  const bundle = await rolldown(clientInput(project, sheets));
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
  const cssFile = writeSheets(project.clientDir, sheets);

  // ---- server ----
  // Shared chunks (preact, the JSX runtime) are imported by the islands, so the
  // browser would only discover them after fetching an island: one more round
  // trip before anything hydrates. Preloading them overlaps that.
  const shared = result.output.filter((o) => o.type === "chunk" && !o.isEntry && !o.isDynamicEntry);
  const ssrEntry = writeSsrEntry(project, {
    js: [{ href: ASSETS + entry.fileName }],
    css: cssFile ? [{ href: ASSETS + cssFile }] : [],
    preload: shared.map((c) => ({ href: ASSETS + c.fileName })),
  });
  const nitro = await createNitro({
    ...nitroOptions(project, ssrEntry),
    // Nitro would pick a preset from whichever runtime runs the build, and its
    // deno-server output calls Deno.serve, so `node .output/...` crashes on a
    // Deno-built artefact. node-server runs on Node, Bun and Deno alike.
    // NITRO_PRESET still overrides, for a platform preset.
    ...(process.env.NITRO_PRESET ? {} : { preset: "node-server" }),
    output: { dir: outDir },
    // Every client file name carries a content hash, so it never changes under
    // the same URL and may be cached for good. Nitro sends max-age only for a
    // dir mounted below the root (one at `/` falls through to the app), hence
    // the prefix. Dev names are not hashed, so dev keeps serving from `/`.
    publicAssets: [{ dir: project.clientDir, baseURL: ASSETS, maxAge: 31536000 }],
    // That max-age is a route rule on everything under the prefix, applied
    // after the app answers. The bare prefix itself is not a file, so nitro
    // hands it to the app, whose 404 would then be cached for a year. An
    // exact rule outranks the wildcard.
    routeRules: Object.fromEntries(
      [ASSETS, ASSETS.slice(0, -1)].map((p) => [p, { headers: { "cache-control": "no-store" } }]),
    ),
    compressPublicAssets: true,
  });
  await copyPublicAssets(nitro);
  await nitroBuild(nitro);
}
