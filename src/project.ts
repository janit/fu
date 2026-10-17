// What a project contains, found by walking its directories. Kept apart from
// driver.ts, which imports the bundlers: the test entry (testing.ts) needs the
// scan and must not load rolldown's or lightningcss's native addons to get it.
import * as fs from "node:fs";
import * as path from "node:path";

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
  /**
   * Absolute path to `worker.ts` (or .js), if the project has one: `prepare`
   * and the exports the Worker carries beside fu's request handler.
   */
  workerPath: string | null;
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
    workerPath: optional(root, "worker.ts", "worker.js"),
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
