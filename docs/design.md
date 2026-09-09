# Fresh Urquell — design

**Date:** 2026-09-09 (design), updated the same evening after the first cleanup pass
**Status:** implemented and verified; a living document
**Package:** `@janit/fu` (repo `janit/fu`)

A minimal islands framework: file-system routing, SSR and hydration on
Preact 11, built by rolldown and served by Nitro. Runs on Deno, Node and Bun.

## Why this exists

Fresh 2 stopped receiving releases; Fresh 3 exists only as a moving alpha. The
`fresh-fork` checkout was the hedge. Measuring it showed the thing we actually
need is small: of its 7,307 non-test lines, the glue binding the bundler to the
server is a few hundred. The rest is islands machinery, partials, and a
compatibility surface we do not use.

Fresh Urquell is not Fresh-compatible and does not try to be. It takes the good
ideas — file-system routes, islands, per-route code splitting — and drops
everything else.

## Scope

In: dev server, production build, file-system routing, SSR, islands with
hydration, signals, CSS (including CSS Modules), HMR, cross-runtime output.

Middleware, `ctx.state`, page metadata and a root shell were added after
measuring routemap4 (see "Middleware" below).

Error pages were added for the same reason as `_app`: without them a thrown
error reaches the client as Nitro's raw JSON.

Out: partials, streaming SSR, nested layouts, per-directory middleware,
prerendering. These are deliberate omissions, not
oversights; add them only when an app needs them.

## Architecture

Two layers, with a hard boundary between them.

```
  app code:  routes/*.tsx   islands/*.tsx   *.module.css
                    │
  ┌─────────────────┴─────────────────────────────────────┐
  │ driver (bundler-specific)                             │
  │   scan fs → manifest                                  │
  │   rolldown: jsx (oxc), css (lightningcss), islands    │
  │   nitro:   server build, presets, dev server          │
  └─────────────────┬─────────────────────────────────────┘
                    │  two plain data structures
  ┌─────────────────┴─────────────────────────────────────┐
  │ core (bundler-agnostic)                               │
  │   router  — URLPattern                                │
  │   render  — SSR + island boundary detection           │
  │   client  — hydration + HMR re-render                 │
  └───────────────────────────────────────────────────────┘
```

The core consumes exactly two things and knows nothing else about the build:

```ts
type RouteManifest = Record<string, () => Promise<RouteModule>>;
type Assets = { js: { href: string }[]; css: { href: string }[] };
```

This boundary is not aspirational. It was verified twice: the core ran
standalone under Deno with a hand-written manifest and no bundler at all, and
the same three core files were used byte-identically under a Vite driver and a
rolldown driver.

**Consequence:** a second driver is ~200 lines, and the choice of bundler stays
reversible. Ship the rolldown driver; keep a Vite driver possible.

## Runtime contracts

**Server.** Nitro's handler contract is a web-standard fetch function:
`(req: Request) => Response`. Nothing else is required. Nitro's presets handle
deployment targets, and `srvx` absorbs the runtime differences — one
`node-server` build runs unmodified on Node, Bun and Deno.

**Routing.** `URLPattern`, a web standard. Native on Deno and Bun; Node ships it
in 24+. On Node 22 it is absent entirely (not under `node:url`, not behind a
flag), so the router loads `urlpattern-polyfill` only when the global is
missing. Deno and Bun ship zero polyfill bytes.

File-path mapping:

| file | pattern |
|---|---|
| `routes/index.tsx` | `/` |
| `routes/about.tsx` | `/about` |
| `routes/blog/[slug].tsx` | `/blog/:slug` |
| `routes/files/[...rest].tsx` | `/files/:rest*` |

Routes sort static → dynamic → wildcard, then by depth.

`URLPattern.exec` is not cheap: ~3.5 µs per route on Deno, so a 16-route app
spent 30–60 µs routing every request, more than the Preact render of a small
page. Two facts fix that without leaving the standard. The `{ pathname }`
dictionary input is five times slower than a URL string on Deno, so the router
passes `"http://x" + pathname`. And `exec` only needs to run where it can
match: a route with no pattern syntax at all is matched by string equality
against `urlPattern.pathname` (the canonical, percent-encoded form, so
`routes/über.tsx` still matches `/%C3%BCber`), and a pattern whose segment
count cannot fit the path is skipped. Measured with 16 routes: a static hit
went from 28 µs to 65 ns, a dynamic hit from 57 µs to 1.6 µs, a miss from
58 µs to 1.1 µs. URLPattern still decides every non-literal match.

The renderer caches each route's loaded module on the route; a dynamic import
of an already-loaded module is cheap but not free, and the manifest cannot
change within one server process (dev rebuilds the whole server on a route
edit).

**Islands.** An SSR-only transform stamps each island export with its module id.
At render time a Preact `options.vnode` hook spots the stamp and wraps the
component in a marker element carrying JSON-serialized props. The client walks
`[data-island]`, imports every distinct island module at once, then hydrates
the markers in document order — awaiting each in turn would serialise one
network round-trip per island.

The stamp is placed using oxc's parser, not a regex. `export const X = () => {}`
is the most natural way to write a Preact component and a regex over `export
function` silently missed it — the island rendered and then never hydrated, with
no error anywhere. Re-exports and type-only exports are skipped since they bind
nothing at runtime; an anonymous `export default () => {}` is rewritten into a
named const so there is something to stamp, which is the one case that
invalidates the sourcemap.

## Middleware

Scope was set by measuring a real app (`~/routemap4`) rather than by guessing:

| app | mechanism | count |
|---|---|---|
| `frontend4` | programmatic `app.use()` | 21 |
| `frontend3` | programmatic `app.use()` | 22 |
| `admin`, `admin_v2` | fs `routes/_middleware.ts` | 1 each |

**Per-directory middleware has zero real uses** — both `_middleware.ts` files
sit at `routes/` root, i.e. global anyway. It is not implemented. The admin file
is also the anti-pattern: one function doing six jobs, versus the frontends'
many single-purpose files.

The 43 middleware in the frontends need exactly five capabilities: short-circuit
with a redirect or a body; mutate the response after `next()`; populate shared
state; observe the response and fire-and-forget; and wrap in try/catch to
re-throw. Redirects — the case that prompted this — need nothing beyond
`ctx.next()`, `ctx.state` and returning a `Response`; the bulk of routemap4's
`redirects.ts` is caching around its lookup table, not framework surface.

So the contract is small:

```ts
type Middleware<S> = (ctx: Ctx<S>) => Response | Promise<Response>;
interface Ctx<S> {
  req: Request; url: URL; params: Record<string,string>;
  state: S; head: Head; data?: unknown; next(): Promise<Response>;
}
```

One `ctx` object is shared by the whole chain so `state` and `head` mutations
propagate both inward and outward; only `next` is rebound per level. Calling
`next()` twice rejects rather than silently double-running the chain.

Middleware runs **before** routing, so `ctx.params` is empty inside it. That is
deliberate: it lets a middleware answer a request no route matches.

### Page metadata

`ctx.state` in routemap4 is used 54x for `pageTitle`, 34x `pageDescription`,
27x `canonicalUrl` — routes *write* these and the shell *reads* them. Listing
`_app` as out of scope was therefore wrong: without this channel a route cannot
set its own `<title>`, which blocks any real page.

It is a separate `ctx.head` rather than well-known keys in `state`, so the
shell's contract is explicit and typing an app's own state does not mean
re-declaring framework fields. An optional `routes/_app.tsx` wraps the body;
`_`-prefixed files under `routes/` are framework files, not routes.

## CSS

Rolldown removed CSS bundling outright (`Bundling CSS is no longer supported`),
and there is no CSS plugin among its 18 builtins. This is permanent, not a gap
waiting to close: the framework owns the CSS pipeline.

lightningcss (the same engine Vite uses, also Rust) does the work:

- `*.module.css` → CSS Modules: scoped names plus a JS exports object
- `*.css` → global stylesheet
- native nesting, `@layer`, `color-mix` pass straight through

Three constraints discovered the hard way:

1. `composes` yields **several** class names. lightningcss returns
   `{name, composes[]}`; joining them is mandatory or composed styles vanish
   with no error.
2. `composes` cannot appear inside `@layer` or any nested rule — hard error.
3. ID selectors are scoped too, so `#counter` becomes `#hash_counter` and a
   literal `id="counter"` stops matching. Style by class.

The emitted JS **must** embed a hash of the stylesheet text. Class names hash
from the filename, so without it an edit produces byte-identical JS, rolldown
correctly emits no update, and CSS HMR silently never fires.

## HMR

rolldown `DevEngine` produces patches; `crossws` carries them; Nitro serves the
app. Editing an island hot-swaps its markup **and preserves hook state**;
editing CSS swaps the stylesheet in place; editing a route rebuilds the server.

**State preservation without Babel.** Prefresh would reintroduce Babel into an
otherwise all-Rust pipeline. Instead, islands hydrate behind a wrapper whose
*identity never changes*, with the implementation swapped behind a ref. Preact
keys hook state to the component type, so the instance survives and signals keep
their values. A `__hmr` counter prop — stripped before reaching the island —
forces the re-render, since Preact otherwise correctly skips an identical
type+props pair.

Limitation: adding or removing a hook changes hook order. Verified not to crash,
but the swap is wrong and needs a manual refresh. Mitigation when it matters:
hash the island's hook-call count in the transform and force a remount when it
changes.

### Traps encoded in the implementation

Each of these cost real debugging and none is documented upstream:

1. `devMode.implement` takes runtime **source**, not a path. A path gets inlined
   literally and oxc parses it as a regex literal.
2. `$ADDR` is substituted only in rolldown's own default runtime. Custom
   runtimes must substitute host:port themselves.
3. The default runtime **registers factories but never applies updates**. The
   apply walk — drop cache, `initModule`, `loadExports`, fire accept callbacks —
   is the framework's job.
4. A JSX transform filtered on `\.[tj]sx?$` matches rolldown's own
   `\0rolldown/runtime.js` and mangles it (`RUNTIME_MODULE_SYMBOL_NOT_FOUND`).
   Exclude `\0`-prefixed ids, anything containing `rolldown`, and the HMR
   runtime file.
5. Never call `notifyPayloadDelivered` for a patch that was not actually served.
   It corrupts per-client shipped-state and updates stop firing silently.
6. Nitro claims `routes/` as its own server-route directory. Point `serverDir`
   at the generated dir and set `scanDirs: []`, or app routes shadow the
   catch-all and return serialized vnodes as JSON.
7. `handlers[].handler` is path-resolved, so a virtual id does not survive
   Nitro's routing codegen. Generate a real file under `.fu/`.
8. Dev bootstrap order is `listen()` → `prepare()` → `build()`. `build()` starts
   the dev runner; wrong order gives `Runner did not become ready in time`.
9. crossws: returning a plain `{crossws}` object fails on Deno. Use inline
   `websocket` hooks, which behave uniformly across runtimes.
10. **Node package self-reference.** An app in this repo imports the framework
    by name, and Node resolves that by walking up to the root `package.json`
    and honouring its `exports` — the compiled `dist/`. Every app bundle then
    carried two copies of the core, one stale, and nitro's dev worker died on
    the externalised `dist/mod.js` (`Loading unprepared module`). The dev
    server had been broken from the moment the npm package landed, and nothing
    in the check task noticed. The drivers now alias the framework's own
    package name (read from the `package.json` above the runtime modules) to
    the copy they are running from; both apps build with `dist/` deleted. For
    a real consumer the alias resolves to the installed package, i.e. a no-op.
11. Nitro hard-codes `node_modules/.nitro` under `rootDir` for its well-known
    files regardless of `buildDir`, so every app directory grows a
    `node_modules/`. Harmless under the Deno workspace; do not fight it.

## Distribution

The framework is a build tool, not only a runtime library, and that dictates how
it can be shipped. `build`/`dev` hand the paths of `client.ts`, `render.ts` and
`hmr-runtime.js` to rolldown, which means those files must exist **on disk**.

Two constraints follow, both found by building the published example as a
stranger would:

1. **JSR alone does not work.** Deno keeps JSR packages as remote `https:`
   modules — confirmed with `nodeModulesDir: "auto"` and `deno install`, which
   vendor the transitive npm dependencies but leave the JSR package remote.
   `import.meta.dirname` is then undefined, and a bundler cannot fetch `https:`
   modules anyway.
2. **The npm package must ship compiled JavaScript.** Deno refuses to
   type-strip TypeScript inside `node_modules`
   (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so raw `.ts` is unusable.

So: npm carries a compiled `dist/` and is what apps install; JSR carries the
TypeScript source for reading and runtime-only use. The sibling-module extension
is derived from the framework's own module URL, so the same code works from
source and from the compiled build.

Inside this repo the compiled `dist/` is a hazard rather than a product: see
trap 10. The apps must build against `src/`, and the drivers' self-alias is
what guarantees it. `deno check` sees the same mapping because `example/` and
`fu-todo/` are Deno workspace members whose import map points
`@janit/fu` at `../src/mod.ts`; `deno task check` type-checks both
apps, which is how `ShellProps.children: unknown` (rejected by Preact's JSX)
and `node:sqlite`'s `number | bigint` row counts were caught.

### Verifying the artefact

Type-checking the tarball proves nothing: Deno does not type-check inside
`node_modules`, so a `.d.ts` importing an unshipped path and a `bin` missing its
own imports both pass silently — and both shipped in 0.0.2. `scripts/check-package.sh`
therefore packs the tarball, installs it into a scratch copy of the example app,
builds that app **through the package's own bin**, serves it, and then runs
the dev server from the package as well — a build proves nothing about dev,
and the monorepo dev server was broken for a day by a resolution problem
(trap 10) that no build step could show. It runs as part of `publish.sh`'s
pre-flight.

The script refuses to start if any of its ports is already taken. A server
left behind by an earlier run would answer the probes and let a broken
artefact pass, and that had happened: the servers used to be started in
subshells, so the cleanup killed the subshell and orphaned the server. They
now run under `setsid` and the cleanup kills the process group, with SIGKILL
as the fallback since the dev server ignores SIGTERM.

## Package layout

```
deno.json          @janit/fu, exports map, npm: imports, workspace, fmt/lint
src/
  mod.ts           core public exports
  types.ts         shared types
  app.ts           middleware chain (App, compose)
  errors.ts        HttpError, status text, error normalisation
  router.ts        URLPattern routing with the literal/segment fast path
  render.ts        SSR, island boundaries, error pages, document assembly
  client.ts        hydration + HMR re-render
  hmr-runtime.js   client HMR runtime (rolldown `implement` source)
  plugins.ts       rolldown plugins only: jsx, css, selfAlias, virtual
  driver.ts        glue both drivers share: runtime paths, project scan,
                   rolldown/nitro option sets, generated entries
  build.ts         production driver
  dev.ts           dev driver
  cli.ts           `fu dev` / `fu build`
example/           runnable app exercising every feature (workspace member)
fu-todo/           complete app with SQLite and a JSON API (workspace member,
                   published separately as janit/fu-todo)
```

`build.ts` and `dev.ts` are each a page: everything they would otherwise
duplicate lives in `driver.ts`. `plugins.ts` knows nothing about projects.
`deno task check` runs `deno fmt --check`, `deno lint`, type checks of the
framework and both apps, the tests and a JSR dry-run; `deno task check:pkg`
packs and exercises the npm artefact.

JSR enforces "no slow types": every exported function needs an explicit return
type. This cost exactly one annotation in the probe. Publishing is optional —
JSR has no private packages, so a private repo is consumed via a git or `file:`
dependency instead.

## Versions

Preact 11 (`11.0.0-rc.1` verified; rc.2 exists but is newer than the
`min-release-age=4` npmrc quarantine), `@preact/signals` 2.11, Nitro 3 beta,
rolldown 1.2, lightningcss 1.33. rolldown's `devMode` is marked "not ready for
public usage"; instability here is accepted deliberately.

## Verified

Production build on Deno and Node; one `node-server` artifact serving on Node,
Bun and Deno; dev server with island HMR, CSS HMR and route rebuild; hydration
in dev and prod; CSS Modules with `composes`; wildcard routing; `deno publish
--dry-run` clean; the npm artefact building and serving an app through its
own bin.

The HMR claims are checked in a real browser, not inferred: headless Chromium
(Playwright) loads the prod build and clicks all three islands, then loads the
dev server, clicks the counter twice, edits the island source and sees the new
markup with the count intact, then edits the CSS and sees the computed style
change without a navigation. That harness lives outside the repo for now.

Not yet built: sourcemaps in dev, an error overlay, prerendering, per-route CSS
splitting.

## Wasm

Nothing in the framework's own compute justifies wasm — route matching was 2%
of request time before the fast path and is negligible after it; the rest is
Preact SSR calling user JS. The bundler,
JSX transform and CSS engine are already Rust.

Wasm is the right tool for *bolted-on capability* instead: it is the only binary
format that runs unmodified on Deno, Node, Bun, Workers and the browser, where
native addons like `sharp` would fragment the build. Verified with
`@jsquash/webp`: byte-identical output across all three runtimes.

The rule: **compile the module yourself**, never use a library's own loader.
`@jsquash` fetches its `.wasm` over `file://`, which Deno and Bun allow and
Node's undici rejects. `WebAssembly.compile(await readFile(url))` then `init(mod)`
works everywhere, and compiling once at boot amortizes across requests.
