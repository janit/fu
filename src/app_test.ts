import { assertEquals, assertRejects } from "@std/assert";
import { App, compose } from "./app.ts";
import type { Ctx, Middleware } from "./types.ts";

interface S {
  trail: string[];
}

function ctx(path = "/"): Ctx<S> {
  return {
    req: new Request("http://x" + path),
    url: new URL("http://x" + path),
    params: {},
    state: { trail: [] },
    head: {},
    next: () => Promise.reject(new Error("not composed")),
  };
}

Deno.test("registration order is outermost first, so the first unwinds last", async () => {
  const mark = (name: string): Middleware<S> => async (c) => {
    c.state.trail.push(`>${name}`);
    const res = await c.next();
    c.state.trail.push(`<${name}`);
    return res;
  };
  const c = ctx();
  const run = compose<S>([mark("a"), mark("b")], () => {
    c.state.trail.push("handler");
    return new Response("ok");
  });
  await run(c);
  assertEquals(c.state.trail, [">a", ">b", "handler", "<b", "<a"]);
});

Deno.test("a middleware that never calls next() short-circuits everything inside", async () => {
  const c = ctx();
  const run = compose<S>([
    () => new Response("short", { status: 418 }),
    (cc) => {
      cc.state.trail.push("should not run");
      return cc.next();
    },
  ], () => new Response("handler"));
  const res = await run(c);
  assertEquals(res.status, 418);
  assertEquals(c.state.trail, []);
});

Deno.test("an outer middleware still decorates an inner short-circuit", async () => {
  // This is the property the security-headers pattern depends on: headers must
  // land on /healthz and on redirects, not just on rendered pages.
  const run = compose<S>([
    async (c) => {
      const res = await c.next();
      res.headers.set("X-Outer", "1");
      return res;
    },
    () => new Response(null, { status: 301, headers: { location: "/x" } }),
  ], () => new Response("handler"));
  const res = await run(ctx());
  assertEquals(res.status, 301);
  assertEquals(res.headers.get("X-Outer"), "1");
  assertEquals(res.headers.get("location"), "/x");
});

Deno.test("calling next() twice rejects instead of re-running the chain", async () => {
  const run = compose<S>([async (c) => {
    await c.next();
    return await c.next();
  }], () => new Response("handler"));
  await assertRejects(() => run(ctx()), Error, "more than once");
});

Deno.test("state and head are shared in both directions", async () => {
  const c = ctx();
  const run = compose<S>([
    async (cc) => {
      cc.head.title = "set outside";
      const res = await cc.next();
      // written by the terminal handler, visible on the way out
      assertEquals(cc.head.description, "set inside");
      return res;
    },
  ], (cc) => {
    assertEquals(cc.head.title, "set outside");
    cc.head.description = "set inside";
    return new Response("ok");
  });
  await run(c);
  assertEquals(c.head, { title: "set outside", description: "set inside" });
});

Deno.test("a throw propagates past await ctx.next() so it can be caught outside", async () => {
  let seen: unknown = null;
  const run = compose<S>([
    async (c) => {
      try {
        return await c.next();
      } catch (e) {
        seen = e;
        return new Response("handled", { status: 500 });
      }
    },
  ], () => {
    throw new Error("boom");
  });
  const res = await run(ctx());
  assertEquals(res.status, 500);
  assertEquals((seen as Error).message, "boom");
});

Deno.test("App.use records order and chains", () => {
  const a: Middleware<S> = (c) => c.next();
  const b: Middleware<S> = (c) => c.next();
  const app = new App<S>();
  assertEquals(app.use(a).use(b), app);
  assertEquals(app.middleware.length, 2);
  assertEquals(app.middleware[0], a);
});

Deno.test("an App with no middleware still reaches the handler", async () => {
  const run = new App<S>().compose(() => new Response("ok"));
  assertEquals(await (await run(ctx())).text(), "ok");
});

Deno.test("a synchronous throw rejects rather than escaping the chain", async () => {
  // Without this, `run(ctx).catch(...)` never attaches and the throw reaches
  // the server as an unhandled crash instead of an error page.
  const fromMiddleware = compose<S>([() => {
    throw new Error("sync boom");
  }], () => new Response("ok"));
  await assertRejects(() => fromMiddleware(ctx()), Error, "sync boom");

  const fromTerminal = compose<S>([], () => {
    throw new Error("terminal boom");
  });
  await assertRejects(() => fromTerminal(ctx()), Error, "terminal boom");
});
