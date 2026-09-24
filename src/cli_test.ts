import { assertEquals, assertThrows } from "@std/assert";
import { parseArgs } from "./cli.ts";
import { scanProject } from "./driver.ts";

Deno.test("port and host parse with or without the equals sign", () => {
  assertEquals(parseArgs(["dev", "app", "--port", "3000"]).opts.port, 3000);
  assertEquals(parseArgs(["dev", "--port=3000", "app"]).opts.root, "app");
  assertEquals(parseArgs(["dev", "--host", "127.0.0.1"]).opts.hostname, "127.0.0.1");
  assertEquals(parseArgs([]).cmd, "dev");
  assertEquals(parseArgs(["build", "app"]), {
    cmd: "build",
    opts: { root: "app", port: undefined, hostname: undefined },
  });
});

Deno.test("mistakes are refused rather than half-understood", () => {
  assertThrows(() => parseArgs(["serve"]), Error, "unknown command");
  assertThrows(() => parseArgs(["dev", "--port", "x"]), Error, "port number");
  assertThrows(() => parseArgs(["dev", "--port"]), Error, "needs a value");
  assertThrows(() => parseArgs(["dev", "--prot=1"]), Error, "unknown flag");
  assertThrows(() => parseArgs(["dev", "a", "b"]), Error, "one project root");
});

Deno.test("a root without routes/ is refused", async () => {
  const empty = await Deno.makeTempDir();
  assertThrows(() => scanProject(empty), Error, "no routes/ directory");
});
