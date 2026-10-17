// Production driver: rolldown builds the client, the Worker and its runner.
import { rolldown } from "rolldown";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  clientFileUrls,
  clientInput,
  cssInput,
  emptyDir,
  runnerModule,
  scanProject,
  serverInput,
  writeGenerated,
  writeSheets,
  writeSsrEntry,
  writeWorkerEntry,
} from "./driver.ts";
import type { FuOptions } from "./types.ts";

/** URL prefix of the built client files. */
const ASSETS = "/_fu/";

/**
 * An earlier build's hashed files would ship with this one if left in place.
 * The default dir is ours and goes whole. In any other dir only what this
 * build is about to write is cleared: it may hold the app's own files.
 */
export function clearOutput(outDir: string, ours: boolean): void {
  if (ours) {
    fs.rmSync(outDir, { recursive: true, force: true });
    return;
  }
  for (const sub of ["public" + ASSETS, "server"]) {
    fs.rmSync(path.join(outDir, sub), { recursive: true, force: true });
  }
}

/** What a build wrote. */
export interface BuildResult {
  /** The Worker: `main` in wrangler.jsonc. */
  worker: string;
  /** The runner for Node, Deno and Bun. */
  runner: string;
  /** The asset directory: `assets.directory` in wrangler.jsonc. */
  publicDir: string;
}

/** What the preload plan needs to know of a chunk rolldown wrote. */
export interface ChunkImports {
  fileName: string;
  /** Chunks imported statically: fetched as soon as this one is parsed. */
  imports: string[];
}

/**
 * The chunks `file` pulls in by static import, transitively, in the order met.
 * Those are the ones a browser fetches one round trip at a time unless told of
 * them up front. A dynamic import is not followed: that chunk is wanted later,
 * or never. Chunks in `skip` (and `file` itself) are left out and not looked
 * into: what the page has already. An import that is no chunk of this build
 * (an external) is not a file to preload.
 */
export function staticClosure(
  chunks: readonly ChunkImports[],
  file: string,
  skip: ReadonlySet<string>,
): string[] {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const seen = new Set([file]);
  const out: string[] = [];
  const walk = (name: string): void => {
    for (const dep of byName.get(name)?.imports ?? []) {
      if (seen.has(dep) || skip.has(dep) || !byName.has(dep)) continue;
      seen.add(dep);
      out.push(dep);
      walk(dep);
    }
  };
  walk(file);
  return out;
}

export async function build(opts: FuOptions): Promise<BuildResult> {
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
  // A chunk imported statically is discovered only once its importer has been
  // fetched and parsed: one more round trip each, before anything hydrates.
  // Preloading overlaps that, but only for what a page will run. Every page
  // runs the entry, so what the entry imports statically is announced on all
  // of them. An island's chunk is a dynamic import of the entry; a page
  // announces the chunks of the islands it rendered, each with its own static
  // imports. What is reached by dynamic import alone (a library an island
  // loads on demand, the navigation runtime) is announced nowhere.
  const chunks = result.output.filter((o) => o.type === "chunk");
  const href = (fileName: string): string => ASSETS + fileName;
  const always = staticClosure(chunks, entry.fileName, new Set());
  const have = new Set([entry.fileName, ...always]);
  writeSsrEntry(project, {
    js: [{ href: href(entry.fileName) }],
    css: cssFile ? [{ href: ASSETS + cssFile }] : [],
    preload: always.map((f) => ({ href: href(f) })),
    islands: Object.fromEntries(
      chunks.flatMap((o) => {
        if (!o.isDynamicEntry || !o.facadeModuleId) return [];
        const file = "/" +
          path.relative(project.root, o.facadeModuleId.split("?")[0]).split(path.sep).join("/");
        if (!file.startsWith("/islands/")) return [];
        return [[file, [o.fileName, ...staticClosure(chunks, o.fileName, have)].map(href)]];
      }),
    ),
  }, { clientFiles: { prefix: ASSETS, files: clientFileUrls(project.clientDir, ASSETS) } });
  const workerEntry = writeWorkerEntry(project);
  const publicDir = path.join(outDir, "public");
  fs.cpSync(project.clientDir, path.join(publicDir, ASSETS), { recursive: true });

  // One file: the app graph is a dynamic import of the entry, which rolldown
  // inlines as a lazily initialised module, so nothing of the app runs before
  // `prepare` has (see workerModule).
  const worker = path.join(outDir, "server", "index.mjs");
  const server = await rolldown(serverInput(project, workerEntry));
  await server.write({ file: worker, format: "esm", codeSplitting: false, minify: true });
  await server.close();

  // The runner imports the Worker rather than containing it, so that what
  // runs on Node is the file celld would run.
  const runner = path.join(outDir, "server", "serve.mjs");
  const serve = await rolldown({
    input: writeGenerated(project, "serve.ts", runnerModule()),
    platform: "node",
    external: [/^node:/, "./index.mjs"],
    logLevel: "warn",
  });
  await serve.write({ file: runner, format: "esm", codeSplitting: false });
  await serve.close();

  const rel = (p: string) => path.relative(project.root, p).split(path.sep).join("/") || ".";
  console.log(`[fu] built ${rel(worker)} and its runner ${rel(runner)}`);
  console.log(
    `[fu] for celld, in wrangler.jsonc: "main": ${JSON.stringify(rel(worker))}, "assets": ` +
      `{ "directory": ${JSON.stringify(rel(publicDir))}, "binding": "ASSETS", ` +
      `"run_worker_first": ["/_fu/*"] }`,
  );
  return { worker, runner, publicDir };
}
