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
    jsx({ stampIslands: true }),
    "export default function Counter() { return null; }",
    "/p/islands/Counter.tsx",
  )!;
  assertStringIncludes(out.code, 'Counter.__island="/islands/Counter.tsx"');
});

Deno.test("stamping only applies to islands, and only with the flag", () => {
  const src = "export default function C() { return null; }";
  assertEquals(
    run(jsx({ stampIslands: true }), src, "/p/routes/a.tsx")!.code.includes("__island"),
    false,
  );
  assertEquals(run(jsx(), src, "/p/islands/C.tsx")!.code.includes("__island"), false);
});

Deno.test("every export form an island can use gets stamped", () => {
  const p = jsx({ stampIslands: true });
  const stamp = (src: string) => run(p, src, "/p/islands/C.tsx")!.code;
  // The regex this replaced only caught `export function`, so an arrow
  // component rendered and then silently never hydrated.
  assertStringIncludes(stamp("export const A = () => null;"), 'A.__island="/islands/C.tsx"');
  assertStringIncludes(stamp("export const B = function () { return null; };"), "B.__island");
  assertStringIncludes(stamp("export function D() { return null; }"), "D.__island");
  assertStringIncludes(stamp("export default function E() { return null; }"), "E.__island");
  assertStringIncludes(stamp("const F = () => null; export { F };"), "F.__island");
  assertStringIncludes(stamp("export const G = () => null, H = () => null;"), "G.__island");
  assertStringIncludes(stamp("export const G = () => null, H = () => null;"), "H.__island");
});

Deno.test("an anonymous default export is named so it can be stamped", () => {
  const out = run(jsx({ stampIslands: true }), "export default () => null;", "/p/islands/C.tsx")!;
  assertStringIncludes(out.code, "const __fu_default =");
  assertStringIncludes(out.code, "export default __fu_default;");
  assertStringIncludes(out.code, '__fu_default.__island="/islands/C.tsx"');
  // The rewrite shifts positions, so the sourcemap is dropped rather than lied about.
  assertEquals(out.map, null);
});

Deno.test("things with no runtime binding are never stamped", () => {
  const p = jsx({ stampIslands: true });
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
    jsx({ hmr: true }),
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
