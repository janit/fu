// Glue shared by the dev and build drivers: where the framework's own runtime
// modules live, what a project contains, the modules generated for it, and
// the option sets both drivers hand to rolldown.
import type { InputOptions } from "rolldown";
import { parseSync } from "rolldown/experimental";
import * as fs from "node:fs";
import * as path from "node:path";
import { css, hash, jsx, selfAlias, virtual } from "./plugins.ts";
import type { Project } from "./project.ts";
import type { Assets } from "./types.ts";

/**
 * Directory holding the framework's own runtime modules, whose paths are handed
 * to rolldown. `import.meta.dirname` is undefined when this module is loaded
 * from a remote URL, and a bundler cannot fetch `https:` modules anyway — so
 * fail with the reason rather than a TypeError three frames later.
 */
const HERE = import.meta.dirname ?? remoteFrameworkError();

/** `.ts` when running from source (this repo), `.js` from the compiled npm build. */
const EXT = import.meta.url.endsWith(".js") ? ".js" : ".ts";

function remoteFrameworkError(): never {
  throw new Error(
    "fu: the framework is loaded from a remote URL (" + import.meta.url + "), " +
      "so its runtime modules cannot be handed to the bundler. Install it " +
      "instead — `npm:@janit/fu` in a Deno import map, or `npm i @janit/fu` — " +
      "so it resolves to a real directory.",
  );
}

/**
 * The framework's own package name, read from the package.json above the
 * runtime modules: this repo's at the root, or the installed package's. Absent
 * when neither exists, in which case apps must alias it themselves.
 */
const PACKAGE_NAME = ((): string | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).name ?? null;
  } catch {
    return null;
  }
})();

/** Plugins every bundle of app code needs, client and server alike. */
function shared(
  project: Project,
  sheets: Map<string, string>,
  jsxOpts: Parameters<typeof jsx>[0],
  onCss?: () => void,
) {
  return [
    ...(PACKAGE_NAME ? [selfAlias(PACKAGE_NAME, HERE, EXT)] : []),
    css(sheets, onCss),
    jsx({ ...jsxOpts, root: project.root }),
  ];
}

/**
 * Fail the build on an import that resolves to nothing. Rolldown only warns
 * and leaves the import in the output, so the build "succeeded" and the server
 * then died at boot, or answered 500, for want of a package nobody installed.
 */
export const strictImports = {
  name: "fu:strict-imports",
  onLog(
    this: { error(message: string): never },
    _level: string,
    log: { code?: string; message: string; id?: string },
  ) {
    if (log.code !== "UNRESOLVED_IMPORT") return;
    // Only the app's own imports. A dependency's unresolved optional import
    // stays what it was: external, and its business.
    const importer = log.id ?? / in (\S+)\s*$/m.exec(log.message)?.[1] ?? "";
    if (/(^|[\\/])node_modules[\\/]/.test(importer)) return;
    this.error(log.message);
  },
};

/** Absolute paths of the runtime modules the generated code imports. */
export const runtime = {
  assets: path.join(HERE, `assets${EXT}`),
  client: path.join(HERE, `client${EXT}`),
  nav: path.join(HERE, `nav${EXT}`),
  render: path.join(HERE, `render${EXT}`),
  serve: path.join(HERE, `serve${EXT}`),
  hmr: path.join(HERE, "hmr-runtime.js"),
};

// The project scan lives in project.ts, which imports no bundler; re-exported
// here, where it always was.
export { optional, scanProject, walk } from "./project.ts";
export type { Project } from "./project.ts";

/** Recreate `dir` empty. */
export function emptyDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/** Rolldown input for the client bundle. */
export function clientInput(
  project: Project,
  sheets: Map<string, string>,
  hmr = false,
): InputOptions {
  return {
    input: { boot: "fu:boot" },
    plugins: [
      virtual({ "fu:boot": bootModule(project) }),
      ...shared(project, sheets, { hmr }),
      strictImports,
    ],
    platform: "browser",
    // See client.ts: the hot-swap machinery is compiled out of a build.
    transform: { define: { __FU_HMR__: String(hmr) } },
    // rolldown types modules by extension and refuses to bundle CSS; css()
    // has already replaced their contents with JS.
    moduleTypes: { ".css": "js" },
  };
}

/** Conditions a Worker is built with, by celld's and Cloudflare's tooling alike. */
export const WORKER_CONDITIONS = ["workerd", "worker", "import", "default"];

/**
 * Rolldown input for the server bundle: the Worker in a build, the dev SSR
 * module in dev. Islands are imported on the server too, so it needs the same
 * CSS and JSX handling as the client; stylesheets a route or the shell imports
 * are seen only here, so the caller passes the map the client's sheets go to.
 *
 * A Worker resolves packages as celld's bundler would (`workerd`, `worker`),
 * never through `browser` (the module runs under serve.mjs on Node too) nor
 * `node` (that would drag in `node:` code celld does not have). A `node:`
 * import stays an import; one nothing uses is dropped, so a module that
 * imports `node:fs` for a function the app never calls costs nothing.
 */
export function serverInput(
  project: Project,
  input: string,
  { sheets = new Map(), onCss, dev = false }: {
    sheets?: Map<string, string>;
    onCss?: () => void;
    dev?: boolean;
  } = {},
): InputOptions {
  return {
    input,
    plugins: [...shared(project, sheets, { stampIslands: true }, onCss), strictImports],
    // Dev runs the module in the dev server's own process, which is Node,
    // Deno or Bun: whatever that resolves to is what it can load.
    platform: dev ? "node" : "neutral",
    ...(dev ? {} : { resolve: { conditionNames: WORKER_CONDITIONS } }),
    external: [/^node:/],
    treeshake: {
      moduleSideEffects: (id: string, external: boolean) => !(external && id.startsWith("node:")),
    },
    moduleTypes: { ".css": "js" },
  } as InputOptions;
}

/**
 * Server-side entry points: every route plus the shell, error page and app.
 * Their imports reach CSS the client bundle never sees.
 */
export function serverEntries(project: Project): string[] {
  return [
    ...project.routeFiles.map((f) => path.join(project.root, f)),
    ...[project.shellPath, project.errorPath, project.appPath].filter((f): f is string => !!f),
  ];
}

/** Resolve bare specifiers as external: a pass that only collects CSS need not bundle packages. */
export const externalPackages = {
  name: "fu:external-packages",
  resolveId(id: string, importer?: string) {
    if (!importer || id.startsWith("\0") || /^[./]/.test(id) || path.isAbsolute(id)) return null;
    if (/\.css(\?|$)/.test(id)) return null;
    return { id, external: true };
  },
};

/** Rolldown input for a pass over the server entries that only collects their CSS. */
export function cssInput(project: Project, sheets: Map<string, string>): InputOptions {
  return {
    input: serverEntries(project),
    // After selfAlias, so the framework itself still resolves to its files.
    plugins: [...shared(project, sheets, {}), externalPackages],
    platform: "node",
    moduleTypes: { ".css": "js" },
    logLevel: "silent",
  };
}

/**
 * One stylesheet from several collections, each sheet once, in the order
 * given. Callers pass the server's sheets first: its bundle and the client's
 * finish in a different order in dev than in a build, and the cascade must not
 * depend on which one won.
 */
export function mergeSheets(collections: Map<string, string>[]): string | null {
  const merged = new Map<string, string>();
  for (const sheets of collections) {
    for (const [id, text] of sheets) if (!merged.has(id)) merged.set(id, text);
  }
  return merged.size === 0 ? null : [...merged.values()].join("\n");
}

/** Write the merged stylesheet; hashed unless a name is given. */
export function writeSheets(
  dir: string,
  collections: Map<string, string>[],
  name?: string,
): string | null {
  const merged = mergeSheets(collections);
  if (merged === null) return null;
  const file = name ?? `style-${hash(merged)}.css`;
  fs.writeFileSync(path.join(dir, file), merged);
  return file;
}

const lazyImport = (root: string, file: string) =>
  `${JSON.stringify(file)}: () => import(${JSON.stringify(path.resolve(root, "." + file))})`;

/**
 * The client entry: hydrate every island the page carries, and load the
 * navigation runtime only if the body opted in. The runtime is reached by a
 * dynamic import alone, so it is its own chunk and a page without
 * `data-fu-nav` never fetches it.
 *
 * Every byte here is paid by every page of every app, so this is as little
 * as it can be: the test for the attribute, and nothing waits for anything
 * (the runtime loads beside the island chunks; it and hydration never touch
 * the same element, see nav.ts). The one thing that does follow hydration is
 * the `fu:hydrated` signal, which is not on the runtime's path.
 */
export function bootModule(project: Pick<Project, "root" | "islandFiles">): string {
  const manifest = project.islandFiles.map((f) => "  " + lazyImport(project.root, f)).join(",\n");
  return `import { hydrateIslands, markHydrated } from ${JSON.stringify(runtime.client)};\n` +
    `const manifest = {\n${manifest}\n};\n` +
    `hydrateIslands(manifest).then(markHydrated);\n` +
    `if ("fuNav" in document.body.dataset) {\n` +
    `  import(${JSON.stringify(runtime.nav)}).then((m) => m.installNav(manifest));\n` +
    `}\n`;
}

/**
 * The server module: the route manifest, the optional app, shell and error
 * page, wired into one handler, `(request, extra) => Response`. In a build
 * the client files are served in front of it (see `clientFiles`).
 */
export interface EntryOptions {
  /** Build only: the client files' URLs and the prefix they are served under, e.g. "/_fu/". */
  clientFiles?: { prefix: string; files: readonly string[] };
  /**
   * Dev only: the stylesheet the dev server writes, if the app has any. The
   * entry puts `assets.css` on a page only while this file exists, so an app
   * without CSS does not request a /style.css that is not there.
   */
  devCssFile?: string;
}

export function ssrModule(
  project: Pick<Project, "root" | "routeFiles" | "appPath" | "shellPath" | "errorPath">,
  assets: Assets,
  { clientFiles, devCssFile }: EntryOptions = {},
): string {
  const optionalImports: [name: string, file: string | null][] = [
    ["app", project.appPath],
    ["Shell", project.shellPath],
    ["ErrorPage", project.errorPath],
  ];
  const present = optionalImports.filter(([, file]) => file);
  const handler = `createHandler({ manifest, ${
    devCssFile ? "get assets() { return existsSync(cssFile) ? assets : bare; }" : "assets"
  }${present.map(([n]) => `, ${n}`).join("")} })`;
  return [
    `import { createHandler } from ${JSON.stringify(runtime.render)};`,
    ...(clientFiles ? [`import { clientFiles } from ${JSON.stringify(runtime.assets)};`] : []),
    ...(devCssFile ? [`import { existsSync } from "node:fs";`] : []),
    ...present.map(([name, file]) => `import ${name} from ${JSON.stringify(file)};`),
    `const manifest = {`,
    project.routeFiles.map((f) => "  " + lazyImport(project.root, f)).join(",\n"),
    `};`,
    `const assets = ${JSON.stringify(assets)};`,
    // Two stable objects, read per request: the head tags are cached per object.
    ...(devCssFile
      ? [
        `const bare = { ...assets, css: [] };`,
        `const cssFile = ${JSON.stringify(devCssFile)};`,
      ]
      : []),
    clientFiles
      ? `export default clientFiles(${handler}, ${JSON.stringify(clientFiles)});`
      : `export default ${handler};`,
    ``,
  ].join("\n");
}

/** What `worker.ts` exports, as far as the generated Worker entry needs to know. */
export interface WorkerExports {
  /** Whether it exports `prepare`, which is called and not re-exported. */
  prepare: boolean;
  /** Every other runtime export, re-exported from the Worker as it is. */
  names: string[];
}

/** Minimal slice of the oxc AST `workerExports` walks. */
interface ExportNode {
  type: string;
  exportKind?: string;
  source?: unknown;
  declaration?: {
    type: string;
    declare?: boolean;
    const?: boolean;
    id?: { name?: string };
    declarations?: { id?: { type?: string; name?: string }; init?: { type?: string } | null }[];
  } | null;
  specifiers?: { exportKind?: string; exported?: { name?: string; value?: string } }[];
}

const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

const FUNCTION_EXPRESSIONS = new Set(["ArrowFunctionExpression", "FunctionExpression"]);

/**
 * Read `worker.ts`'s exports. celld refuses a Worker module whose exports are
 * not all handlers or classes, and the Worker's default export is fu's, so a
 * default export here is refused, as is `export *` (its names cannot be known
 * without bundling). `prepare` must be a function; one that visibly is not is
 * refused here, any other is checked when it is called.
 */
export function workerExports(file: string, source: string): WorkerExports {
  const parsed = parseSync(file, source, { sourceType: "module", lang: "tsx" });
  const body = (parsed.program as unknown as { body: ExportNode[] }).body ?? [];
  const names: string[] = [];
  const fail = (why: string): never => {
    throw new Error(`fu: ${file}: ${why}`);
  };
  for (const node of body) {
    if (node.exportKind === "type") continue;
    if (node.type === "ExportDefaultDeclaration") {
      fail("a default export is not allowed; the Worker's default export is fu's request handler");
    }
    if (node.type === "ExportAllDeclaration") {
      fail("`export *` is not allowed; name what the Worker exports");
    }
    if (node.type !== "ExportNamedDeclaration") continue;
    const decl = node.declaration;
    // `declare` and `const enum` leave no binding behind to re-export.
    if (decl?.declare || (decl?.type === "TSEnumDeclaration" && decl.const)) continue;
    if (decl?.type === "VariableDeclaration") {
      for (const d of decl.declarations ?? []) {
        if (d.id?.type !== "Identifier" || !d.id.name) {
          fail("destructured exports are not allowed; export each binding by name");
        }
        if (d.id!.name === "prepare" && d.init && !FUNCTION_EXPRESSIONS.has(d.init.type ?? "")) {
          fail("`prepare` must be a function");
        }
        names.push(d.id!.name!);
      }
    } else if (decl?.type === "ClassDeclaration" && decl.id?.name === "prepare") {
      fail("`prepare` must be a function, not a class");
    } else if (decl?.id?.name) {
      // A TypeScript declaration (interface, type, enum) has no runtime value
      // unless it is an enum; neither is a handler, so only those that oxc
      // reports as values reach here.
      if (decl.type.startsWith("TS") && decl.type !== "TSEnumDeclaration") continue;
      names.push(decl.id.name);
    } else {
      for (const sp of node.specifiers ?? []) {
        if (sp.exportKind === "type") continue;
        const name = sp.exported?.name ?? sp.exported?.value;
        if (name === "default") {
          fail(
            "a default export is not allowed; the Worker's default export is fu's request handler",
          );
        }
        // `export { x as "a-b" }` is valid, but the generated re-export
        // spells names bare, and celld's entrypoints are names a binding takes.
        if (name && !IDENTIFIER.test(name)) {
          fail(`export ${JSON.stringify(name)} is not a JavaScript name`);
        }
        if (name) names.push(name);
      }
    }
  }
  return { prepare: names.includes("prepare"), names: names.filter((n) => n !== "prepare") };
}

/**
 * The Worker entry: what celld runs. `prepare(env)` runs once per isolate,
 * before any of the app's modules: the app graph is a dynamic import, which
 * the bundle keeps lazy, so module-scope code in a route sees what `prepare`
 * set up. A `prepare` that fails is tried again on the next request; a route
 * module that throws at module scope fails every request, as an import would.
 */
export function workerModule(
  workerPath: string | null,
  exports: WorkerExports,
  ssr = "./ssr.ts",
): string {
  const from = JSON.stringify(workerPath);
  return [
    ...(workerPath && exports.prepare ? [`import { prepare } from ${from};`] : []),
    ...(workerPath && exports.names.length
      ? [`export { ${exports.names.join(", ")} } from ${from};`]
      : []),
    `let ready;`,
    `function load(env) {`,
    `  return ready ??= Promise.resolve()`,
    ...(exports.prepare
      ? [
        `    .then(() => {`,
        `      if (typeof prepare !== "function") throw new TypeError("fu: worker.ts: prepare is not a function");`,
        `      return prepare(env);`,
        `    })`,
      ]
      : []),
    `    .then(() => import(${JSON.stringify(ssr)}))`,
    `    .then((m) => m.default, (err) => {`,
    `      ready = undefined;`,
    `      throw err;`,
    `    });`,
    `}`,
    `export default {`,
    `  async fetch(request, env = {}, ctx) {`,
    `    const handler = await load(env);`,
    `    return handler(request, {`,
    `      env,`,
    `      waitUntil: ctx ? (p) => ctx.waitUntil(p) : undefined,`,
    `      assets: env.ASSETS ?? null,`,
    `    });`,
    `  },`,
    `};`,
    ``,
  ].join("\n");
}

/**
 * The runner: serve.mjs, beside the Worker it serves. The Worker stays a
 * separate file, imported, so the code that runs is the code celld would run.
 */
export function runnerModule(): string {
  return [
    `import worker from "./index.mjs";`,
    `import { serveWorker } from ${JSON.stringify(runtime.serve)};`,
    `import { fileURLToPath } from "node:url";`,
    `const served = await serveWorker(worker, {`,
    `  publicDir: fileURLToPath(new URL("../public/", import.meta.url)),`,
    `});`,
    `console.log(\`[fu] serving \${served.url}\`);`,
    ``,
  ].join("\n");
}

/** Write a generated module into the project's generated dir and return its path. */
export function writeGenerated(project: Project, name: string, source: string): string {
  fs.mkdirSync(project.genDir, { recursive: true });
  const file = path.join(project.genDir, name);
  fs.writeFileSync(file, source);
  return file;
}

/** Recreate the generated dir empty and write the server module into it. */
export function writeSsrEntry(
  project: Project,
  assets: Assets,
  opts?: EntryOptions,
): string {
  emptyDir(project.genDir);
  return writeGenerated(project, "ssr.ts", ssrModule(project, assets, opts));
}

/** The Worker entry for `project`, written beside the server module. */
export function writeWorkerEntry(project: Project): string {
  const exports = project.workerPath
    ? workerExports(project.workerPath, fs.readFileSync(project.workerPath, "utf8"))
    : { prepare: false, names: [] };
  return writeGenerated(project, "worker.ts", workerModule(project.workerPath, exports));
}

/** The URLs of the files under `clientDir`, as served under `prefix`. */
export function clientFileUrls(clientDir: string, prefix: string): string[] {
  return fs.readdirSync(clientDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) =>
      prefix +
      path.relative(clientDir, path.join(e.parentPath, e.name)).split(path.sep).join("/")
    )
    .sort();
}
