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
    opts: { root: "app", port: undefined, hostname: undefined, outDir: undefined },
  });
});

Deno.test("mistakes are refused rather than half-understood", () => {
  assertThrows(() => parseArgs(["start"]), Error, "unknown command");
  assertThrows(() => parseArgs(["dev", "--port", "x"]), Error, "port number");
  assertThrows(() => parseArgs(["dev", "--port"]), Error, "needs a value");
  assertThrows(() => parseArgs(["dev", "--prot=1"]), Error, "unknown flag");
  assertThrows(() => parseArgs(["dev", "a", "b"]), Error, "one project root");
});

Deno.test("a root without routes/ is refused", async () => {
  const empty = await Deno.makeTempDir();
  try {
    assertThrows(() => scanProject(empty), Error, "no routes/ directory");
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});

Deno.test("flags alone mean dev, and a bare word is not guessed to be a root", () => {
  assertEquals(parseArgs(["--port", "3000"]), {
    cmd: "dev",
    opts: { root: Deno.cwd(), port: 3000, hostname: undefined, outDir: undefined },
  });
  assertThrows(() => parseArgs(["example"]), Error, "fu dev example");
});

Deno.test("a flag is never taken for another flag's value", () => {
  assertThrows(() => parseArgs(["dev", "--host", "--port", "3000"]), Error, "needs a value");
});

Deno.test("the port is decimal and leaves room for the HMR socket above it", () => {
  for (const bad of ["0", "65535", "0x50", "1e3", "80.0", "-1", " 80"]) {
    assertThrows(() => parseArgs(["dev", `--port=${bad}`]), Error, "port number");
  }
  assertEquals(parseArgs(["dev", "--port=1"]).opts.port, 1);
  assertEquals(parseArgs(["dev", "--port=65534"]).opts.port, 65534);
});

Deno.test("build refuses a server's flags, and dev an output dir, rather than ignoring them", () => {
  assertThrows(() => parseArgs(["build", "--port", "1"]), Error, "applies to dev and serve");
  assertThrows(() => parseArgs(["build", "--host=x"]), Error, "applies to dev and serve");
  assertThrows(() => parseArgs(["dev", "--out", "x"]), Error, "applies to build and serve");
});

Deno.test("serve takes a port, a host and the output dir of the build it serves", () => {
  assertEquals(parseArgs(["serve", "app", "--port", "8080", "--host=0.0.0.0", "--out", "o"]), {
    cmd: "serve",
    opts: { root: "app", port: 8080, hostname: "0.0.0.0", outDir: "o" },
  });
  assertEquals(parseArgs(["build", "--out=dist/x"]).opts.outDir, "dist/x");
  // No HMR socket above it, so the top port is free to take.
  assertEquals(parseArgs(["serve", "--port=65535"]).opts.port, 65535);
  assertThrows(() => parseArgs(["serve", "--port=65536"]), Error, "port number");
});

Deno.test("help and version are commands, not errors", () => {
  assertEquals(parseArgs(["--help"]).cmd, "help");
  assertEquals(parseArgs(["-h"]).cmd, "help");
  assertEquals(parseArgs(["dev", "--help"]).cmd, "help");
  assertEquals(parseArgs(["--version"]).cmd, "version");
});
