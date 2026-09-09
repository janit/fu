#!/usr/bin/env -S deno run -A
import { build } from "./build.ts";
import { dev } from "./dev.ts";

export async function main(argv: string[]): Promise<void> {
  const [cmd = "dev", ...rest] = argv;
  const portArg = rest.find((a) => a.startsWith("--port="));
  const hostArg = rest.find((a) => a.startsWith("--host="));
  const rootArg = rest.find((a) => !a.startsWith("-"));
  const opts = {
    root: rootArg ?? Deno?.cwd?.() ?? process.cwd(),
    port: portArg ? Number(portArg.slice("--port=".length)) : undefined,
    hostname: hostArg ? hostArg.slice("--host=".length) : undefined,
  };
  if (cmd === "build") await build(opts);
  else if (cmd === "dev") await dev(opts);
  else {
    console.error(`fu: unknown command "${cmd}" (expected dev|build)`);
    throw new Error(`unknown command: ${cmd}`);
  }
}

declare const Deno: { cwd?: () => string } | undefined;

if (import.meta.main) await main(globalThis.process?.argv.slice(2) ?? []);
