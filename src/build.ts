// Production driver: rolldown builds the client, nitro builds the server.
import { rolldown } from "rolldown";
import { build as nitroBuild, copyPublicAssets, createNitro } from "nitro/builder";
import * as path from "node:path";
import {
  clientInput,
  emptyDir,
  nitroOptions,
  scanProject,
  writeSheets,
  writeSsrEntry,
} from "./driver.ts";
import type { FuOptions } from "./types.ts";

export async function build(opts: FuOptions): Promise<void> {
  const project = scanProject(opts.root);
  const outDir = opts.outDir ? path.resolve(opts.outDir) : path.join(project.root, ".output");

  // ---- client ----
  emptyDir(project.clientDir);
  const sheets = new Map<string, string>();
  const bundle = await rolldown(clientInput(project, sheets));
  const result = await bundle.write({
    dir: project.clientDir,
    format: "esm",
    entryFileNames: "[name]-[hash].js",
    chunkFileNames: "[name]-[hash].js",
  });
  await bundle.close();

  const entry = result.output.find((o) => o.type === "chunk" && o.isEntry);
  if (!entry) throw new Error("fu: client build produced no entry chunk");
  const cssFile = writeSheets(project.clientDir, sheets);

  // ---- server ----
  const ssrEntry = writeSsrEntry(project, {
    js: [{ href: "/" + entry.fileName }],
    css: cssFile ? [{ href: "/" + cssFile }] : [],
  });
  const nitro = await createNitro({ ...nitroOptions(project, ssrEntry), output: { dir: outDir } });
  await copyPublicAssets(nitro);
  await nitroBuild(nitro);
}
