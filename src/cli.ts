#!/usr/bin/env node
import * as fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "./build.ts";
import { dev } from "./dev.ts";
import type { FuOptions } from "./types.ts";

const USAGE = "usage: fu [dev|build] [root] [--port N] [--host H]";

/** Parse the command line. Throws with a message fit for the terminal. */
export function parseArgs(argv: string[]): { cmd: "dev" | "build"; opts: FuOptions } {
  const [cmd = "dev", ...rest] = argv;
  if (cmd !== "dev" && cmd !== "build") throw new Error(`unknown command "${cmd}"\n${USAGE}`);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    // `--port 3000` as well as `--port=3000`: the spaced form used to be taken
    // for the project root, and a root with no routes served 404 for everything.
    const [name, value] = eq === -1 ? [a.slice(2), rest[++i]] : [a.slice(2, eq), a.slice(eq + 1)];
    if (name !== "port" && name !== "host") throw new Error(`unknown flag --${name}\n${USAGE}`);
    if (value === undefined || value === "") throw new Error(`--${name} needs a value`);
    flags[name] = value;
  }
  if (positional.length > 1) throw new Error(`one project root, got ${positional.join(" ")}`);
  let port: number | undefined;
  if (flags.port !== undefined) {
    port = Number(flags.port);
    if (!Number.isInteger(port) || port < 1 || port > 65534) {
      throw new Error(`--port must be a port number (the HMR socket takes the next one)`);
    }
  }
  return { cmd, opts: { root: positional[0] ?? process.cwd(), port, hostname: flags.host } };
}

export async function main(argv: string[]): Promise<void> {
  const { cmd, opts } = parseArgs(argv);
  if (cmd === "build") await build(opts);
  else await dev(opts);
}

/**
 * Whether this module is the program. `import.meta.main` is missing on Node
 * before 22.18, where `fu build` would otherwise do nothing and exit 0.
 */
function isMain(): boolean {
  const meta = import.meta as { main?: boolean };
  if (meta.main !== undefined) return meta.main;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    console.error(`fu: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
