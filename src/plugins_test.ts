import { assertEquals, assertStringIncludes } from "@std/assert";
import { css, hash, jsx, selfAlias } from "./plugins.ts";
import type { Plugin } from "rolldown";

// The plugins expose object-form hooks; call them the way rolldown would.
type Transform = (code: string, id: string) => { code: string; map: unknown } | null;
const run = (p: Plugin, code: string, id: string) =>
  (p.transform as unknown as { handler: Transform }).handler.call({}, code, id);

Deno.test("plain CSS becomes an empty module, and its hash tracks the content", () => {
  const sheets = new Map<string, string>();
  const p = css(sheets);
  const a = run(p, ".x { color: red }", "/a.css")!;
  assertStringIncludes(a.code, "export default {};");
  const b = run(p, ".x { color: blue }", "/a.css")!;
  // Without a content-derived stamp the module would be byte-identical after an
  // edit, rolldown would correctly emit no update, and CSS HMR would never fire.
  assertEquals(a.code === b.code, false);
  assertStringIncludes(sheets.get("/a.css")!, "#00f");
});

Deno.test("CSS modules export scoped names", () => {
  const p = css(new Map());
  const out = run(p, ".button { color: red }", "/x.module.css")!;
  const names = JSON.parse(out.code.match(/export default (\{.*?\});/s)![1]);
  assertEquals(Object.keys(names), ["button"]);
  assertEquals(names.button.endsWith("_button"), true);
  assertEquals(names.button === "button", false);
});

Deno.test("composes yields every class name, not just the first", () => {
  // Dropping the composed names loses those styles silently — no error, the
  // element simply renders unstyled.
  const p = css(new Map());
  const out = run(
    p,
    ".base { padding: 4px } .badge { composes: base; font-weight: 700 }",
    "/y.module.css",
  )!;
  const names = JSON.parse(out.code.match(/export default (\{.*?\});/s)![1]);
  assertEquals(names.badge.split(" ").length, 2);
  assertEquals(names.badge.includes(names.base), true);
});

Deno.test("hash is stable and content-sensitive", () => {
  assertEquals(hash("abc"), hash("abc"));
  assertEquals(hash("abc") === hash("abd"), false);
});

Deno.test("jsx compiles TSX to the preact automatic runtime", () => {
  const out = run(jsx(), "export default function A() { return <b>hi</b>; }", "/routes/a.tsx")!;
  assertStringIncludes(out.code, "preact/jsx-runtime");
  assertEquals(out.code.includes("<b>"), false);
});

Deno.test("jsx never touches node_modules, virtual modules or rolldown's runtime", () => {
  // Transforming rolldown's own runtime strips its internal symbols and the
  // build dies with RUNTIME_MODULE_SYMBOL_NOT_FOUND.
  const p = jsx();
  for (
    const id of [
      "/x/node_modules/preact/index.js",
      "\0rolldown/runtime.js",
      "/x/src/hmr-runtime.js",
    ]
  ) assertEquals(run(p, "const a = 1;", id), null);
});

Deno.test("island exports are stamped for the SSR renderer", () => {
  const out = run(
    jsx({ stampIslands: true, root: "/p" }),
    "export default function Counter() { return null; }",
    "/p/islands/Counter.tsx",
  )!;
  assertStringIncludes(out.code, 'Counter.__island="/islands/Counter.tsx"');
});

Deno.test("stamping only applies to islands, and only with the flag", () => {
  const src = "export default function C() { return null; }";
  assertEquals(
    run(jsx({ stampIslands: true, root: "/p" }), src, "/p/routes/a.tsx")!.code.includes("__island"),
    false,
  );
  assertEquals(run(jsx(), src, "/p/islands/C.tsx")!.code.includes("__island"), false);
});

Deno.test("every export form an island can use gets stamped", () => {
  const p = jsx({ stampIslands: true, root: "/p" });
  const stamp = (src: string) => run(p, src, "/p/islands/C.tsx")!.code;
  // The regex this replaced only caught `export function`, so an arrow
  // component rendered and then silently never hydrated.
  assertStringIncludes(stamp("export const A = () => null;"), 'A.__island="/islands/C.tsx#A"');
  assertStringIncludes(stamp("export const B = function () { return null; };"), "B.__island");
  assertStringIncludes(stamp("export function D() { return null; }"), "D.__island");
  assertStringIncludes(stamp("export default function E() { return null; }"), "E.__island");
  assertStringIncludes(stamp("const F = () => null; export { F };"), "F.__island");
  assertStringIncludes(stamp("export const G = () => null, H = () => null;"), "G.__island");
  assertStringIncludes(stamp("export const G = () => null, H = () => null;"), "H.__island");
});

Deno.test("each export is keyed by its exported name, so the client picks the right one", () => {
  const p = jsx({ stampIslands: true, root: "/p" });
  const stamp = (src: string) => run(p, src, "/p/islands/W.tsx")!.code;
  const two = stamp("export const Counter = () => null; export const Toggle = () => null;");
  assertStringIncludes(two, 'Counter.__island="/islands/W.tsx#Counter"');
  assertStringIncludes(two, 'Toggle.__island="/islands/W.tsx#Toggle"');
  assertStringIncludes(
    stamp("const F = () => null; export { F as Fancy };"),
    'F.__island="/islands/W.tsx#Fancy"',
  );
  assertStringIncludes(
    stamp("const F = () => null; export { F as default };"),
    'F.__island="/islands/W.tsx"',
  );
  assertStringIncludes(
    stamp("export default function E() { return null; }"),
    'E.__island="/islands/W.tsx"',
  );
});

Deno.test("an anonymous default export is named so it can be stamped", () => {
  const out = run(
    jsx({ stampIslands: true, root: "/p" }),
    "export default () => null;",
    "/p/islands/C.tsx",
  )!;
  assertStringIncludes(out.code, "const __fu_default =");
  assertStringIncludes(out.code, "export default __fu_default;");
  assertStringIncludes(out.code, '__fu_default.__island="/islands/C.tsx"');
  // The rewrite shifts positions, so the sourcemap is dropped rather than lied about.
  assertEquals(out.map, null);
});

Deno.test("things with no runtime binding are never stamped", () => {
  const p = jsx({ stampIslands: true, root: "/p" });
  const stamp = (src: string) => run(p, src, "/p/islands/C.tsx")!.code;
  // Re-exports bind nothing locally; types do not exist at runtime.
  assertEquals(stamp('export { X } from "./other.ts";').includes("__island"), false);
  assertEquals(stamp('export * from "./other.ts";').includes("__island"), false);
  assertEquals(stamp("export type T = { a: 1 };").includes("__island"), false);
  assertEquals(stamp("export interface I { a: 1 }").includes("__island"), false);
  assertEquals(stamp('export type { T } from "./t.ts";').includes("__island"), false);
});

Deno.test("the hmr flag makes an island accept its own updates", () => {
  const out = run(
    jsx({ hmr: true, root: "/p" }),
    "export default function C() { return null; }",
    "/p/islands/C.tsx",
  )!;
  assertStringIncludes(out.code, "import.meta.hot.accept");
  assertStringIncludes(out.code, "__fu_hmr__");
});

Deno.test("selfAlias maps the package name and its subpaths onto the runtime dir", () => {
  const p = selfAlias("@janit/fu", "/fw/src", ".ts");
  const resolve = (p.resolveId as (id: string) => string | null).bind({});
  assertEquals(resolve("@janit/fu"), "/fw/src/mod.ts");
  assertEquals(resolve("@janit/fu/errors"), "/fw/src/errors.ts");
  assertEquals(resolve("@janit/fu-other"), null);
  assertEquals(resolve("preact"), null);
});

Deno.test("what a file is depends on its place in the project, not on words in its path", () => {
  const src = "export default function C() { return <b>x</b>; }";
  // A project under a directory called `rolldown-demo` got no transform at all.
  const demo = jsx({ stampIslands: true, root: "/home/me/rolldown-demo" });
  assertStringIncludes(
    run(demo, src, "/home/me/rolldown-demo/routes/a.tsx")!.code,
    "preact/jsx-runtime",
  );
  // A page at /islands is a page, and so is every route of a project that
  // lives under a directory called `islands`.
  const p = jsx({ stampIslands: true, root: "/x/islands/app" });
  const stamped = (id: string) => run(p, src, id)!.code.includes("__island");
  assertEquals(stamped("/x/islands/app/routes/islands/index.tsx"), false);
  assertEquals(stamped("/x/islands/app/routes/index.tsx"), false);
  assertStringIncludes(
    run(p, src, "/x/islands/app/islands/C.tsx")!.code,
    'C.__island="/islands/C.tsx"',
  );
  assertStringIncludes(
    run(p, src, "/x/islands/app/islands/sub/D.tsx?v=1")!.code,
    'C.__island="/islands/sub/D.tsx"',
  );
  // The project's own dependencies are still left alone.
  assertEquals(run(p, src, "/x/islands/app/node_modules/pkg/islands/C.tsx"), null);
});

Deno.test("a CSS module compiles to the same JS every time", () => {
  // lightningcss lists the exports in no fixed order, and the order reached the
  // chunk hash: half of all rebuilds of unchanged source renamed every file.
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    seen.add(run(css(new Map()), ".button{color:red}.badge{color:blue}", "/z.module.css")!.code);
  }
  assertEquals(seen.size, 1);
});

Deno.test("a stylesheet nothing imports any more leaves the collection", () => {
  const sheets = new Map<string, string>();
  let changes = 0;
  const p = css(sheets, () => changes++);
  run(p, ".a{color:red}", "/a.css");
  run(p, ".b{color:red}", "/b.css");
  changes = 0;
  const buildEnd = p.buildEnd as unknown as (this: { getModuleIds(): string[] }) => void;
  buildEnd.call({ getModuleIds: () => ["/a.css", "/b.css", "/x.tsx"] });
  assertEquals([[...sheets.keys()], changes], [["/a.css", "/b.css"], 0]);
  buildEnd.call({ getModuleIds: () => ["/a.css", "/x.tsx"] });
  assertEquals([[...sheets.keys()], changes], [["/a.css"], 1]);
});
