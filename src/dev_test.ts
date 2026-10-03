import { assertEquals, assertRejects } from "@std/assert";
import {
  deliverUpdates,
  hmrOriginAllowed,
  hmrUpgrade,
  listening,
  liveClientSheets,
} from "./dev.ts";

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
