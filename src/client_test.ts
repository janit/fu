import { assertEquals } from "@std/assert";
import { componentOf, splitKey } from "./client.ts";

// Hydration itself needs a DOM and is checked in a real browser by
// scripts/check-browser.mjs; these are the parts that are plain functions.

Deno.test("an island key names a file and, after #, the export", () => {
  assertEquals(splitKey("/islands/Counter.tsx"), ["/islands/Counter.tsx", "default"]);
  assertEquals(splitKey("/islands/W.tsx#Toggle"), ["/islands/W.tsx", "Toggle"]);
  // The server stamps exactly one #, but a file name may hold one too.
  assertEquals(splitKey("/islands/a/b.tsx#X#Y"), ["/islands/a/b.tsx", "X#Y"]);
});

Deno.test("only a function export counts as a component", () => {
  const Named = () => null;
  const mod = { default: () => null, Named, count: 3, nothing: undefined };
  assertEquals(componentOf(mod, "Named"), Named);
  assertEquals(typeof componentOf(mod, "default"), "function");
  // A half-written save can leave the export missing or not yet a function;
  // the hot swap keeps the old implementation when this says null.
  assertEquals(componentOf(mod, "count"), null);
  assertEquals(componentOf(mod, "nothing"), null);
  assertEquals(componentOf(mod, "missing"), null);
});
