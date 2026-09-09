// Production driver: rolldown builds the client, nitro builds the server.
import { rolldown } from "rolldown";
import { build as nitroBuild, copyPublicAssets, createNitro } from "nitro/builder";
import * as fs from "node:fs";
import * as path from "node:path";
import { bootModule, css, jsx, optional, ssrModule, virtual, walk } from "./plugins.ts";
import type { FuOptions } from "./types.ts";

const HERE = import.meta.dirname!;

export async function build(opts: FuOptions): Promise<void> {
  const root = path.resolve(opts.root);
  const outDir = opts.outDir ? path.resolve(opts.outDir) : path.join(root, ".output");
  const clientDir = path.join(root, "dist/client");
  const genDir = path.join(root, ".fu");

  const routeFiles = walk(root, path.join(root, "routes"));
  const islandFiles = walk(root, path.join(root, "islands"));

  // ---- client ----
  fs.rmSync(clientDir, { recursive: true, force: true });
  fs.mkdirSync(clientDir, { recursive: true });
  const sheets = new Map<string, string>();
  const bundle = await rolldown({
    input: { boot: "fu:boot" },
    plugins: [
      virtual({ "fu:boot": bootModule(path.join(HERE, "client.ts"), islandFiles, root) }),
      css(sheets),
      jsx(),
    ],
    platform: "browser",
    // rolldown types modules by extension and refuses to bundle CSS; css()
    // has already replaced their contents with JS.
    moduleTypes: { ".css": "js" },
  });
  const result = await bundle.write({
    dir: clientDir,
    format: "esm",
    entryFileNames: "[name]-[hash].js",
    chunkFileNames: "[name]-[hash].js",
  });
  await bundle.close();

  const entry = result.output.find((o) => o.type === "chunk" && o.isEntry);
  if (!entry) throw new Error("fu: client build produced no entry chunk");
  const cssHref = writeSheets(clientDir, sheets);

  // ---- server ----
  fs.rmSync(genDir, { recursive: true, force: true });
  fs.mkdirSync(genDir, { recursive: true });
  const assets = {
    js: [{ href: "/" + entry.fileName }],
    css: cssHref ? [{ href: "/" + cssHref }] : [],
  };
  // nitro path-resolves `handlers[].handler`, so a virtual id would not survive
  // its routing codegen — generate a real file.
  const ssrEntry = path.join(genDir, "ssr.ts");
  fs.writeFileSync(
    ssrEntry,
    ssrModule({
      renderPath: path.join(HERE, "render.ts"),
      routeFiles,
      root,
      assets: JSON.stringify(assets),
      appPath: optional(root, "app.ts", "app.tsx"),
      shellPath: optional(root, "routes/_app.tsx"),
      errorPath: optional(root, "routes/_error.tsx"),
    }),
  );

  const nitro = await createNitro({
    rootDir: root,
    // Point nitro's scanner at the generated dir, never the project root, or it
    // claims `routes/` as its own server routes and shadows our catch-all.
    serverDir: genDir,
    scanDirs: [],
    output: { dir: outDir },
    publicAssets: [{ dir: clientDir, baseURL: "/" }],
    handlers: [{ route: "/**", handler: ssrEntry, format: "web", lazy: false }],
    rollupConfig: {
      // Islands are imported on the server too, so SSR needs the same handling.
      plugins: [css(new Map()), jsx({ stampIslands: true })],
      moduleTypes: { ".css": "js" },
    },
  } as Parameters<typeof createNitro>[0]);
  await copyPublicAssets(nitro);
  await nitroBuild(nitro);
}

/** Concatenate collected stylesheets into one hashed file. Returns its name. */
export function writeSheets(dir: string, sheets: Map<string, string>): string | null {
  if (sheets.size === 0) return null;
  const merged = [...sheets.values()].join("\n");
  let h = 7;
  for (let i = 0; i < merged.length; i++) h = (Math.imul(h, 31) + merged.charCodeAt(i)) >>> 0;
  const name = `style-${h.toString(36)}.css`;
  fs.writeFileSync(path.join(dir, name), merged);
  return name;
}
