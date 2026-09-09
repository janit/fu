#!/usr/bin/env -S deno run -A
import process from "node:process";
import { build } from "./build.ts";
import { dev } from "./dev.ts";

export async function main(argv: string[]): Promise<void> {
  const [cmd = "dev", ...rest] = argv;
  const flag = (name: string) =>
    rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const port = flag("port");
  const opts = {
    root: rest.find((a) => !a.startsWith("-")) ?? process.cwd(),
    port: port ? Number(port) : undefined,
    hostname: flag("host"),
  };
  if (cmd === "build") await build(opts);
  else if (cmd === "dev") await dev(opts);
  else {
    console.error(`fu: unknown command "${cmd}" (expected dev|build)`);
    throw new Error(`unknown command: ${cmd}`);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
