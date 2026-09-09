// Rolldown plugins shared by the dev and build drivers.
import type { Plugin } from "rolldown";
import { parseSync, transformSync } from "rolldown/experimental";
import { transform as lightning } from "lightningcss";
import * as fs from "node:fs";
import * as path from "node:path";

/** Files a source transform must never touch. */
function isInternal(id: string): boolean {
  return id.includes("node_modules") ||
    id.startsWith("\0") ||
    id.includes("rolldown") ||
    id.endsWith("hmr-runtime.js");
}

export interface JsxOptions {
  /** Stamp island exports with their module id (SSR build only). */
  stampIslands?: boolean;
  /** Inject `import.meta.hot.accept` into islands (dev client only). */
  hmr?: boolean;
}

/**
 * TypeScript + Preact JSX via oxc — the same native transform Vite delegates
 * to. Also carries the two island-specific source rewrites, since both need the
 * transformed output.
 */
export function jsx(opts: JsxOptions = {}): Plugin {
  return {
    name: "fu:jsx",
    transform: {
      filter: { id: /\.[tj]sx?$/ },
      handler(code, id) {
        // Mangling rolldown's own runtime module breaks its internal symbols
        // (RUNTIME_MODULE_SYMBOL_NOT_FOUND), so bail on anything internal.
        if (isInternal(id)) return null;
        const out = transformSync(id, code, {
          jsx: { runtime: "automatic", importSource: "preact" },
          lang: /\.tsx$/.test(id) ? "tsx" : /\.ts$/.test(id) ? "ts" : "jsx",
        });
        let js = out.code;
        let map = out.map ?? null;
        const islandKey = islandKeyOf(id);
        if (islandKey) {
          if (opts.stampIslands) {
            const stamped = stampIslands(js, islandKey, id);
            js = stamped.code;
            // Naming an anonymous default export shifts every later position.
            if (stamped.rewrote) map = null;
          }
          if (opts.hmr) js += acceptSelf(islandKey);
        }
        return { code: js, map };
      },
    },
  };
}

function islandKeyOf(id: string): string | null {
  const i = id.indexOf("/islands/");
  return i === -1 ? null : "/islands/" + id.slice(i + "/islands/".length).split("?")[0];
}

/** Minimal slice of the oxc AST this file walks. */
interface Node {
  type: string;
  start: number;
  end: number;
  exportKind?: string;
  source?: unknown;
  id?: { name?: string };
  declaration?: Node & { declarations?: { id?: { name?: string } }[] };
  specifiers?: { local?: { name?: string } }[];
}

const NAMED_DECLARATIONS = new Set(["FunctionDeclaration", "ClassDeclaration"]);

/**
 * Mark every exported component so the SSR renderer can spot a hydration
 * boundary from the component function alone.
 *
 * Uses oxc's parser rather than a regex: `export const X = () => {}` is the
 * most natural way to write a Preact component, and a regex over `export
 * function` silently misses it — the island renders and then never hydrates,
 * with no error anywhere.
 *
 * An anonymous `export default () => {}` has no binding to stamp, so it is
 * rewritten into a named const. That is the one case that shifts positions and
 * therefore invalidates the sourcemap, which the caller drops.
 */
export function stampIslands(
  js: string,
  key: string,
  id: string,
): { code: string; rewrote: boolean } {
  const parsed = parseSync(id, js, { sourceType: "module", lang: "tsx" });
  const body = (parsed.program as unknown as { body: Node[] }).body ?? [];
  const names: string[] = [];
  let rewrote = false;
  let out = js;

  for (const node of body) {
    // `export type {...}`, `export interface`: no runtime binding.
    if (node.exportKind === "type") continue;

    if (node.type === "ExportNamedDeclaration") {
      // `export ... from "./x"` re-exports nothing into local scope.
      if (node.source) continue;
      const decl = node.declaration;
      if (decl?.type === "VariableDeclaration") {
        for (const d of decl.declarations ?? []) {
          if (d.id?.name) names.push(d.id.name);
        }
      } else if (decl && NAMED_DECLARATIONS.has(decl.type)) {
        if (decl.id?.name) names.push(decl.id.name);
      } else {
        for (const sp of node.specifiers ?? []) {
          if (sp.local?.name) names.push(sp.local.name);
        }
      }
      continue;
    }

    if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      if (decl && NAMED_DECLARATIONS.has(decl.type) && decl.id?.name) {
        names.push(decl.id.name);
      } else if (decl) {
        // `export default <expression>` — give it a name so it can be stamped.
        const head = js.slice(node.start, decl.start);
        if (head.includes("export default")) {
          out = out.slice(0, node.start) +
            head.replace("export default", "const __fu_default =") +
            out.slice(decl.start);
          names.push("__fu_default");
          rewrote = true;
        }
      }
    }
  }

  if (names.length === 0) return { code: out, rewrote };
  const tail = names
    .map((n) => `try{${n}.__island=${JSON.stringify(key)}}catch{}`)
    .join("\n");
  const reexport = rewrote ? "\nexport default __fu_default;" : "";
  return { code: `${out}${reexport}\n${tail}\n`, rewrote };
}

/** Accept our own updates so rolldown patches the module instead of reloading. */
function acceptSelf(key: string): string {
  return `\nif (import.meta.hot) { import.meta.hot.accept((mod) => { ` +
    `globalThis.__fu_hmr__ && globalThis.__fu_hmr__(${JSON.stringify(key)}, mod); ` +
    `}); }\n`;
}

/**
 * CSS. Rolldown removed CSS bundling and ships no CSS builtin, so the framework
 * owns the pipeline via lightningcss:
 *   `*.module.css` -> CSS Modules (scoped names + JS exports object)
 *   `*.css`        -> global stylesheet
 * Native nesting, `@layer` and `color-mix` pass straight through.
 *
 * Pair this with `moduleTypes: { ".css": "js" }`, or rolldown classifies the
 * module by extension and refuses to bundle it.
 */
export function css(collected: Map<string, string>): Plugin {
  return {
    name: "fu:css",
    transform: {
      filter: { id: /\.css$/ },
      handler(code, id) {
        const isModule = /\.module\.css$/.test(id.split("?")[0]);
        const out = lightning({
          filename: id,
          code: Buffer.from(code),
          minify: true,
          cssModules: isModule,
        });
        const text = out.code.toString();
        collected.set(id, text);
        // The emitted JS must change when the stylesheet does. Class names hash
        // from the *filename*, so without this stamp an edit produces
        // byte-identical JS, rolldown correctly emits no update, and CSS HMR
        // silently never fires.
        const stamp = `export const __css = ${JSON.stringify(hash(text))};`;
        if (!isModule) return { code: `export default {};\n${stamp}`, map: null };
        // `composes` yields SEVERAL class names; dropping the extras loses the
        // composed styles with no error.
        const names = Object.fromEntries(
          Object.entries(out.exports ?? {}).map(([k, v]) => [
            k,
            [v.name, ...(v.composes ?? []).map((c) => (c as { name: string }).name)].join(" "),
          ]),
        );
        return { code: `export default ${JSON.stringify(names)};\n${stamp}`, map: null };
      },
    },
  };
}

/** Serve generated modules by exact id. */
export function virtual(mods: Record<string, string>): Plugin {
  return {
    name: "fu:virtual",
    resolveId: (id) => (id in mods ? "\0" + id : null),
    load: (id) => (id.startsWith("\0") && id.slice(1) in mods ? mods[id.slice(1)] : null),
  };
}

export function hash(s: string): string {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Recursively list source files under `dir`, as root-relative "/a/b.tsx".
 * Underscore-prefixed files are skipped: they are framework files
 * (`routes/_app.tsx`), not routes.
 */
export function walk(root: string, dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(root, f, out);
    else if (/\.[tj]sx?$/.test(e.name) && !e.name.startsWith("_")) {
      out.push("/" + path.relative(root, f).split(path.sep).join("/"));
    }
  }
  return out;
}

/** Absolute path to an optional project file, or null when absent. */
export function optional(root: string, ...names: string[]): string | null {
  for (const n of names) {
    const p = path.resolve(root, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Generated module bodies both drivers need. */
export function bootModule(clientPath: string, islandFiles: string[], root: string): string {
  return `
import { hydrateIslands } from ${JSON.stringify(clientPath)};
hydrateIslands({
${islandFiles.map((f) => `  ${JSON.stringify(f)}: () => import(${JSON.stringify(path.resolve(root, "." + f))})`).join(",\n")}
});
`;
}

export interface SsrModuleOptions {
  renderPath: string;
  routeFiles: string[];
  root: string;
  /** Serialized Assets literal. */
  assets: string;
  /** Absolute path to the project's `app.ts`, if it has one. */
  appPath?: string | null;
  /** Absolute path to the project's `routes/_app.tsx`, if it has one. */
  shellPath?: string | null;
  /** Absolute path to the project's `routes/_error.tsx`, if it has one. */
  errorPath?: string | null;
}

export function ssrModule(o: SsrModuleOptions): string {
  const lines = [
    `import { createHandler } from ${JSON.stringify(o.renderPath)};`,
  ];
  if (o.appPath) lines.push(`import app from ${JSON.stringify(o.appPath)};`);
  if (o.shellPath) lines.push(`import Shell from ${JSON.stringify(o.shellPath)};`);
  if (o.errorPath) lines.push(`import ErrorPage from ${JSON.stringify(o.errorPath)};`);
  lines.push(
    `const routes = {`,
    o.routeFiles
      .map((f) =>
        `  ${JSON.stringify(f)}: () => import(${
          JSON.stringify(path.resolve(o.root, "." + f))
        })`
      )
      .join(",\n"),
    `};`,
    `const assets = ${o.assets};`,
    `const handler = createHandler({`,
    `  manifest: routes,`,
    `  assets,`,
    o.appPath ? `  app,` : `  app: undefined,`,
    o.shellPath ? `  Shell,` : `  Shell: undefined,`,
    o.errorPath ? `  ErrorPage,` : `  ErrorPage: undefined,`,
    `});`,
    // Nitro invokes the handler with an H3Event, not a Request. The event
    // exposes `url`/`headers` directly — which is why routing worked long
    // before anyone read a body — but has no json()/text()/formData(). The
    // real Request is `event.req`.
    `const toRequest = (input) => input instanceof Request ? input : (input?.req ?? input);`,
    `export default (input) => handler(toRequest(input));`,
    ``,
  );
  return lines.join("\n");
}
