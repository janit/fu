#!/usr/bin/env node
import * as fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "./build.ts";
import { dev } from "./dev.ts";
import type { FuOptions } from "./types.ts";

const USAGE = `usage: fu [dev|build] [root] [--port N] [--host H]
  fu dev [root]     serve with HMR (the default command); --port and --host apply here
  fu build [root]   build for production into <root>/.output
  fu --version`;

export type Command = "dev" | "build" | "help" | "version";

/** Parse the command line. Throws with a message fit for the terminal. */
export function parseArgs(argv: string[]): { cmd: Command; opts: FuOptions } {
  if (argv.includes("--help") || argv.includes("-h")) return { cmd: "help", opts: noOpts() };
  if (argv.includes("--version")) return { cmd: "version", opts: noOpts() };
  // `fu --port 3000`: flags with no command are for the default one.
  const [cmd, ...rest] = argv[0] === undefined || argv[0].startsWith("--")
    ? ["dev", ...argv]
    : argv;
  if (cmd !== "dev" && cmd !== "build") {
    throw new Error(`unknown command "${cmd}" (to serve a project: fu dev ${cmd})\n${USAGE}`);
  }
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
    // `--host --port 3000` would otherwise bind to a host called "--port".
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`--${name} needs a value`);
    }
    if (cmd === "build") throw new Error(`--${name} only applies to dev`);
    flags[name] = value;
  }
  if (positional.length > 1) throw new Error(`one project root, got ${positional.join(" ")}`);
  let port: number | undefined;
  if (flags.port !== undefined) {
    // Digits only: Number() also takes "0x50", "1e3" and " 80".
    port = /^\d+$/.test(flags.port) ? Number(flags.port) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65534) {
      throw new Error(`--port must be a port number (the HMR socket takes the next one)`);
    }
  }
  return { cmd, opts: { root: positional[0] ?? process.cwd(), port, hostname: flags.host } };
}

function noOpts(): FuOptions {
  return { root: process.cwd(), port: undefined, hostname: undefined };
}

/** The version in the package.json this file ships under. */
function version(): string {
  try {
    const pkg = new URL("../package.json", import.meta.url);
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function main(argv: string[]): Promise<void> {
  const { cmd, opts } = parseArgs(argv);
  if (cmd === "help") console.log(USAGE);
  else if (cmd === "version") console.log(version());
  else if (cmd === "build") await build(opts);
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
