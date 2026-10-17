// The app's request handler built from its source files, for tests that
// render real pages in-process. The caller's runtime loads the sources (Deno
// natively; Node with a loader for .tsx). No bundler runs, so the SSR island
// transform does not either: islands render as plain components, without the
// `data-island` marker. Tests that assert markers need a real build.
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { scanProject } from "./project.ts";
import { createHandler } from "./render.ts";
import type { Assets, AssetStore, Env, RequestExtra, RouteManifest } from "./types.ts";

export interface AppHandlerOptions {
  /** Assets to reference in the HTML. Default: none. */
  assets?: Assets;
  /** `ctx.env` for every request. Default: `{}`. */
  env?: Env;
  /** `ctx.assets` for every request, e.g. `assetsFromDir(dir)`. Default: none. */
  assetStore?: AssetStore;
}

/**
 * `(req) => Response` for the project at `root`, exactly as the built server
 * would route it. What a test passes as the second argument goes over the
 * defaults in `opts`, as the runtime's would.
 *
 * `root` should be absolute: a relative one resolves against the working
 * directory of the test process, which a test runner may change.
 *
 * The app's modules are loaded with `import()`, so they go through the
 * runtime's module cache: two `appHandler(root)` calls get two handlers over
 * the same module instances, and module-level state in the app (a counter, a
 * cache, a connection) is shared between them.
 */
export async function appHandler<S = Record<string, unknown>>(
  root: string,
  opts: AppHandlerOptions = {},
): Promise<(req: Request, extra?: RequestExtra) => Promise<Response>> {
  const project = scanProject(root);
  const load = (file: string) => import(pathToFileURL(file).href);
  const manifest: RouteManifest<S> = Object.fromEntries(
    project.routeFiles.map((f) => [f, () => load(path.join(project.root, "." + f))]),
  );
  const app = project.appPath ? (await load(project.appPath)).default : undefined;
  const Shell = project.shellPath ? (await load(project.shellPath)).default : undefined;
  const ErrorPage = project.errorPath ? (await load(project.errorPath)).default : undefined;
  const handler = createHandler<S>({
    manifest,
    assets: opts.assets ?? { js: [], css: [] },
    app,
    Shell,
    ErrorPage,
  });
  return (req, extra = {}) =>
    handler(req, {
      ...extra,
      // A key passed as undefined is not passed: the defaults stay.
      env: extra.env ?? opts.env,
      assets: extra.assets ?? opts.assetStore,
    });
}
