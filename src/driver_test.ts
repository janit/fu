import { assertEquals, assertStringIncludes } from "@std/assert";
import { mergeSheets, optional, scanProject, ssrModule, walk } from "./driver.ts";

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

Deno.test("the dev entry guards the Host header, the built one does not", () => {
  const project = { routeFiles: [], root: "/p", appPath: null, shellPath: null, errorPath: null };
  const dev = ssrModule(project, assets, { hosts: ["localhost", "127.0.0.1"] });
  assertStringIncludes(
    dev,
    'onlyHosts(createHandler({ manifest, assets }), ["localhost","127.0.0.1"])',
  );
  assertEquals(ssrModule(project, assets).includes("onlyHosts"), false);
});

Deno.test("the built entry leaves everything under the asset prefix to nitro", () => {
  // Nitro puts the hashed assets' year-long max-age on whatever the app
  // answers under the prefix, after the app has answered. Only an error nitro
  // renders itself escapes that, so the entry raises one instead of routing.
  const project = { routeFiles: [], root: "/p", appPath: null, shellPath: null, errorPath: null };
  const built = ssrModule(project, assets, { assetsPrefix: "/_fu/" });
  assertStringIncludes(built, 'import { HTTPError } from "nitro/h3";');
  assertStringIncludes(built, 'path === "/_fu" || path.startsWith("/_fu/")');
  assertStringIncludes(built, '"cache-control": "no-store"');
  assertEquals(ssrModule(project, assets).includes("HTTPError"), false);
});
