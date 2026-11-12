import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { envPort, serveWorker, type WorkerModule } from "./serve.ts";

const dir = await Deno.makeTempDir();
await Deno.writeTextFile(`${dir}/hello.txt`, "hello");
addEventListener("unload", () => Deno.removeSync(dir, { recursive: true }));

function freePort(): number {
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

async function withServer(
  worker: WorkerModule,
  fn: (base: string) => Promise<void>,
  env: Record<string, unknown> = {},
): Promise<void> {
  const served = await serveWorker(worker, {
    port: freePort(),
    hostname: "127.0.0.1",
    publicDir: dir,
    env,
    exitOnSignal: false,
  });
  try {
    await fn(served.url.replace(/\/$/, ""));
  } finally {
    await served.close();
  }
}

Deno.test("the worker gets the request, the env it was given, and the directory as env.ASSETS", async () => {
  const worker: WorkerModule = {
    async fetch(req, env) {
      const file = await (env.ASSETS as { fetch(r: Request): Promise<Response> }).fetch(
        new Request(new URL("/hello.txt", req.url)),
      );
      return new Response(
        `${req.method} ${new URL(req.url).pathname} ${env.KEY} ${await file.text()}`,
      );
    },
  };
  await withServer(worker, async (base) => {
    assertEquals(await (await fetch(base + "/x?y=1")).text(), "GET /x KEY-VALUE hello");
  }, { KEY: "KEY-VALUE" });
});

Deno.test("a request body reaches the worker", async () => {
  const worker: WorkerModule = { fetch: async (req) => new Response(await req.text()) };
  await withServer(worker, async (base) => {
    const res = await fetch(base + "/", { method: "POST", body: "payload" });
    assertEquals(await res.text(), "payload");
  });
});

Deno.test("waitUntil lets the work run, and a failure in it is logged, not fatal", async () => {
  const logged: unknown[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => logged.push(a.join(" "));
  let ran = false;
  const worker: WorkerModule = {
    fetch(_req, _env, ctx) {
      ctx.waitUntil(new Promise((r) => setTimeout(r, 10)).then(() => ran = true));
      ctx.waitUntil(Promise.reject(new Error("background failed")));
      return new Response("sent first");
    },
  };
  try {
    await withServer(worker, async (base) => {
      // close() waits for waitUntil work, so no sleep is needed.
      assertEquals(await (await fetch(base + "/")).text(), "sent first");
    });
  } finally {
    console.error = error;
  }
  assertEquals(ran, true);
  assertEquals(logged.length, 1);
  assertStringIncludes(String(logged[0]), "background failed");
});

Deno.test("a worker that throws is a 500 nobody caches, and the next request is tried again", async () => {
  const error = console.error;
  console.error = () => {};
  let calls = 0;
  const worker: WorkerModule = {
    fetch() {
      if (++calls === 1) throw new Error("prepare failed");
      return new Response("recovered");
    },
  };
  try {
    await withServer(worker, async (base) => {
      const first = await fetch(base + "/");
      assertEquals([first.status, first.headers.get("cache-control")], [500, "no-store"]);
      await first.body?.cancel();
      assertEquals(await (await fetch(base + "/")).text(), "recovered");
    });
  } finally {
    console.error = error;
  }
});

Deno.test("the environment is the process's when none is given", async () => {
  Deno.env.set("FU_SERVE_TEST", "from-process");
  const worker: WorkerModule = { fetch: (_r, env) => new Response(String(env.FU_SERVE_TEST)) };
  const served = await serveWorker(worker, {
    port: freePort(),
    hostname: "127.0.0.1",
    exitOnSignal: false,
  });
  try {
    assertEquals(await (await fetch(served.url)).text(), "from-process");
  } finally {
    await served.close();
    Deno.env.delete("FU_SERVE_TEST");
  }
});

Deno.test("a PORT that is not a port number is refused, naming PORT", async () => {
  const worker: WorkerModule = { fetch: () => new Response("") };
  for (const bad of ["abc", "8080x", "0x50", "70000", "0"]) {
    Deno.env.set("PORT", bad);
    try {
      await assertRejects(
        () => serveWorker(worker, { hostname: "127.0.0.1", exitOnSignal: false }),
        Error,
        "PORT",
        bad,
      );
    } finally {
      Deno.env.delete("PORT");
    }
  }
});

Deno.test("an empty HOST is no HOST", async () => {
  Deno.env.set("HOST", "");
  try {
    const served = await serveWorker({ fetch: () => new Response("up") }, {
      port: freePort(),
      exitOnSignal: false,
    });
    try {
      assertEquals(await (await fetch(served.url.replace("0.0.0.0", "127.0.0.1"))).text(), "up");
    } finally {
      await served.close();
    }
  } finally {
    Deno.env.delete("HOST");
  }
});

Deno.test("close waits for waitUntil work in flight, as a Workers runtime lets it finish", async () => {
  let done = false;
  const worker: WorkerModule = {
    fetch(_req, _env, ctx) {
      ctx.waitUntil(new Promise((r) => setTimeout(r, 150)).then(() => done = true));
      return new Response("sent first");
    },
  };
  const served = await serveWorker(worker, {
    port: freePort(),
    hostname: "127.0.0.1",
    exitOnSignal: false,
  });
  assertEquals(await (await fetch(served.url)).text(), "sent first");
  await served.close();
  assertEquals(done, true);
});

Deno.test("envPort reads digits only, and no PORT is 3000", () => {
  assertEquals(envPort(undefined), 3000);
  assertEquals(envPort(""), 3000);
  assertEquals(envPort("0080"), 80);
  assertEquals(envPort("65535"), 65535);
});

Deno.test("a valid PORT is the port served on, and the url reports it", async () => {
  const port = freePort();
  Deno.env.set("PORT", String(port));
  try {
    const served = await serveWorker({ fetch: () => new Response("on PORT") }, {
      hostname: "127.0.0.1",
      exitOnSignal: false,
    });
    try {
      assertStringIncludes(served.url, `:${port}`);
      assertEquals(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "on PORT");
    } finally {
      await served.close();
    }
  } finally {
    Deno.env.delete("PORT");
  }
});

Deno.test("serveWorker rejects naming the host and port when the port is already bound", async () => {
  const held = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (held.addr as Deno.NetAddr).port;
  try {
    await assertRejects(
      () =>
        serveWorker({ fetch: () => new Response("") }, {
          port,
          hostname: "127.0.0.1",
          exitOnSignal: false,
        }),
      Error,
      `could not listen on 127.0.0.1:${port}`,
    );
  } finally {
    held.close();
  }
});

Deno.test("the runner exits 0 on SIGTERM, finishing waitUntil work and releasing its port", async () => {
  const port = freePort();
  const marker = `${dir}/sigterm-done`;
  const script = `${dir}/sigterm-runner.ts`;
  await Deno.writeTextFile(
    script,
    `import { serveWorker } from ${JSON.stringify(new URL("./serve.ts", import.meta.url).href)};
await serveWorker({
  fetch(_req, _env, ctx) {
    ctx.waitUntil(new Promise((r) => setTimeout(r, 300)).then(() =>
      Deno.writeTextFile(${JSON.stringify(marker)}, "done")
    ));
    return new Response("sent first");
  },
}, { port: ${port}, hostname: "127.0.0.1" });
console.log("ready");
`,
  );
  const child = new Deno.Command(Deno.execPath(), {
    // From the repo, so the script outside it resolves serve.ts's dependencies.
    args: ["run", "-A", "--config", new URL("../deno.json", import.meta.url).pathname, script],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let out = "";
  while (!out.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) break;
    out += value;
  }
  await reader.cancel();
  assertEquals(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "sent first");
  child.kill("SIGTERM");
  const status = await child.status;
  assertEquals(status.code, 0);
  assertEquals(await Deno.readTextFile(marker), "done");
  await assertRejects(() => fetch(`http://127.0.0.1:${port}/`));
});

Deno.test("close also waits for waitUntil work that waitUntil work starts", async () => {
  let inner = false;
  const worker: WorkerModule = {
    fetch(_req, _env, ctx) {
      ctx.waitUntil(
        new Promise((r) => setTimeout(r, 20)).then(() =>
          ctx.waitUntil(new Promise((r) => setTimeout(r, 50)).then(() => inner = true))
        ),
      );
      return new Response("sent first");
    },
  };
  const served = await serveWorker(worker, {
    port: freePort(),
    hostname: "127.0.0.1",
    exitOnSignal: false,
  });
  assertEquals(await (await fetch(served.url)).text(), "sent first");
  await served.close();
  assertEquals(inner, true);
});
