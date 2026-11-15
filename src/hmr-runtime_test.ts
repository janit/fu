// The HMR client runtime outside a secure context.
//
// A dev server opened over plain http by IP or host name (a LAN or Tailscale
// address, not localhost) serves pages that are not a secure context, where
// browsers expose no crypto.randomUUID. The runtime is inlined into every
// page's bundle and runs first, so a throw there stops every island from
// hydrating. These run the real runtime source with the browser globals it
// touches at load stubbed.
import { assert, assertEquals, assertMatch } from "@std/assert";

const SOURCE = Deno.readTextFileSync(new URL("./hmr-runtime.js", import.meta.url))
  .replaceAll("__FU_HMR_PORT__", "5175");

const LOCAL = { hostname: "localhost", protocol: "http:" };

/** Runs the runtime with `crypto` and `location` as given; returns the URL its socket opened. */
function load(
  crypto: Partial<Crypto>,
  location: { hostname: string; protocol: string } = LOCAL,
): URL {
  const opened: URL[] = [];
  class FakeSocket {
    constructor(url: URL) {
      opened.push(new URL(String(url)));
    }
    addEventListener() {}
  }
  class FakeDevRuntime {
    constructor(readonly clientId: string) {}
  }
  const g = globalThis as Record<string, unknown>;
  const before = g.__rolldown_runtime__;
  try {
    delete g.__rolldown_runtime__;
    new Function("DevRuntime", "WebSocket", "crypto", "location", SOURCE)(
      FakeDevRuntime,
      FakeSocket,
      crypto,
      location,
    );
  } finally {
    g.__rolldown_runtime__ = before;
  }
  assertEquals(opened.length, 1);
  return opened[0];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

Deno.test("the HMR runtime loads without crypto.randomUUID (not a secure context) and still names its client", () => {
  const insecure = { getRandomValues: crypto.getRandomValues.bind(crypto) } as Partial<Crypto>;
  const first = load(insecure).searchParams.get("clientId") ?? "";
  const second = load(insecure).searchParams.get("clientId") ?? "";
  assertMatch(first, UUID);
  assertMatch(second, UUID);
  assert(first !== second, "each page gets its own id");
});

Deno.test("the HMR runtime uses crypto.randomUUID where the page has it", () => {
  const secure = {
    randomUUID: () =>
      "11111111-2222-4333-8444-555555555555" as `${string}-${string}-${string}-${string}-${string}`,
    getRandomValues: crypto.getRandomValues.bind(crypto),
  } as Partial<Crypto>;
  assertEquals(load(secure).searchParams.get("clientId"), "11111111-2222-4333-8444-555555555555");
});

Deno.test("the HMR socket dials the host the page came from, on the HMR port", () => {
  const c = crypto as Partial<Crypto>;
  assertEquals(load(c).host, "localhost:5175");
  assertEquals(
    load(c, { hostname: "192.168.42.144", protocol: "http:" }).host,
    "192.168.42.144:5175",
  );
  assertEquals(load(c, { hostname: "[::1]", protocol: "http:" }).host, "[::1]:5175");
  // A page on https would be refused a plain ws: socket as mixed content.
  assertEquals(load(c, { hostname: "dev.example", protocol: "https:" }).protocol, "wss:");
  assertEquals(load(c).protocol, "ws:");
});
