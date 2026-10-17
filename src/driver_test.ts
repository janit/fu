import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
  bootModule,
  mergeSheets,
  optional,
  scanProject,
  ssrModule,
  strictImports,
  walk,
  workerExports,
  workerModule,
} from "./driver.ts";

const tmp = await Deno.makeTempDir();
const assets = { js: [], css: [] };

addEventListener("unload", () => Deno.removeSync(tmp, { recursive: true }));

Deno.test("walk finds routes and skips framework files", async () => {
  const root = await Deno.makeTempDir({ dir: tmp });
  await Deno.mkdir(`${root}/routes/blog`, { recursive: true });
  for (
    const f of [
      "routes/index.tsx",
      "routes/_app.tsx",
      "routes/_middleware.ts",
      "routes/blog/[slug].tsx",
      "routes/notes.md",
    ]
  ) await Deno.writeTextFile(`${root}/${f}`, "");
  assertEquals(walk(root, "routes").sort(), [
    "/routes/blog/[slug].tsx",
    "/routes/index.tsx",
  ]);
});

Deno.test("walk on a missing directory returns nothing rather than throwing", () => {
  assertEquals(walk(tmp, "does-not-exist"), []);
});

Deno.test("optional finds the first file that exists", async () => {
  await Deno.writeTextFile(`${tmp}/app.ts`, "");
  assertStringIncludes(optional(tmp, "nope.ts", "app.ts") ?? "", "app.ts");
  assertEquals(optional(tmp, "nope.ts"), null);
});

Deno.test("ssrModule wires the optional app and shell only when present", () => {
  const none = { appPath: null, shellPath: null, errorPath: null };
  const bare = ssrModule({ ...none, routeFiles: ["/routes/index.tsx"], root: "/p" }, assets);
  assertEquals(bare.includes("import app"), false);
  assertEquals(bare.includes("Shell"), false);
  assertStringIncludes(bare, "createHandler({ manifest, assets })");
  assertStringIncludes(bare, '"/routes/index.tsx": () => import("/p/routes/index.tsx")');
  assertStringIncludes(bare, 'const assets = {"js":[],"css":[]};');

  const full = ssrModule({
    ...none,
    routeFiles: [],
    root: "/p",
    appPath: "/p/app.ts",
    shellPath: "/p/routes/_app.tsx",
  }, assets);
  assertStringIncludes(full, 'import app from "/p/app.ts"');
  assertStringIncludes(full, 'import Shell from "/p/routes/_app.tsx"');
  assertStringIncludes(full, "createHandler({ manifest, assets, app, Shell })");
});

Deno.test("walk leaves out what is not a route: private directories, tests, declarations", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/routes/_parts`, { recursive: true });
    for (
      const f of [
        "routes/index.tsx",
        "routes/_parts/Part.tsx",
        "routes/index_test.tsx",
        "routes/index.test.ts",
        "routes/types.d.ts",
      ]
    ) await Deno.writeTextFile(`${root}/${f}`, "");
    assertEquals(walk(root, "routes"), ["/routes/index.tsx"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the shell, error page and app are found whichever source extension they use", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/routes`);
    for (const f of ["routes/_app.jsx", "routes/_error.js", "app.js"]) {
      await Deno.writeTextFile(`${root}/${f}`, "");
    }
    const project = scanProject(root);
    assertStringIncludes(project.shellPath ?? "", "_app.jsx");
    assertStringIncludes(project.errorPath ?? "", "_error.js");
    assertStringIncludes(project.appPath ?? "", "app.js");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the server's stylesheets come first, in dev and in a build alike", () => {
  // The two bundles finish in a different order in dev than in a build, and
  // the cascade followed whichever came first.
  const server = new Map([["/routes/a.css", ".a{}"], ["/islands/i.css", ".i{}"]]);
  const client = new Map([["/islands/i.css", ".i{}"], ["/islands/only.css", ".o{}"]]);
  assertEquals(mergeSheets([server, client]), ".a{}\n.i{}\n.o{}");
  assertEquals(mergeSheets([new Map(), new Map()]), null);
});

Deno.test("without a dev stylesheet file the entry is what it always was", () => {
  const project = { routeFiles: [], root: "/p", appPath: null, shellPath: null, errorPath: null };
  const plain = ssrModule(project, assets);
  assertEquals(plain.includes("existsSync"), false);
  assertEquals(plain.includes("get assets"), false);
  const dev = ssrModule(project, assets, { devCssFile: "/c/style.css" });
  assertStringIncludes(dev, "existsSync");
  assertStringIncludes(dev, "get assets()");
});

Deno.test("the dev entry links the stylesheet only while the file exists", async () => {
  const root = await Deno.makeTempDir({ dir: tmp });
  const cssFile = `${root}/style.css`;
  await Deno.mkdir(`${root}/routes`);
  await Deno.writeTextFile(`${root}/routes/index.ts`, `export default () => "home";\n`);
  const project = {
    routeFiles: ["/routes/index.ts"],
    root,
    appPath: null,
    shellPath: null,
    errorPath: null,
  };
  const withCss = { js: [{ href: "/boot.js" }], css: [{ href: "/style.css" }] };
  const file = `${root}/ssr.ts`;
  await Deno.writeTextFile(file, ssrModule(project, withCss, { devCssFile: cssFile }));
  const entry = (await import(file)).default as (r: Request) => Promise<Response>;
  const page = async () => await (await entry(new Request("http://localhost/"))).text();
  const before = await page();
  assertEquals(before.includes("stylesheet"), false);
  assertStringIncludes(before, "/boot.js");
  await Deno.writeTextFile(cssFile, ".a{}");
  assertStringIncludes(await page(), '<link rel="stylesheet" href="/style.css">');
  await Deno.remove(cssFile);
  assertEquals((await page()).includes("stylesheet"), false);
});

Deno.test("the built entry serves its client files in front of the app, and nothing else imports", () => {
  const project = { routeFiles: [], root: "/p", appPath: null, shellPath: null, errorPath: null };
  const built = ssrModule(project, assets, {
    clientFiles: { prefix: "/_fu/", files: ["/_fu/boot-a.js"] },
  });
  assertStringIncludes(
    built,
    'export default clientFiles(createHandler({ manifest, assets }), {"prefix":"/_fu/","files":["/_fu/boot-a.js"]});',
  );
  // Runtime-neutral: the Worker bundle gets no node: import from fu.
  assertEquals(built.includes("node:"), false);
  assertEquals(ssrModule(project, assets).includes("clientFiles"), false);
});
Deno.test("an unresolved import fails the build only when the app wrote it", () => {
  const errors: string[] = [];
  const onLog = (log: { code?: string; message: string; id?: string }) =>
    strictImports.onLog.call({ error: (m: string) => errors.push(m) as never }, "warn", log);
  onLog({ code: "UNRESOLVED_IMPORT", message: "Could not resolve 'x' in routes/a.tsx" });
  onLog({ code: "UNRESOLVED_IMPORT", message: "no", id: "/p/routes/b.tsx" });
  // A dependency's own optional import is its business: rolldown leaves it
  // external, as it always did.
  onLog({
    code: "UNRESOLVED_IMPORT",
    message:
      "Could not resolve 'pathe' in node_modules/.store/nitro@3/node_modules/nitro/dist/x.mjs",
  });
  onLog({ code: "UNRESOLVED_IMPORT", message: "no", id: "/p/node_modules/nitro/dist/x.mjs" });
  onLog({ code: "EMPTY_BUNDLE", message: "fine" });
  assertEquals(errors, ["Could not resolve 'x' in routes/a.tsx", "no"]);
});

Deno.test("the boot module loads the nav runtime only when the body opts in", () => {
  const boot = bootModule({ root: "/p", islandFiles: ["/islands/A.tsx"] });
  assertStringIncludes(boot, '"fuNav" in document.body.dataset');
  assertStringIncludes(boot, "installNav(manifest)");
  // Hydration is started, not awaited: the runtime loads beside the island
  // chunks, and a page without the attribute pays for the test alone.
  assertStringIncludes(boot, "hydrateIslands(manifest).then(markHydrated);\n");
  assertEquals(boot.includes(".then(() =>"), false);
  assertEquals(/import\(.*nav\.[tj]s"\)/.test(boot), true);
  // The nav runtime is reached by dynamic import only, so it is its own chunk.
  assertEquals(/^import .*nav\.[tj]s/m.test(boot), false);
});

Deno.test("worker.ts: prepare is called, every other runtime export is carried, types are not", () => {
  const src = `
    export async function prepare(env) {}
    export const scheduled = { async scheduled() {} };
    export class Room {}
    const q = { queue() {} };
    export { q as queue };
    export type T = string;
    export interface I {}
    export { type I as J };
    export declare const ambient: number;
    export const enum Flags { A }
  `;
  assertEquals(workerExports("worker.ts", src), {
    prepare: true,
    names: ["scheduled", "Room", "queue"],
  });
  assertEquals(workerExports("worker.ts", "export class Room {}"), {
    prepare: false,
    names: ["Room"],
  });
  assertEquals(workerExports("worker.ts", "export const prepare = (env) => {};").prepare, true);
});

Deno.test("worker.ts: what celld or the Worker cannot take is refused at build time", () => {
  for (
    const [src, why] of [
      ["export default {};", "default export"],
      ["const x = 1; export { x as default };", "default export"],
      ['export * from "./x.ts";', "export *"],
      ["export const { a, b } = {};", "destructured"],
      ["export const prepare = 42;", "must be a function"],
      ["export class prepare {}", "must be a function"],
      ['const x = 1; export { x as "a-b" };', "not a JavaScript name"],
    ]
  ) {
    assertThrows(() => workerExports("worker.ts", src), Error, why, src);
  }
});

/** Write a generated Worker and a stand-in server module, and import the Worker. */
async function loadWorker(
  prepareSrc: string | null,
): Promise<{ fetch(r: Request, env?: unknown, ctx?: unknown): Promise<Response> }> {
  const dir = await Deno.makeTempDir({ dir: tmp });
  await Deno.writeTextFile(
    `${dir}/ssr.ts`,
    `globalThis.__fuSsrRuns = (globalThis.__fuSsrRuns ?? 0) + 1;\n` +
      `export default (req, extra) => Promise.resolve(new Response(JSON.stringify({\n` +
      `  path: new URL(req.url).pathname, env: extra.env, assets: extra.assets,\n` +
      `  prepared: globalThis.__fuPrepared ?? null, waits: typeof extra.waitUntil,\n` +
      `})));\n`,
  );
  let workerPath: string | null = null;
  if (prepareSrc !== null) {
    workerPath = `${dir}/worker.ts`;
    await Deno.writeTextFile(workerPath, prepareSrc);
  }
  const exports = prepareSrc === null
    ? { prepare: false, names: [] }
    : workerExports(workerPath!, prepareSrc);
  await Deno.writeTextFile(`${dir}/entry.ts`, workerModule(workerPath, exports));
  return (await import(`${dir}/entry.ts`)).default;
}

const g = globalThis as { __fuSsrRuns?: number; __fuPrepared?: unknown; __fuPrepareCalls?: number };

Deno.test("the Worker loads the app on the first request, after prepare, once", async () => {
  g.__fuSsrRuns = 0;
  g.__fuPrepared = undefined;
  g.__fuPrepareCalls = 0;
  const worker = await loadWorker(
    `export function prepare(env) {\n` +
      `  globalThis.__fuPrepareCalls++;\n` +
      `  return new Promise((r) => setTimeout(r, 5)).then(() => globalThis.__fuPrepared = env.KEY);\n` +
      `}\n`,
  );
  // Imported, and nothing of the app has run.
  assertEquals(g.__fuSsrRuns, 0);
  const waited: unknown[] = [];
  const ctx = { waitUntil: (p: unknown) => waited.push(p) };
  const env = { KEY: "k", ASSETS: { fetch: () => {} } };
  const [a, b] = await Promise.all([
    worker.fetch(new Request("http://x/a"), env, ctx),
    worker.fetch(new Request("http://x/b"), env, ctx),
  ]);
  const body = await a.json();
  assertEquals([body.path, body.env.KEY, body.prepared, body.waits], ["/a", "k", "k", "function"]);
  assertEquals((await b.json()).path, "/b");
  assertEquals(body.assets !== null, true);
  // Two concurrent first requests: one prepare, one evaluation of the app.
  assertEquals([g.__fuPrepareCalls, g.__fuSsrRuns], [1, 1]);
});

Deno.test("a prepare that fails is tried again on the next request", async () => {
  g.__fuPrepareCalls = 0;
  const worker = await loadWorker(
    `export function prepare() {\n` +
      `  if (++globalThis.__fuPrepareCalls === 1) throw new Error("first fails");\n` +
      `}\n`,
  );
  await assertRejects(() => worker.fetch(new Request("http://x/"), {}), Error, "first fails");
  const res = await worker.fetch(new Request("http://x/"), {});
  assertEquals(res.status, 200);
  assertEquals(g.__fuPrepareCalls, 2);
});

Deno.test("without worker.ts, or a runtime's ctx and ASSETS, the Worker still answers", async () => {
  const worker = await loadWorker(null);
  const body = await (await worker.fetch(new Request("http://x/p"))).json();
  assertEquals([body.path, body.env, body.assets, body.waits], ["/p", {}, null, "undefined"]);
});
