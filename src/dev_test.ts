import { assertEquals, assertRejects } from "@std/assert";
import {
  deliverUpdates,
  devFetch,
  DevWorker,
  exitOnSignal,
  hmrOriginAllowed,
  hmrUpgrade,
  listening,
  liveClientSheets,
} from "./dev.ts";
import { assetsFromDir } from "./static.ts";

Deno.test("the HMR socket admits the dev server's own pages", () => {
  for (const origin of ["http://localhost:1337", "http://127.0.0.1:1337", "http://[::1]:1337"]) {
    assertEquals(hmrOriginAllowed(origin, 1337, "0.0.0.0"), true, origin);
  }
  // Bound to a named host and browsed by it.
  assertEquals(hmrOriginAllowed("http://192.168.1.5:1337", 1337, "192.168.1.5"), true);
});

Deno.test("the HMR socket refuses every other page", () => {
  const refused = [
    null, // no browser omits it, so only a script would
    "https://attacker.example",
    "http://attacker.example:1337", // DNS rebinding keeps the port
    "http://localhost:8080", // another app on this machine
    "http://localhost:1338", // the HMR port itself is not a page
    "http://192.168.1.5:1337", // a LAN host when bound to all interfaces
    "null",
    "file://",
    "chrome-extension://abc",
    "ftp://localhost:1337", // right name and port, but not a page
  ];
  for (const origin of refused) {
    assertEquals(hmrOriginAllowed(origin, 1337, "0.0.0.0"), false, String(origin));
  }
});

Deno.test("the socket's upgrade hook is where a stranger is turned away", () => {
  const upgrade = hmrUpgrade(1337, "127.0.0.1");
  const req = (origin?: string) =>
    new Request("http://localhost:1338/", { headers: origin ? { origin } : {} });
  assertEquals(upgrade(req("http://localhost:1337")), undefined);
  assertEquals(upgrade(req("https://attacker.example"))?.status, 403);
  assertEquals(upgrade(req())?.status, 403);
});

Deno.test("an update is written, sent, and only then reported as delivered", () => {
  const log: string[] = [];
  const peer = (name: string) => ({
    send: (d: string) => log.push(`${name} ${JSON.parse(d).type}`),
  });
  const peers = new Map([["a", peer("a")], ["b", peer("b")]]);
  deliverUpdates(
    [
      {
        clientId: "a",
        update: { type: "Patch", filename: "p1.js", code: "x", changedIds: ["/i.tsx"] },
      },
      { clientId: "b", update: { type: "FullReload" } },
      { clientId: "a", update: { type: "Noop" } },
      { clientId: "gone", update: { type: "Patch", filename: "p2.js", code: "y" } },
      {
        clientId: "b",
        update: { type: "Patch", filename: "p3.js", code: "z", changedIds: ["/a.css"] },
      },
    ],
    peers,
    {
      write: (file) => log.push(`write ${file}`),
      // Skipping this corrupts rolldown's per-client state and updates stop.
      delivered: (file) => log.push(`delivered ${file}`),
      cssHref: () => "/style.css?v=1",
    },
  );
  assertEquals(log, [
    "write p1.js",
    "a hmr:update",
    "delivered p1.js",
    "b hmr:reload",
    "write p3.js",
    "b hmr:update",
    "delivered p3.js",
    "b fu:css",
  ]);
});

Deno.test("a sheet the server stopped importing is dropped from the client's too", () => {
  // The client engine only reports patches, never its module graph, so its
  // collection cannot tell that an import was removed. The server build can.
  const seen = new Set<string>();
  const server = new Map([["/islands/i.css", ".i{}"], ["/routes/r.css", ".r{}"]]);
  const client = new Map([["/islands/i.css", ".i{}"], ["/islands/lone.css", ".l{}"]]);
  assertEquals([...liveClientSheets(server, client, seen).keys()], [
    "/islands/i.css",
    "/islands/lone.css",
  ]);
  server.delete("/islands/i.css");
  // Gone from the server graph: stale. Never in it: still the client's own.
  assertEquals([...liveClientSheets(server, client, seen).keys()], ["/islands/lone.css"]);
  server.set("/islands/i.css", ".i{}");
  assertEquals(liveClientSheets(server, client, seen).has("/islands/i.css"), true);
});

Deno.test("a server that could not listen stops the dev server, saying which and why", async () => {
  // Node reports a failed listen out of band and carries on: the dev server
  // used to print its address with nothing answering on it.
  const taken = { ready: () => Promise.reject(new Error("listen EADDRINUSE")) };
  await assertRejects(
    () => listening(taken, "the dev server", "127.0.0.1", 1337),
    Error,
    "the dev server could not listen on 127.0.0.1:1337 (listen EADDRINUSE)",
  );
  await listening({ ready: () => Promise.resolve() }, "the dev server", "127.0.0.1", 1337);
});

Deno.test("exitOnSignal closes, then exits 0; does not wait for ever; a second signal is immediate", async () => {
  const run = (close: () => Promise<unknown>, graceMs: number) => {
    const exits: number[] = [];
    const listeners: Record<string, () => void> = {};
    exitOnSignal(close, graceMs, {
      on: (signal, listener) => (listeners[signal] = listener),
      exit: (code) => void exits.push(code),
    });
    return { exits, listeners };
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const origError = console.error;
  console.error = () => {};
  try {
    // Closed first, then out; a close that fails is still an exit.
    let closed = 0;
    const clean = run(() => Promise.resolve(++closed), 1000);
    assertEquals(Object.keys(clean.listeners).sort(), ["SIGINT", "SIGTERM"]);
    clean.listeners.SIGTERM();
    assertEquals(clean.exits, []);
    await wait(0);
    assertEquals([closed, clean.exits], [1, [0]]);
    const failing = run(() => Promise.reject(new Error("no")), 1000);
    failing.listeners.SIGINT();
    await wait(0);
    assertEquals(failing.exits, [0]);
    // So is one that throws before it returns a promise.
    const throwing = run(() => {
      throw new Error("sync");
    }, 1000);
    throwing.listeners.SIGTERM();
    await wait(0);
    assertEquals(throwing.exits, [0]);

    // A close that hangs is cut off after the grace period.
    const hung = run(() => new Promise(() => {}), 20);
    hung.listeners.SIGTERM();
    await wait(60);
    assertEquals(hung.exits, [0]);

    // A second signal does not wait for the first one's close.
    let release!: () => void;
    const slow = run(() => new Promise<void>((r) => (release = r)), 60_000);
    slow.listeners.SIGINT();
    slow.listeners.SIGINT();
    assertEquals(slow.exits, [0]);
    await wait(0);
    release();
    await wait(0);
  } finally {
    console.error = origError;
  }
});

/** Whether anything accepts a connection on the port. */
async function accepts(port: number): Promise<boolean> {
  try {
    (await Deno.connect({ hostname: "127.0.0.1", port })).close();
    return true;
  } catch {
    return false;
  }
}

/** A port whose successor is free too: the HMR socket takes that one. */
async function freePair(): Promise<number> {
  for (;;) {
    const a = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (a.addr as Deno.NetAddr).port;
    a.close();
    if (port < 65534 && !(await accepts(port + 1))) return port;
  }
}

const signalCases = [
  ["SIGTERM", false, "and both its ports are released"],
  ["SIGINT", false, "and both its ports are released"],
  // An open page and a request still being answered must not be waited for.
  ["SIGTERM", true, "at once, with an HMR socket open and a request in flight"],
] as const;
for (const [signal, busy, what] of signalCases) {
  Deno.test(`fu dev exits with code 0 on ${signal}, ${what}`, async () => {
    // It used to stay up: the HMR socket's server installed a signal handler
    // that closed that one socket, which also cancelled the runtime's default
    // of dying on the signal, and nothing stopped the rest.
    const root = await Deno.makeTempDir();
    await Deno.mkdir(`${root}/routes`);
    await Deno.writeTextFile(`${root}/routes/index.tsx`, `export default () => <p>dev</p>;\n`);
    await Deno.writeTextFile(
      `${root}/routes/slow.ts`,
      `export const handlers = {\n` +
        `  GET: () => new Promise((r) => setTimeout(() => r(new Response("late")), 60000)),\n};\n`,
    );
    await Deno.symlink(
      new URL("../node_modules", import.meta.url).pathname,
      `${root}/node_modules`,
    );
    const port = await freePair();
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--node-modules-dir=manual",
        new URL("./cli.ts", import.meta.url).pathname,
        "dev",
        root,
        "--port",
        String(port),
      ],
      cwd: new URL("..", import.meta.url).pathname,
      // The inherited terminal's Ctrl+C must not be what stops it.
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let out = "";
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) out += decoder.decode(chunk, { stream: true });
    };
    const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | undefined;
    const abort = new AbortController();
    try {
      for (let i = 0; i < 300 && !out.includes("[fu] dev http"); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assertEquals([page.status, (await page.text()).includes("<p>dev</p>")], [200, true], out);
      assertEquals([await accepts(port), await accepts(port + 1)], [true, true]);

      if (busy) {
        // A page of the dev server's, connected the way the HMR runtime does.
        const opened = Promise.withResolvers<string>();
        ws = new WebSocket(
          `ws://127.0.0.1:${port + 1}/?clientId=held`,
          { headers: { origin: `http://localhost:${port}` } } as never,
        );
        ws.onmessage = (e) => opened.resolve(String(e.data));
        ws.onerror = (e) => opened.reject(new Error((e as ErrorEvent).message ?? "ws error"));
        assertEquals(await opened.promise, '{"type":"connected"}');
        fetch(`http://127.0.0.1:${port}/slow`, { signal: abort.signal }).then(
          (r) => r.body?.cancel(),
          () => {},
        );
        await new Promise((r) => setTimeout(r, 300));
      }

      const started = Date.now();
      child.kill(signal);
      const status = await Promise.race([
        child.status,
        new Promise<null>((r) => (timer = setTimeout(() => r(null), 10_000))),
      ]);
      assertEquals(status && [status.code, status.signal], [0, null], `still running\n${out}`);
      // Promptly: not after the five seconds a graceful close would wait for
      // the connection the request above left open.
      const took = Date.now() - started;
      // And when busy, not after the two-second grace either: that is a
      // deadline for a close that hangs, not the normal way out.
      assertEquals(took < (busy ? 1500 : 4000), true, `${took} ms`);
      assertEquals([await accepts(port), await accepts(port + 1)], [false, false]);
    } finally {
      clearTimeout(timer);
      abort.abort();
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        const closed = new Promise((r) => (ws!.onclose = r));
        ws.close();
        await closed;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone, which is the point.
      }
      await child.status;
      await drained;
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("dev serves a client file by its plain name, never cached, and anything else from the Worker", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/boot.js`, "boot");
    const seen: string[] = [];
    const worker = {
      fetch: (req: Request, env: Record<string, unknown>) => {
        seen.push(`${req.method} ${new URL(req.url).pathname} ${env.K}`);
        return new Response("page");
      },
    };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const answer = devFetch(assetsFromDir(dir), () => worker, { K: "v" }, ctx);
    const file = await answer(new Request("http://localhost/boot.js"));
    assertEquals([await file.text(), file.headers.get("cache-control")], ["boot", "no-cache"]);
    const etag = file.headers.get("etag")!;
    const again = await answer(
      new Request("http://localhost/boot.js", { headers: { "if-none-match": etag } }),
    );
    assertEquals([again.status, again.headers.get("cache-control")], [304, "no-cache"]);
    assertEquals(await (await answer(new Request("http://localhost/about"))).text(), "page");
    const post = await answer(new Request("http://localhost/boot.js", { method: "POST" }));
    assertEquals(await post.text(), "page");
    assertEquals(seen, ["GET /about v", "POST /boot.js v"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("each dev rebuild is loaded afresh; one that does not load leaves the last one serving", async () => {
  const dir = await Deno.makeTempDir();
  const file = `${dir}/worker.mjs`;
  const worker = new DevWorker(file);
  const text = async () =>
    await (await worker.current.fetch(new Request("http://x/"), {}, {
      waitUntil() {},
      passThroughOnException() {},
    })).text();
  try {
    // Before the first build has loaded, a request is told so instead of hanging.
    assertEquals((await worker.current.fetch(new Request("http://x/"), {}, null!)).status, 500);
    await Deno.writeTextFile(file, `export default { fetch: () => new Response("one") };`);
    await worker.reload();
    assertEquals(await text(), "one");
    await Deno.writeTextFile(file, `export default { fetch: () => new Response("two") };`);
    await worker.reload();
    assertEquals(await text(), "two");
    await Deno.writeTextFile(file, `export default {{ broken`);
    await assertRejects(() => worker.reload());
    assertEquals(await text(), "two");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("rebuilds that load out of order leave the newest serving, not the last to finish", async () => {
  const pending = new Map<string, (m: unknown) => void>();
  const worker = new DevWorker(
    "/nowhere/worker.mjs",
    (url) => new Promise((resolve) => pending.set(new URL(url).search, resolve)),
  );
  const module = (text: string) => ({ default: { fetch: () => new Response(text) } });
  const first = worker.reload();
  const second = worker.reload();
  pending.get("?v=2")!(module("newer"));
  await second;
  pending.get("?v=1")!(module("older"));
  await first;
  assertEquals(
    await (await worker.current.fetch(new Request("http://x/"), {}, null!)).text(),
    "newer",
  );
});
