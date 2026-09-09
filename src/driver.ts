// Glue shared by the dev and build drivers: where the framework's own runtime
// modules live, what a project contains, and the option sets both drivers
// hand to rolldown and nitro.
import type { createNitro } from "nitro/builder";
import type { InputOptions } from "rolldown";
import * as fs from "node:fs";
import * as path from "node:path";
import { css, hash, jsx, selfAlias, virtual } from "./plugins.ts";
import type { Assets } from "./types.ts";

/**
 * Directory holding the framework's own runtime modules, whose paths are handed
 * to rolldown. `import.meta.dirname` is undefined when this module is loaded
 * from a remote URL, and a bundler cannot fetch `https:` modules anyway — so
 * fail with the reason rather than a TypeError three frames later.
 */
const HERE = import.meta.dirname ?? remoteFrameworkError();

/** `.ts` when running from source (this repo, or JSR), `.js` from the compiled npm build. */
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
 * when neither exists (a JSR install), in which case apps must alias it
 * themselves.
 */
const PACKAGE_NAME = ((): string | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).name ?? null;
  } catch {
    return null;
  }
})();

/** Plugins every bundle of app code needs, client and server alike. */
function shared(sheets: Map<string, string>, jsxOpts: Parameters<typeof jsx>[0]) {
  return [
    ...(PACKAGE_NAME ? [selfAlias(PACKAGE_NAME, HERE, EXT)] : []),
    css(sheets),
    jsx(jsxOpts),
  ];
}

/** Absolute paths of the runtime modules the generated code imports. */
export const runtime = {
  client: path.join(HERE, `client${EXT}`),
  render: path.join(HERE, `render${EXT}`),
  hmr: path.join(HERE, "hmr-runtime.js"),
};

/** Everything a driver needs to know about a project, found once up front. */
export interface Project {
  root: string;
  /** Root-relative, e.g. "/routes/blog/[slug].tsx". */
  routeFiles: string[];
  islandFiles: string[];
  /** Absolute path to `app.ts`, if the project has one. */
  appPath: string | null;
  /** Absolute path to `routes/_app.tsx`, if the project has one. */
  shellPath: string | null;
  /** Absolute path to `routes/_error.tsx`, if the project has one. */
  errorPath: string | null;
  /** Client bundle output, served as public assets. */
  clientDir: string;
  /** Generated server entry. */
  genDir: string;
}

export function scanProject(root: string): Project {
  root = path.resolve(root);
  return {
    root,
    routeFiles: walk(root, "routes"),
    islandFiles: walk(root, "islands"),
    appPath: optional(root, "app.ts", "app.tsx"),
    shellPath: optional(root, "routes/_app.tsx"),
    errorPath: optional(root, "routes/_error.tsx"),
    clientDir: path.join(root, "dist/client"),
    genDir: path.join(root, ".fu"),
  };
}

/**
 * Recursively list source files under `<root>/<sub>`, as root-relative
 * "/sub/a/b.tsx". Underscore-prefixed files are skipped: they are framework
 * files (`routes/_app.tsx`), not routes.
 */
export function walk(root: string, sub: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) visit(f);
      else if (/\.[tj]sx?$/.test(e.name) && !e.name.startsWith("_")) {
        out.push("/" + path.relative(root, f).split(path.sep).join("/"));
      }
    }
  };
  visit(path.join(root, sub));
  return out;
}

/** Absolute path to an optional project file, or null when absent. */
export function optional(root: string, ...names: string[]): string | null {
  for (const n of names) {
    const p = path.resolve(root, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

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
    plugins: [virtual({ "fu:boot": bootModule(project) }), ...shared(sheets, { hmr })],
    platform: "browser",
    // rolldown types modules by extension and refuses to bundle CSS; css()
    // has already replaced their contents with JS.
    moduleTypes: { ".css": "js" },
  };
}

/**
 * Nitro options both drivers share. `serverDir` is the generated dir, never the
 * project root, or nitro claims `routes/` as its own server routes and shadows
 * the catch-all. Islands are imported on the server too, so SSR needs the same
 * CSS and JSX handling as the client.
 */
export function nitroOptions(
  project: Project,
  ssrEntry: string,
): Parameters<typeof createNitro>[0] {
  return {
    rootDir: project.root,
    serverDir: project.genDir,
    scanDirs: [],
    publicAssets: [{ dir: project.clientDir, baseURL: "/" }],
    handlers: [{ route: "/**", handler: ssrEntry, format: "web", lazy: false }],
    rollupConfig: {
      plugins: shared(new Map(), { stampIslands: true }),
      moduleTypes: { ".css": "js" },
    },
  } as Parameters<typeof createNitro>[0];
}

/** Concatenate collected stylesheets into one file; hashed unless a name is given. */
export function writeSheets(
  dir: string,
  sheets: Map<string, string>,
  name?: string,
): string | null {
  if (sheets.size === 0) return null;
  const merged = [...sheets.values()].join("\n");
  const file = name ?? `style-${hash(merged)}.css`;
  fs.writeFileSync(path.join(dir, file), merged);
  return file;
}

const lazyImport = (root: string, file: string) =>
  `${JSON.stringify(file)}: () => import(${JSON.stringify(path.resolve(root, "." + file))})`;

/** The client entry: hydrate every island the page carries. */
export function bootModule(project: Pick<Project, "root" | "islandFiles">): string {
  const manifest = project.islandFiles.map((f) => "  " + lazyImport(project.root, f)).join(",\n");
  return `import { hydrateIslands } from ${JSON.stringify(runtime.client)};\n` +
    `hydrateIslands({\n${manifest}\n});\n`;
}

/**
 * The server entry: the route manifest, the optional app, shell and error
 * page, and the handler wired to nitro.
 *
 * Nitro invokes the handler with an H3Event, not a Request. The event exposes
 * `url`/`headers` directly — which is why routing worked long before anyone
 * read a body — but has no json()/text()/formData(). The real Request is
 * `event.req`.
 */
export function ssrModule(
  project: Pick<Project, "root" | "routeFiles" | "appPath" | "shellPath" | "errorPath">,
  assets: Assets,
): string {
  const optionalImports: [name: string, file: string | null][] = [
    ["app", project.appPath],
    ["Shell", project.shellPath],
    ["ErrorPage", project.errorPath],
  ];
  const present = optionalImports.filter(([, file]) => file);
  return [
    `import { createHandler } from ${JSON.stringify(runtime.render)};`,
    ...present.map(([name, file]) => `import ${name} from ${JSON.stringify(file)};`),
    `const manifest = {`,
    project.routeFiles.map((f) => "  " + lazyImport(project.root, f)).join(",\n"),
    `};`,
    `const assets = ${JSON.stringify(assets)};`,
    `const handler = createHandler({ manifest, assets${
      present.map(([n]) => `, ${n}`).join("")
    } });`,
    `const toRequest = (input) => input instanceof Request ? input : (input?.req ?? input);`,
    `export default (input) => handler(toRequest(input));`,
    ``,
  ].join("\n");
}

/**
 * Write the generated server entry and return its path. It has to be a real
 * file: nitro path-resolves `handlers[].handler`, so a virtual id would not
 * survive its routing codegen.
 */
export function writeSsrEntry(project: Project, assets: Assets): string {
  emptyDir(project.genDir);
  const file = path.join(project.genDir, "ssr.ts");
  fs.writeFileSync(file, ssrModule(project, assets));
  return file;
}
