import { assertEquals } from "@std/assert";
import { assertRejects, assertStringIncludes } from "@std/assert";
import { build, clearOutput, presetOption } from "./build.ts";

async function tree(files: string[]): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const f of files) {
    await Deno.mkdir(`${dir}/${f}`.replace(/\/[^/]+$/, ""), { recursive: true });
    await Deno.writeTextFile(`${dir}/${f}`, "");
  }
  return dir;
}
const exists = (p: string) => Deno.stat(p).then(() => true, () => false);

Deno.test("the default output dir, and one nitro made, are cleared whole", async () => {
  const ours = await tree(["public/_fu/old-abc.js", "deno.json"]);
  const nitros = await tree(["nitro.json", "public/_fu/old-abc.js", "deno.json"]);
  try {
    clearOutput(ours, true);
    clearOutput(nitros, false);
    assertEquals([await exists(ours), await exists(nitros)], [false, false]);
  } finally {
    await Deno.remove(ours, { recursive: true }).catch(() => {});
    await Deno.remove(nitros, { recursive: true }).catch(() => {});
  }
});

Deno.test("in a custom dir with no nitro.json only what the build writes is cleared", async () => {
  // A build that died half-way leaves no nitro.json, and its hashed assets
  // would ship with every later build; but the dir may hold a stranger's files.
  const dir = await tree([
    "public/_fu/old-abc.js",
    "server/index.mjs",
    "keep.txt",
    "public/robots.txt",
  ]);
  try {
    clearOutput(dir, false);
    assertEquals(
      [
        await exists(`${dir}/public/_fu`),
        await exists(`${dir}/server`),
        await exists(`${dir}/keep.txt`),
        await exists(`${dir}/public/robots.txt`),
      ],
      [false, false, true, true],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the build is portable unless the environment names a platform", () => {
  assertEquals(presetOption(undefined), { preset: "node-server" });
  assertEquals(presetOption(""), { preset: "node-server" });
  // Left out, so nitro reads NITRO_PRESET itself.
  assertEquals(presetOption("deno-server"), {});
});

/** A small real project, with the repo's node_modules linked in so it resolves preact. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir();
  for (const [file, text] of Object.entries(files)) {
    await Deno.mkdir(`${root}/${file}`.replace(/\/[^/]+$/, ""), { recursive: true });
    await Deno.writeTextFile(`${root}/${file}`, text);
  }
  await Deno.symlink(new URL("../node_modules", import.meta.url).pathname, `${root}/node_modules`);
  return root;
}

// rolldown and nitro hold native handles past the end of a build.
const real = { sanitizeResources: false, sanitizeOps: false };

Deno.test(
  "a real build: one stylesheet in cascade order, islands mapped, old output gone",
  real,
  async () => {
    const root = await project({
      "routes/index.tsx":
        `import "./route.css";\nimport I from "../islands/I.tsx";\nexport default () => <main><I /></main>;\n`,
      "routes/route.css": ".x { color: red }",
      "islands/I.tsx":
        `import "./island.css";\nexport default function I() { return <b class="x">i</b>; }\n`,
      "islands/island.css": ".x { color: blue }",
      ".output/public/_fu/old-abc.js": "stale",
    });
    const log = console.log;
    console.log = () => {};
    try {
      await build({ root });
      const client = [...Deno.readDirSync(`${root}/dist/client`)].map((e) => e.name);
      const sheet = client.find((f) => /^style-.*\.css$/.test(f))!;
      // Route CSS first, island CSS after it, as in dev.
      assertEquals(
        await Deno.readTextFile(`${root}/dist/client/${sheet}`),
        ".x{color:red}\n.x{color:#00f}",
      );

      const entry = await Deno.readTextFile(`${root}/.fu/ssr.ts`);
      const assets = JSON.parse(entry.match(/const assets = (.*);/)![1]);
      assertEquals(assets.css, [{ href: `/_fu/${sheet}` }]);
      assertEquals(Object.keys(assets.islands), ["/islands/I.tsx"]);
      assertEquals(client.includes(assets.islands["/islands/I.tsx"].slice("/_fu/".length)), true);
      assertEquals(/^\/_fu\/boot-.+\.js$/.test(assets.js[0].href), true);

      assertEquals(
        JSON.parse(await Deno.readTextFile(`${root}/.output/nitro.json`)).preset,
        "node-server",
      );
      assertEquals(await exists(`${root}/.output/server/index.mjs`), true);
      assertEquals(await exists(`${root}/.output/public/_fu/old-abc.js`), false);
      assertEquals(await exists(`${root}/.output/public/_fu/${sheet}`), true);
    } finally {
      console.log = log;
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "a real build fails on an import of the app's that resolves to nothing",
  real,
  async () => {
    const root = await project({
      "routes/index.tsx": `import "not-installed-anywhere";\nexport default () => <p>x</p>;\n`,
    });
    const log = console.log;
    console.log = () => {};
    try {
      const err = await assertRejects(() => build({ root }));
      assertStringIncludes(String(err), "not-installed-anywhere");
    } finally {
      console.log = log;
      await Deno.remove(root, { recursive: true });
    }
  },
);
