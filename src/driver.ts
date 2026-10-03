// Glue shared by the dev and build drivers: where the framework's own runtime
// modules live, what a project contains, and the option sets both drivers
// hand to rolldown and nitro.
import type { createNitro } from "nitro/builder";
import type { InputOptions } from "rolldown";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { css, hash, jsx, selfAlias, virtual } from "./plugins.ts";
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
    // (nitro's dev runtime has one) stays what it was: external, and its
    // business.
    const importer = log.id ?? / in (\S+)\s*$/m.exec(log.message)?.[1] ?? "";
    if (/(^|[\\/])node_modules[\\/]/.test(importer)) return;
    this.error(log.message);
  },
};

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
  /** Absolute path to `app.ts` (or .tsx, .js, .jsx), if the project has one. */
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
  // Without this a mistyped root builds an app with no routes, which serves a
  // 404 for everything and says nothing about why.
  if (!fs.existsSync(path.join(root, "routes"))) {
    throw new Error(`no routes/ directory in ${root}; is that the project root?`);
  }
  return {
    root,
    routeFiles: walk(root, "routes"),
    islandFiles: walk(root, "islands"),
    appPath: optional(root, ...sourceNames("app")),
    shellPath: optional(root, ...sourceNames("routes/_app")),
    errorPath: optional(root, ...sourceNames("routes/_error")),
    clientDir: path.join(root, "dist/client"),
    genDir: path.join(root, ".fu"),
  };
}

/** `base` with each extension a route may have, TypeScript first. */
function sourceNames(base: string): string[] {
  return [".ts", ".tsx", ".js", ".jsx"].map((ext) => base + ext);
}

/** Tests and declaration files that sit beside the sources. */
const NOT_SOURCE = /(\.d\.ts|[._]test\.[tj]sx?)$/;

/**
 * Recursively list source files under `<root>/<sub>`, as root-relative
 * "/sub/a/b.tsx". Underscore-prefixed files and directories are skipped: they
 * are framework files (`routes/_app.tsx`) or an app's own helpers
 * (`routes/_parts/`), not routes. So are tests and `.d.ts` files.
 */
export function walk(root: string, sub: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.name.startsWith("_")) continue;
      if (e.isDirectory()) visit(f);
      else if (/\.[tj]sx?$/.test(e.name) && !NOT_SOURCE.test(e.name)) {
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

/**
 * Nitro options both drivers share. `serverDir` is the generated dir, never the
 * project root, or nitro claims `routes/` as its own server routes and shadows
 * the catch-all. Islands are imported on the server too, so SSR needs the same
 * CSS and JSX handling as the client. Stylesheets a route or the shell imports
 * are seen only here, so the caller passes the map the client's sheets go to.
 */
export function nitroOptions(
  project: Project,
  ssrEntry: string,
  sheets: Map<string, string> = new Map(),
  onCss?: () => void,
): Parameters<typeof createNitro>[0] {
  return {
    rootDir: project.root,
    serverDir: project.genDir,
    scanDirs: [],
    publicAssets: [{ dir: project.clientDir, baseURL: "/" }],
    handlers: [{ route: "/**", handler: ssrEntry, format: "web", lazy: false }],
    rollupConfig: {
      plugins: [...shared(project, sheets, { stampIslands: true }, onCss), strictImports],
      moduleTypes: { ".css": "js" },
    },
  } as Parameters<typeof createNitro>[0];
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
/**
 * Where nitro's h3 lives, as a path. The generated entry sits in the app,
 * which does not depend on nitro: by name it resolves only where packages are
 * hoisted (npm), not under Deno's or pnpm's layout. Resolved from here, where
 * nitro is a dependency, it is also the copy nitro's own runtime uses.
 */
function nitroH3(): string {
  return fileURLToPath(import.meta.resolve("nitro/h3"));
}

export interface EntryOptions {
  /** Dev only: the Host names to answer to. Omit to answer to any. */
  hosts?: readonly string[];
  /** Build only: the URL prefix the client files are served under, e.g. "/_fu/". */
  assetsPrefix?: string;
}

export function ssrModule(
  project: Pick<Project, "root" | "routeFiles" | "appPath" | "shellPath" | "errorPath">,
  assets: Assets,
  { hosts, assetsPrefix }: EntryOptions = {},
): string {
  const optionalImports: [name: string, file: string | null][] = [
    ["app", project.appPath],
    ["Shell", project.shellPath],
    ["ErrorPage", project.errorPath],
  ];
  const present = optionalImports.filter(([, file]) => file);
  return [
    `import { createHandler${hosts ? ", onlyHosts" : ""} } from ${JSON.stringify(runtime.render)};`,
    ...(assetsPrefix ? [`import { HTTPError } from ${JSON.stringify(nitroH3())};`] : []),
    ...present.map(([name, file]) => `import ${name} from ${JSON.stringify(file)};`),
    `const manifest = {`,
    project.routeFiles.map((f) => "  " + lazyImport(project.root, f)).join(",\n"),
    `};`,
    `const assets = ${JSON.stringify(assets)};`,
    `const handler = ${hosts ? "onlyHosts(" : ""}createHandler({ manifest, assets${
      present.map(([n]) => `, ${n}`).join("")
    } })${hosts ? `, ${JSON.stringify(hosts)})` : ""};`,
    `const toRequest = (input) => input instanceof Request ? input : (input?.req ?? input);`,
    ...(assetsPrefix
      ? [
        // A request only gets here under the asset prefix when no such file
        // exists. Nitro's route rule would put the assets' year-long max-age
        // on whatever the app answered, after it answered; an error nitro
        // renders itself is the one response that rule does not reach.
        `const underAssets = (path) => path === ${
          JSON.stringify(assetsPrefix.replace(/\/$/, ""))
        } || path.startsWith(${JSON.stringify(assetsPrefix)});`,
        `export default (input) => {`,
        `  const req = toRequest(input);`,
        `  if (underAssets(new URL(req.url).pathname)) {`,
        `    throw new HTTPError({ status: 404, headers: { "cache-control": "no-store" } });`,
        `  }`,
        `  return handler(req);`,
        `};`,
      ]
      : [`export default (input) => handler(toRequest(input));`]),
    ``,
  ].join("\n");
}

/**
 * Write the generated server entry and return its path. It has to be a real
 * file: nitro path-resolves `handlers[].handler`, so a virtual id would not
 * survive its routing codegen.
 */
export function writeSsrEntry(
  project: Project,
  assets: Assets,
  opts?: EntryOptions,
): string {
  emptyDir(project.genDir);
  const file = path.join(project.genDir, "ssr.ts");
  fs.writeFileSync(file, ssrModule(project, assets, opts));
  return file;
}
