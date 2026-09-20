import { assertEquals } from "@std/assert";
import { hmrOriginAllowed } from "./dev.ts";

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
  ];
  for (const origin of refused) {
    assertEquals(hmrOriginAllowed(origin, 1337, "0.0.0.0"), false, String(origin));
  }
});
