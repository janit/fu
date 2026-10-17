#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "./build.ts";
import { dev } from "./dev.ts";
import type { FuOptions } from "./types.ts";

const USAGE = `usage: fu [dev|build|serve] [root] [--port N] [--host H] [--out DIR]
  fu dev [root]     serve with HMR (the default command)
  fu build [root]   build the Worker and its runner into <root>/.output (or --out)
  fu serve [root]   serve that build on this runtime, as celld would run it
  --port, --host    for dev and serve; --out for build and serve
  fu --version`;

export type Command = "dev" | "build" | "serve" | "help" | "version";

const FLAGS: Record<string, readonly Command[]> = {
  port: ["dev", "serve"],
  host: ["dev", "serve"],
  out: ["build", "serve"],
};

/** Parse the command line. Throws with a message fit for the terminal. */
export function parseArgs(argv: string[]): { cmd: Command; opts: FuOptions } {
  if (argv.includes("--help") || argv.includes("-h")) return { cmd: "help", opts: noOpts() };
  if (argv.includes("--version")) return { cmd: "version", opts: noOpts() };
  // `fu --port 3000`: flags with no command are for the default one.
  const [cmd, ...rest] = argv[0] === undefined || argv[0].startsWith("--")
    ? ["dev", ...argv]
    : argv;
  if (cmd !== "dev" && cmd !== "build" && cmd !== "serve") {
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
    if (!(name in FLAGS)) throw new Error(`unknown flag --${name}\n${USAGE}`);
    // `--host --port 3000` would otherwise bind to a host called "--port".
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`--${name} needs a value`);
    }
    if (!FLAGS[name].includes(cmd)) {
      throw new Error(`--${name} only applies to ${FLAGS[name].join(" and ")}`);
    }
    flags[name] = value;
  }
  if (positional.length > 1) throw new Error(`one project root, got ${positional.join(" ")}`);
  let port: number | undefined;
  if (flags.port !== undefined) {
    // Digits only: Number() also takes "0x50", "1e3" and " 80".
    port = /^\d+$/.test(flags.port) ? Number(flags.port) : NaN;
    // In dev the HMR socket takes the port above.
    const top = cmd === "dev" ? 65534 : 65535;
    if (!Number.isInteger(port) || port < 1 || port > top) {
      throw new Error(
        `--port must be a port number${
          cmd === "dev" ? " (the HMR socket takes the next one)" : ""
        }`,
      );
    }
  }
  return {
    cmd,
    opts: { root: positional[0] ?? process.cwd(), port, hostname: flags.host, outDir: flags.out },
  };
}

function noOpts(): FuOptions {
  return { root: process.cwd(), port: undefined, hostname: undefined, outDir: undefined };
}

/**
 * Run a build's runner in this process. It reads the port and host from the
 * environment, as it does when started by hand.
 */
async function serveBuild(opts: FuOptions): Promise<void> {
  const outDir = opts.outDir ? path.resolve(opts.outDir) : path.resolve(opts.root, ".output");
  const runner = path.join(outDir, "server", "serve.mjs");
  if (!fs.existsSync(runner)) throw new Error(`no build in ${outDir}; run fu build first`);
  if (opts.port !== undefined) process.env.PORT = String(opts.port);
  if (opts.hostname !== undefined) process.env.HOST = opts.hostname;
  await import(pathToFileURL(runner).href);
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
  else if (cmd === "serve") await serveBuild(opts);
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
