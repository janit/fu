import { assertEquals, assertStringIncludes } from "@std/assert";
import { optional, ssrModule, walk } from "./driver.ts";

const tmp = await Deno.makeTempDir();
const assets = { js: [], css: [] };

Deno.test("walk finds routes and skips framework files", async () => {
  const root = await Deno.makeTempDir();
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

Deno.test("ssrModule unwraps the Request from nitro's H3Event", () => {
  // Nitro invokes the handler with an H3Event, which exposes url/headers but
  // has no json()/text()/formData(). Without the unwrap every body read fails.
  const out = ssrModule({
    routeFiles: [],
    root: "/p",
    appPath: null,
    shellPath: null,
    errorPath: null,
  }, assets);
  assertStringIncludes(out, "input instanceof Request");
  assertStringIncludes(out, "input?.req");
});
