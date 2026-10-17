import { assertEquals, assertStringIncludes } from "@std/assert";
import { appHandler } from "./testing.ts";

const root = new URL("./_fixtures/app", import.meta.url).pathname;

Deno.test("appHandler builds the app's handler from its source files, no bundler", async () => {
  const handler = await appHandler(root, { assets: { js: [{ href: "/boot.js" }], css: [] } });
  const home = await handler(new Request("http://x/"));
  assertEquals(home.status, 200);
  const html = await home.text();
  assertStringIncludes(html, "<title>Fixture</title>");
  assertStringIncludes(html, '<div id="shell" data-tenant="fixture"><p>home 1</p></div>');
  assertStringIncludes(html, '<script type="module" src="/boot.js"></script>');

  assertStringIncludes(
    await (await handler(new Request("http://x/blog/abc"))).text(),
    "<h1>abc</h1>",
  );
  assertEquals(await (await handler(new Request("http://x/healthz"))).text(), "ok");

  const missing = await handler(new Request("http://x/nope"));
  assertEquals(missing.status, 404);
  assertStringIncludes(await missing.text(), '<main id="err">404</main>');

  const options = await handler(new Request("http://x/", { method: "OPTIONS" }));
  assertEquals(options.headers.get("allow"), "GET, HEAD, OPTIONS");
});

Deno.test("appHandler routes on raw segments and hands rawParams to a page and a middleware", async () => {
  const handler = await appHandler(root);
  const res = await handler(new Request("http://x/s/a%20b%2Fc"));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), '<code data-raw="a%20b%2Fc">a b%2Fc</code>');
  assertEquals(res.headers.get("x-raw-code"), "a%20b%2Fc");
  // One segment: not `/blog/[slug]` with a second one, so no route.
  assertEquals((await handler(new Request("http://x/blog%2Fabc"))).status, 404);
});

/** Every module under src/ that `file` reaches by relative import, itself included. */
async function closure(file: string, seen = new Set<string>()): Promise<Set<string>> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = await Deno.readTextFile(new URL(file, import.meta.url));
  for (const m of text.matchAll(/from\s+"(\.\/[^"]+)"/g)) await closure(m[1], seen);
  return seen;
}

Deno.test("the testing entry loads no bundler: nothing it imports reaches rolldown, lightningcss or nitro", async () => {
  // A test process that imports @janit/fu/testing must not load the bundlers'
  // native addons just to list a project's routes.
  const files = await closure("./testing.ts");
  assertEquals(files.has("./project.ts"), true);
  assertEquals(files.has("./driver.ts") || files.has("./plugins.ts"), false, [...files].join(" "));
  for (const file of files) {
    const text = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(/from\s+"(rolldown|lightningcss|nitro)[/"]/.test(text), false, file);
  }
});

Deno.test("the drivers still export the project scan they always did", async () => {
  const driver = await import("./driver.ts");
  const project = await import("./project.ts");
  assertEquals(driver.scanProject, project.scanProject);
  assertEquals(driver.walk, project.walk);
  assertEquals(driver.optional, project.optional);
});

Deno.test("appHandler defaults to an empty asset list", async () => {
  const handler = await appHandler(root);
  const html = await (await handler(new Request("http://x/"))).text();
  assertEquals(html.includes("<script"), false);
});

Deno.test("appHandler hands every request the env and asset store it was given", async () => {
  const store = { fetch: () => Promise.resolve(new Response("file")) };
  const handler = await appHandler(root, { env: { KEY: "k" }, assetStore: store });
  assertEquals(
    (await (await handler(new Request("http://x/env"))).text()).includes("env k store"),
    true,
  );
  // A request's own extra wins over the defaults, as the runtime's would.
  const other = await handler(new Request("http://x/env"), { env: { KEY: "own" } });
  assertEquals((await other.text()).includes("env own store"), true);
  // A key given as undefined is not given: the defaults stay.
  const unset = await handler(new Request("http://x/env"), { env: undefined, assets: undefined });
  assertEquals((await unset.text()).includes("env k store"), true);
  const bare = await appHandler(root);
  assertEquals(
    (await (await bare(new Request("http://x/env"))).text()).includes("env undefined none"),
    true,
  );
});
