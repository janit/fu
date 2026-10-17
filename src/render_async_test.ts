import { assertEquals, assertStringIncludes } from "@std/assert";
import { Component, type ComponentChildren, createContext, h } from "preact";
import { useContext, useState } from "preact/hooks";
import { createHandler, FuHead, FuScripts } from "./render.ts";
import { HttpError } from "./errors.ts";
import type { Assets, Ctx, RouteManifest } from "./types.ts";

const assets: Assets = { js: [{ href: "/boot.js" }], css: [] };
const get = (handler: (req: Request) => Promise<Response>, p: string) =>
  handler(new Request("http://x" + p));
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Run `fn` with console.error captured; returns what was logged, as one string. */
async function logged(fn: () => Promise<void>): Promise<string> {
  const orig = console.error;
  const out: unknown[] = [];
  console.error = (...a: unknown[]) => out.push(...a);
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return out.map(String).join("\n");
}

type S = { title?: string; order?: string[] };
const page = (def: unknown): RouteManifest<S> => ({
  "/routes/index.tsx": () => Promise.resolve({ default: def as never }),
});
/** A shell that shows what the page left on ctx.state. */
const Shell = ({ ctx, children }: { ctx: Ctx<S>; children: ComponentChildren }) => {
  ctx.state.order?.push("shell");
  return h("div", { id: "shell", "data-title": ctx.state.title ?? "none" }, children);
};

Deno.test("an async page is awaited and rendered", async () => {
  const handler = createHandler<S>({
    manifest: page(async (ctx: Ctx<S>) => {
      await tick();
      return h("h1", null, "async " + ctx.url.pathname);
    }),
    assets,
  });
  const res = await get(handler, "/");
  assertEquals(res.status, 200);
  assertEquals(
    await res.text(),
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
      '<body><h1>async /</h1><script type="module" src="/boot.js"></script></body></html>',
  );
});

Deno.test("an async page runs before the shell, which sees what it wrote on ctx.state", async () => {
  const order: string[] = [];
  const handler = createHandler<S>({
    manifest: page(async (ctx: Ctx<S>) => {
      await tick();
      ctx.state.title = "from the page";
      ctx.head.title = "T";
      ctx.state.order!.push("page");
      return h("p", null, "body");
    }),
    assets,
    Shell,
    initialState: () => ({ order }),
  });
  const html = await (await get(handler, "/")).text();
  assertStringIncludes(html, '<div id="shell" data-title="from the page"><p>body</p></div>');
  assertStringIncludes(html, "<title>T</title>");
  assertEquals(order, ["page", "shell"]);
});

Deno.test("a synchronous page still renders inside the tree: after the shell, hooks work", async () => {
  const order: string[] = [];
  const Theme = createContext("light");
  const handler = createHandler<S>({
    manifest: page((ctx: Ctx<S>) => {
      const [n] = useState(7);
      ctx.state.order!.push("page");
      return h("p", null, `${n} ${useContext(Theme)}`);
    }),
    assets,
    Shell: ({ ctx, children }) => {
      ctx.state.order!.push("shell");
      return h(Theme.Provider, { value: "dark" }, h("div", { id: "shell" }, children));
    },
    initialState: () => ({ order }),
  });
  const html = await (await get(handler, "/")).text();
  assertStringIncludes(html, '<body><div id="shell"><p>7 dark</p></div><script');
  assertEquals(order, ["shell", "page"]);
});

Deno.test("an async page may resolve to text, an array or nothing", async () => {
  for (
    const [value, want] of [
      ["just text", "<body>just text<script"],
      [[h("i", null, "a"), h("b", null, "b")], "<body><i>a</i><b>b</b><script"],
      [null, "<body><script"],
    ] as const
  ) {
    const handler = createHandler<S>({ manifest: page(() => Promise.resolve(value)), assets });
    // Not declared async: these three are the "returns a promise" failures below.
    const asyncPage = createHandler<S>({
      manifest: page(async () => {
        await tick();
        return value;
      }),
      assets,
    });
    assertStringIncludes(await (await get(asyncPage, "/")).text(), want);
    await logged(async () => assertEquals((await get(handler, "/")).status, 500));
  }
});

Deno.test("an async page that rejects goes through the normal error path", async () => {
  const manifest: RouteManifest<S> = {
    "/routes/gone.tsx": () =>
      Promise.resolve({
        default: (async () => {
          await tick();
          throw new HttpError(410, "Went away");
        }) as never,
      }),
    "/routes/boom.tsx": () =>
      Promise.resolve({
        default: (async () => {
          await tick();
          throw new Error("secret");
        }) as never,
      }),
  };
  const handler = createHandler<S>({
    manifest,
    assets,
    Shell,
    ErrorPage: (ctx) => h("main", null, `${ctx.error?.status}: ${ctx.error?.message}`),
  });
  const gone = await get(handler, "/gone");
  assertEquals([gone.status, gone.headers.get("cache-control")], [410, "no-store"]);
  assertStringIncludes(await gone.text(), "<main>410: Went away</main>");
  const log = await logged(async () => {
    const boom = await get(handler, "/boom");
    assertEquals(boom.status, 500);
    const html = await boom.text();
    assertStringIncludes(html, "<main>500: Internal Server Error</main>");
    assertEquals(html.includes("secret"), false);
  });
  assertStringIncludes(log, "secret");
});

Deno.test("what a page wrote on ctx.state before it failed is still there for the error page", async () => {
  // ctx.head is reset on the error path; ctx.state is the app's and is not.
  const handler = createHandler<S>({
    manifest: page(async (ctx: Ctx<S>) => {
      ctx.state.title = "half done";
      await tick();
      throw new HttpError(404);
    }),
    assets,
    Shell,
    ErrorPage: (ctx) => h("main", null, `saw ${ctx.state.title}`),
  });
  const html = await (await get(handler, "/")).text();
  assertStringIncludes(html, '<div id="shell" data-title="half done"><main>saw half done</main>');
});

Deno.test("an async error page is awaited, and runs before the shell", async () => {
  const order: string[] = [];
  const handler = createHandler<S>({
    manifest: {},
    assets,
    Shell,
    ErrorPage: async (ctx) => {
      await tick();
      ctx.state.title = "error " + ctx.error?.status;
      ctx.state.order!.push("error");
      return h("main", { id: "err" }, ctx.error?.message);
    },
    initialState: () => ({ order }),
  });
  const res = await get(handler, "/nope");
  assertEquals([res.status, res.headers.get("cache-control")], [404, "no-store"]);
  const html = await res.text();
  assertStringIncludes(
    html,
    '<div id="shell" data-title="error 404"><main id="err">Not Found</main></div>',
  );
  // Nothing of the renderer's suspense machinery: the page was awaited, not suspended.
  assertEquals(html.includes("<!--$s-->"), false);
  assertEquals(order, ["error", "shell"]);
});

Deno.test("an async error page that rejects falls back like one that throws", async () => {
  const handler = createHandler<S>({
    manifest: {},
    assets,
    ErrorPage: async () => {
      await tick();
      throw new Error("error page is broken too");
    },
  });
  let res!: Response;
  const log = await logged(async () => {
    res = await get(handler, "/nope");
  });
  assertEquals([res.status, res.headers.get("content-type")], [
    404,
    "text/plain; charset=utf-8",
  ]);
  assertEquals(await res.text(), "404 Not Found");
  assertStringIncludes(log, "the error page itself threw");
});

Deno.test("islands in what an async page resolved to get their markers and preloads", async () => {
  const Island = Object.assign((p: { n: number }) => h("b", null, String(p.n)), {
    __island: "/islands/W.tsx",
  });
  const handler = createHandler<S>({
    manifest: page(async () => {
      await tick();
      return h("main", null, h(Island, { n: 3 }));
    }),
    assets: {
      ...assets,
      islands: { "/islands/W.tsx": "/_fu/W-abc.js", "/islands/Other.tsx": "/_fu/Other-def.js" },
    },
    Shell,
  });
  const html = await (await get(handler, "/")).text();
  assertStringIncludes(
    html,
    '<main><div data-island="/islands/W.tsx" data-props="{&quot;n&quot;:3}"><b>3</b></div></main>',
  );
  assertStringIncludes(html, '<link rel="modulepreload" href="/_fu/W-abc.js">');
  assertEquals(html.includes("Other-def"), false);
});

Deno.test("an async shell is awaited too, after the page", async () => {
  const order: string[] = [];
  const handler = createHandler<S>({
    manifest: page(async (ctx: Ctx<S>) => {
      await tick();
      ctx.state.order!.push("page");
      return h("p", null, "body");
    }),
    assets,
    Shell: (async ({ ctx, children }: { ctx: Ctx<S>; children: ComponentChildren }) => {
      await tick();
      ctx.state.order!.push("shell");
      return h(
        "html",
        { lang: "fi" },
        h("head", null, h(FuHead, null)),
        h("body", null, children, h(FuScripts, null)),
      );
    }) as never,
    initialState: () => ({ order }),
  });
  const html = await (await get(handler, "/")).text();
  assertEquals(
    html,
    '<!doctype html><html lang="fi"><head></head><body><p>body</p>' +
      '<script type="module" src="/boot.js"></script></body></html>',
  );
  assertEquals(order, ["page", "shell"]);
});

Deno.test("an async shell that rejects is a failure, not an empty page", async () => {
  const handler = createHandler<S>({
    manifest: page(() => h("p", null, "body")),
    assets,
    Shell: (async () => {
      await tick();
      throw new Error("shell is broken");
    }) as never,
    ErrorPage: () => h("main", null, "err"),
  });
  let res!: Response;
  const log = await logged(async () => {
    res = await get(handler, "/");
  });
  assertEquals(res.status, 500);
  assertEquals(await res.text(), "500 Internal Server Error");
  assertStringIncludes(log, "shell is broken");
});

Deno.test("a page that returns a promise without being async fails, naming it", async () => {
  // It cannot be called outside the renderer (it may use hooks), and inside it
  // the renderer drops a promise without a word.
  function Leaky() {
    return Promise.resolve(h("p", null, "never shown"));
  }
  const handler = createHandler<S>({ manifest: page(Leaky), assets });
  let res!: Response;
  const log = await logged(async () => {
    res = await get(handler, "/");
  });
  assertEquals(res.status, 500);
  assertStringIncludes(log, "Leaky");
  assertStringIncludes(log, "/routes/index.tsx");
  assertStringIncludes(log, "returned a promise");
});

Deno.test("an error page or shell that returns a promise without being async fails too", async () => {
  function LeakyError() {
    return Promise.resolve(h("p", null, "never shown"));
  }
  const errorPage = createHandler<S>({ manifest: {}, assets, ErrorPage: LeakyError });
  let res!: Response;
  let log = await logged(async () => {
    res = await get(errorPage, "/nope");
  });
  assertEquals([res.status, await res.text()], [404, "404 Not Found"]);
  assertStringIncludes(log, "routes/_error");
  assertStringIncludes(log, "LeakyError");

  function LeakyShell() {
    return Promise.resolve(h("p", null, "never shown"));
  }
  const shell = createHandler<S>({
    manifest: page(() => h("p", null)),
    assets,
    Shell: LeakyShell as never,
  });
  log = await logged(async () => {
    res = await get(shell, "/");
  });
  assertEquals(res.status, 500);
  assertStringIncludes(log, "routes/_app");
  assertStringIncludes(log, "LeakyShell");
});

Deno.test("a class page whose render() returns a promise fails, naming it", async () => {
  class LeakyClass extends Component {
    override render() {
      return Promise.resolve(h("p", null, "never shown")) as never;
    }
  }
  class Fine extends Component<{ url: URL }> {
    override render() {
      return h("p", null, "class " + this.props.url.pathname);
    }
  }
  let res!: Response;
  const log = await logged(async () => {
    res = await get(createHandler<S>({ manifest: page(LeakyClass), assets }), "/");
  });
  assertEquals(res.status, 500);
  assertStringIncludes(log, "LeakyClass");
  assertStringIncludes(log, "returned a promise");
  // A class page that behaves is rendered as before.
  const ok = await get(createHandler<S>({ manifest: page(Fine), assets }), "/");
  assertStringIncludes(await ok.text(), "<body><p>class /</p><script");
});

Deno.test("an island as the page fails the render, async or not, and is never served unmarked", async () => {
  // A page's props are the request context, which is not JSON, so an island
  // there has always failed on its props. An async one used to slip past
  // that: fu called it itself and served its markup with no marker at all.
  const stamp = <T>(c: T): T => Object.assign(c as object, { __island: "/islands/P.tsx" }) as T;
  // deno-lint-ignore require-await
  const asyncIsland = stamp(async function AsyncIsland() {
    return h("b", null, "no marker");
  });
  const syncIsland = stamp(function SyncIsland() {
    return h("b", null, "island page");
  });
  for (
    const [def, why] of [
      [asyncIsland, "the page component of /routes/index.tsx (AsyncIsland) is an island"],
      [syncIsland, "island props must be JSON"],
    ] as const
  ) {
    let res!: Response;
    const log = await logged(async () => {
      res = await get(createHandler<S>({ manifest: page(def), assets }), "/");
    });
    assertEquals([res.status, await res.text()], [500, "500 Internal Server Error"]);
    assertStringIncludes(log, why);
  }
});

Deno.test("an async component inside the tree fails the render, naming it", async () => {
  // Only the page, the error page and the shell can be awaited: fu calls
  // those itself. Anywhere else the renderer would drop the promise.
  // deno-lint-ignore require-await
  async function Sidebar() {
    return h("aside", null, "never shown");
  }
  const sync = createHandler<S>({
    manifest: page(() => h("main", null, h(Sidebar as never, null))),
    assets,
  });
  const inAsync = createHandler<S>({
    manifest: page(async () => {
      await tick();
      return h("main", null, h(Sidebar as never, null));
    }),
    assets,
  });
  for (const handler of [sync, inAsync]) {
    let res!: Response;
    const log = await logged(async () => {
      res = await get(handler, "/");
    });
    assertEquals(res.status, 500);
    assertStringIncludes(log, "Sidebar");
    assertStringIncludes(log, "async");
  }
});
