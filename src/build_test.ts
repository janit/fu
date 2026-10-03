import { assertEquals } from "@std/assert";
import { cacheRules } from "./build.ts";

Deno.test("the bare asset prefix is never cached, with or without its slash", () => {
  // It is not a file, so the app answers it with a 404, and nitro would put the
  // hashed assets' year-long max-age on that.
  assertEquals(cacheRules(), {
    "/_fu/": { headers: { "cache-control": "no-store" } },
    "/_fu": { headers: { "cache-control": "no-store" } },
  });
});
