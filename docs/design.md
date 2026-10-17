# Fresh Urquell — design

**Date:** 2026-09-09 (design), kept up to date since; last revised 2026-10-15
**Status:** implemented and verified; a living document
**Package:** `@janit/fu` (repo `janit/fu`)

A minimal islands framework: file-system routing, SSR and hydration on
Preact 11, built by rolldown into one Worker module. celld runs it; Deno, Node
and Bun run the same module through a runner on srvx.

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
error reached the client as the server's raw JSON.

Added in 0.5.0, each because one app (routemap4's frontend) needed it and each
free for an app that does not use it: a shell that owns the whole document
(`FuHead`, `FuScripts`), status and headers for a rendered page
(`ctx.response`), static files served from inside the middleware chain
(`@janit/fu/static`), the request handler built from source for in-process
tests (`@janit/fu/testing`), and client navigation that swaps named regions of
a page (`Partial`, `data-fu-nav`; a separate chunk that only a page carrying
the attribute requests). The README describes their behaviour.

Added in 0.5.1, found by porting that app onto 0.5.0: an `async` page, error
page or shell is called and awaited by fu before anything renders, page first
(the renderer drops a component that returns a promise, so they used to render
nothing; awaiting the page first is also what lets a shell read what the page
computed), and a promise nobody can await fails the render by name; a
document-owning shell is spared fu's default error title and robots tag; every
error under `/_fu/` is `no-store`; a page preloads only the chunks it will run;
`fu dev` exits on SIGTERM and SIGINT; `staticFiles` takes an `etag` callback.

Why the async components are called outside the renderer rather than
suspended inside it: preact-render-to-string does re-render a component that
throws a promise, but it wraps the result in `<!--$s-->` comments, and the
shell has by then already rendered once, without the page's state. Called
first and awaited, the page costs nothing in markup and the order is the one
Fresh had. The price is that such a component has no hooks; what it returns
is rendered normally and has them.

Changed in 0.6.0: celld is the primary runtime, and Nitro is gone. The build
writes one Worker module (`export default { fetch }`) and a runner that serves
that same module on Node, Deno or Bun; `ctx` gained `env`, `waitUntil` and
`assets`; an optional `worker.ts` carries `prepare(env)` and whatever else the
Worker must export (Durable Object classes, `scheduled`). The request that
started it was a bolt-on, a `--target workers` beside the Nitro build. The
owner asked for the opposite: architect fu so the Worker is the artifact, and
keep the other runtimes where it costs nothing. It cost little: the core was
already `(Request) => Response`, and Nitro's remaining jobs (a static handler,
a dev server, presets) were each either a few lines over srvx or a source of
traps (listed at the end of "Traps encoded in the implementation").

Out: streaming SSR, nested layouts, per-directory middleware,
prerendering, wrappers for Durable Objects, KV, queues and cron. These are deliberate omissions, not
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
  │   rolldown: Worker (one file) + runner; dev watch      │
  └─────────────────┬─────────────────────────────────────┘
                    │  two plain data structures
  ┌─────────────────┴─────────────────────────────────────┐
  │ core (bundler-agnostic)                               │
  │   router  — segments                                  │
  │   render  — SSR + island boundary detection           │
  │   client  — hydration + HMR re-render                 │
  └───────────────────────────────────────────────────────┘
```

The core consumes exactly two things and knows nothing else about the build:

```ts
type RouteManifest = Record<string, () => Promise<RouteModule>>;
type Assets = {
  js: { href: string }[];
  css: { href: string }[];
  preload?: { href: string }[];     // what every page preloads
  islands?: Record<string, string | string[]>; // island file -> its chunk's URL,
                                    // or [its chunk, ...the chunks that one imports statically]
};
```

The build fills both from rolldown's output metadata: `preload` is the static
import closure of the entry chunk, and each island's list is its chunk plus
that chunk's static import closure (`imports`, never `dynamicImports`), minus
what `preload` already covers. A page therefore preloads what it will run and
nothing else. Announcing every shared chunk on every page, as 0.5.0 did, cost
the first real app 34 preloads per page, most of them for code the page never
executed.

This boundary is not aspirational. It was verified twice: the core ran
standalone under Deno with a hand-written manifest and no bundler at all, and
the same three core files were used byte-identically under a Vite driver and a
rolldown driver.

**Consequence:** a second driver is ~200 lines, and the choice of bundler stays
reversible. Ship the rolldown driver; keep a Vite driver possible.

## Runtime contracts

**Server.** The core's contract is a web-standard fetch function with one
optional argument: `(req: Request, extra?: { env, waitUntil, assets }) =>
Promise<Response>`. It never learns who called it. The build wraps it twice:

- **The Worker** (`.output/server/index.mjs`), what celld runs. On each
  request: `prepare(env)` from `worker.ts`, once per isolate (a memoised
  promise; a rejection is not memoised, so the next request retries); then a
  memoised dynamic import of the app; then
  `handler(request, { env, waitUntil: ctx.waitUntil, assets: env.ASSETS })`.
  The dynamic import is inlined into the one file and stays lazy (trap 6), so
  nothing of the app runs at isolate start and module-scope code sees what
  `prepare` set up.
- **The runner** (`.output/server/serve.mjs`), for Node, Deno and Bun. It
  imports the Worker (a separate file, so what runs is what celld would run)
  and calls it as a Workers runtime would: `worker.fetch(request, env, ctx)`,
  with the process environment as `env`, `assetsFromDir(.output/public)` as
  `env.ASSETS`, and a `ctx.waitUntil` that logs a rejection and that a
shutdown waits for, within the signal's grace period, as a Workers runtime
lets the work finish. One code path
  runs everywhere: the Worker's.

The Worker is built with `platform: "neutral"` and the conditions celld's own
bundler uses (`workerd`, `worker`, `import`, `default`): not `browser`, since
the same module runs on Node, and not `node`, which would pull in code celld
does not have. `node:` imports stay external.

**Routing.** A segment matcher of fu's own, since 0.5.3. Until then it was
`URLPattern`, with `urlpattern-polyfill` for Node 22; it went because it could
not be made to treat `%2F` as part of a segment (below). A route's pattern is
still spelled the URLPattern way, as a name and a sort key.

File-path mapping:

| file | pattern |
|---|---|
| `routes/index.tsx` | `/` |
| `routes/about.tsx` | `/about` |
| `routes/blog/[slug].tsx` | `/blog/:slug` |
| `routes/files/[...rest].tsx` | `/files/:rest*` |

Routes sort static → dynamic → wildcard, then by depth, then segment by segment
(a literal beats a param), then by pattern — so the file system's listing order
never decides which of two overlapping routes wins.

The pathname is matched as written, split on a literal `/`. `%2F` is part of
its segment: `/s/abc%2Fdef` answers `s/[code]`, and `/dublin%2Fcork` is one
segment. A static segment matches a segment that decodes to it.

**A param is safe by default, and that is deliberate.** Left alone, decoding
would hand a handler `../../etc/passwd` from `/blog/..%2F..%2Fetc%2Fpasswd`:
a traversal for the first app that joins a param onto a directory. Three rules
keep that from happening, whatever the app does with the value:

- *Decoding never makes a separator.* `ctx.params` is each segment decoded
  with `decodeURIComponent` on its own, except that an encoded slash or
  backslash (`%2F`, `%5C`, either case) stays as the URL wrote it. A param
  holds a `/` only between the segments of a wildcard, one per real separator,
  so `[slug]` gets `..%2F..%2Fetc%2Fpasswd`: one segment of text.
- *No param is a dot segment.* A segment that is `.` or `..` once decoded
  (`..`, `%2e%2e`, `.%2E`) is resolved the way URL parsing resolves it; a path
  that had one reaches no static or param route, and a wildcard route sees
  what is left. A request cannot get this far with one anyway: the URL of a
  `Request` is already resolved.
- *NUL is no match.* A segment that decodes to something holding `\0` is never
  a param; the router moves on to the next route.

Up to 0.5.2 the first rule was a refusal instead: a decoded value holding `/`
outside a wildcard was no match. That made `%2F` act as a separator in
practice (the request fell to the catch-all, which got `dublin/cork` for
`/dublin%2Fcork`) and left no route able to answer such a URL. Keeping the
escape gives the same safety and lets the route match. The cost is one
ambiguity: `%2F` in a param is what `%2F` and `%252F` both give.

`ctx.rawParams` is the same keys with the URL's own text, for an app that
needs to tell those apart or to decode by another rule (`decodeURI`). A
malformed escape matches, and its segment is handed over as written. A
backslash written out separates like `/`, as in a URL (a request's pathname
never holds one).

A match costs time in proportion to the length of the path, whatever the
path: this runs for every request before any middleware could refuse it. The
path is split and decoded once for all routes; a segment no part can take
(empty, or holding NUL) refuses every param route in that same pass; and a
route is placed without trying anything twice. The parts before the first
wildcard sit at the start, those after the last at the end, and each run of
parts between two wildcards goes as far right as it fits, last run first,
which is the assignment a greedy pattern match arrives at by backtracking.
One route therefore costs the number of segments, times the longest run of
parts between two of its wildcards when it has several: a property of the
route file, not of the request. (The first cut of this matcher retried every
length of a wildcard: 8000 segments and a trailing slash took 2.4 s.)

Cost, with 16 routes on Deno: a static hit ~55 ns (string equality against
the decoded path, before the path is even split), a dynamic hit ~500 ns, a
miss ~1500 ns. `URLPattern.exec` took ~3.5 microseconds per route, and even
run only where it could match, a dynamic hit was ~1900 ns.

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
  state: S; head: Head; data?: unknown; error?: RouteError;
  next(): Promise<Response>;
}
```

One `ctx` is shared by the whole chain: each level is a thin view whose fields
read and write the root, so what the router writes (`params`, `data`, `error`)
reaches every middleware on the way out; only `next` is per level. Calling
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

rolldown `DevEngine` produces patches; `crossws` carries them; a rolldown
`watch` rebuilds the Worker, which the dev server re-imports after every build
and serves through srvx, client files first. Editing an island hot-swaps its markup **and preserves hook state**;
editing CSS swaps the stylesheet in place; editing a route rebuilds the server.

The HMR socket streams module source on every save, and a browser lets any
site open a WebSocket to localhost — no CORS applies to the handshake. So it
checks `Origin`: only a page on the dev port, under a loopback name or the
bound `--host`, gets a socket; everything else, including DNS rebinding (which
keeps the port but not the name) and a missing `Origin`, gets a 403. It binds
the same host as the dev server, which is `127.0.0.1` unless `--host` says
otherwise: the dev server hands out source and stack traces, so being
reachable from the network is opt-in. On the app port the dev server
checks the `Host` header for the same reason, answering only to loopback
names, `*.localhost` and the bound `--host` (and to anything when bound to
`0.0.0.0`, where the names cannot be known).

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

**Telling dev from production.** Nothing in the bundle says which server it
is in. `fu dev` sets `FU_DEV=1` in its own environment before the app loads; a
built server never sets it. It reaches the app as `ctx.env.FU_DEV` (dev hands
the Worker the process environment, as the runner does) and as
`process.env.FU_DEV` on a runtime that has one. The case that forced it:
fu-todo's CSP is `connect-src 'self'`, and the HMR socket on `port + 1` is a
different origin, so dev, and only dev, has to name it.

**Dev is not the runtime.** The dev server runs the Worker in its own process,
so it is built with `platform: "node"` and the dev runtime's resolution, not a
Worker's. Each rebuild is imported anew under a query string, and no runtime
frees a module it has loaded, so dev memory grows with every save; that is
accepted and documented. Each is a fresh Worker, so `prepare` runs again too.
Two quick saves can finish loading out of order; the older never replaces the
newer. `celld dev` over `.output` is the runtime-true check.

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
6. **Lazy init survives inlining.** The Worker is one file
   (`codeSplitting: false`, the replacement for the deprecated
   `inlineDynamicImports`), and the app graph is a dynamic import of the
   entry. Rolldown 1.2 wraps every module of that graph in a lazy
   `__esmMin` initialiser, top-level await and third-party packages included,
   minified or not: verified by a spike on 2026-10-15 and pinned by a test (a
   route's module-scope code runs after `prepare`, on the first request).
   Rollup hoists instead; if a rolldown upgrade does, the fallback is two
   chunks in `server/` and a real dynamic import.
7. **`node:` imports have no side effects.** An external is kept for its
   side effects unless told otherwise, so an app importing `assets()` from
   `@janit/fu/static`, a module that also holds `staticFiles` and imports
   `node:fs`, got an `import "node:fs"` in its Worker. `serverInput` declares
   external `node:` modules side-effect free, so an unused one is dropped.
   Splitting the module or a conditional export would not do: under the
   runner Node runs the Worker build, so one artifact must hold both.
8. **A Workers fetch returns immutable headers.** `env.ASSETS.fetch()` on
   celld returns a Response whose headers cannot be set, and an outer
   middleware (security headers) sets headers on whatever comes back.
   `assets()` and `clientFiles` always answer with a copy.
9. crossws: returning a plain `{crossws}` object fails on Deno. Use inline
   `websocket` hooks, which behave uniformly across runtimes.
10. **Node package self-reference.** An app in this repo imports the framework
    by name, and Node resolves that by walking up to the root `package.json`
    and honouring its `exports` — the compiled `dist/`. Every app bundle then
    carried two copies of the core, one stale, and the dev server died on
    the externalised `dist/mod.js` (`Loading unprepared module`). The dev
    server had been broken from the moment the npm package landed, and nothing
    in the check task noticed. The drivers now alias the framework's own
    package name (read from the `package.json` above the runtime modules) to
    the copy they are running from; both apps build with `dist/` deleted. For
    a real consumer the alias resolves to the installed package, i.e. a no-op.
11. **Deno's server cannot be closed by force.** srvx's Deno adapter closes
    through `Deno.HttpServer.shutdown()`, which waits for every request in
    flight; there is no other way. A dev server stopped while answering a slow
    request held the exit for the whole two-second grace. Dev waits a quarter
    of a second for its server and goes on; the process exit takes the rest.
    The runner keeps the graceful close: in production a request in flight is
    worth two seconds.
12. **The asset prefix is not a path rule.** Up to 0.5.x a rule on the path
    (`/_fu/**` immutable, matched by nitro on a normalised spelling) met a
    guard in the entry that read the raw spelling, and `//_fu/x`, `/_fu%2Fx`
    and the like came back as the app's 404 marked immutable for a year: a
    cache poisoning any visitor could trigger. `clientFiles` reads the path
    once and interprets nothing: a GET or HEAD whose pathname is to the letter
    one of the files the build wrote is served from the asset store with the
    long header; anything else under the prefix is a `no-store` 404 the app
    never sees; anything not under it is the app's, whatever it looks like.
    The build tests send each spelling raw over a socket to the runner.

The traps of 0.5.x that were nitro's (its claim on `routes/`, a virtual
handler id not surviving its codegen, the dev bootstrap order, `node_modules/.nitro`
under every app, a preset picked from the building runtime, an output dir it
never cleared) went with it.

## Distribution

The framework is a build tool, not only a runtime library, and that dictates how
it can be shipped. `build`/`dev` hand the paths of `client.ts`, `render.ts` and
`hmr-runtime.js` to rolldown, which means those files must exist **on disk**.

Two constraints follow, both found by building the published example as a
stranger would:

1. **JSR does not work.** Deno keeps JSR packages as remote `https:`
   modules — confirmed with `nodeModulesDir: "auto"` and `deno install`, which
   vendor the transitive npm dependencies but leave the JSR package remote.
   `import.meta.dirname` is then undefined, and a bundler cannot fetch `https:`
   modules anyway.
2. **The npm package must ship compiled JavaScript.** Deno refuses to
   type-strip TypeScript inside `node_modules`
   (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so raw `.ts` is unusable.

So npm carries a compiled `dist/` and is the only channel. The sibling-module
extension is derived from the framework's own module URL, so the same code
works from source and from the compiled build.

JSR was tried and retired. Versions 0.0.1 to 0.0.4 went there as "the source,
for reading the API and runtime-only use", which nobody does; what it actually
cost was a second publish that drifted from npm within a day, the slow-types
rule on every exported signature, a `name`/`version`/`exports` map in
`deno.json` to keep in step with `package.json`, a dry-run in the check task
guarding a channel the README had to warn people off, and a README caveat
explaining all of that. `deno.json` is now only tasks, imports, workspace and
tool config; `package.json` is the package.

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
(private repo only) therefore packs the tarball, `npm install`s it into a scratch
copy of the example app, so the dependencies are the ones a consumer would
resolve rather than this repo's lockfile,
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
as the fallback. (Until 0.5.1 the dev server ignored SIGTERM, and SIGINT: the
HMR socket is an srvx server, whose graceful-shutdown plugin registers a
handler for both signals that closes that one server. A registered handler
cancels the runtime's default of dying on the signal, and nothing closed the
dev server, its watcher, or rolldown's dev engine, so the process stayed up
with the page port still listening. `dev()` now turns that plugin off and
registers its own handler, `exitOnSignal`, which closes all of them and exits
0, after two seconds at the latest. The runner does the same.)

## Package layout

```
package.json       the npm package: name, exports map, bin, dependencies
deno.json          npm: imports, workspace, tasks, fmt/lint
src/
  mod.ts           core public exports
  types.ts         shared types
  app.ts           middleware chain (App, compose)
  errors.ts        HttpError, status text, error normalisation
  router.ts        routing on raw path segments, with the literal fast path
  render.ts        SSR, island boundaries, error pages, document assembly
  client.ts        hydration + HMR re-render
  nav-protocol.ts  names the server and the navigation runtime share
  nav.ts           client navigation (its own chunk, loaded on demand)
  hmr-runtime.js   client HMR runtime (rolldown `implement` source)
  assets.ts        assets() middleware and the /_fu/ policy (runtime-neutral;
                   bundled into the Worker)
  static.ts        assetsFromDir store and staticFiles middleware (`node:` imports)
  serve.ts         serveWorker: the runner's adapter over srvx
  lifecycle.ts     listening, exitOnSignal (shared by dev and the runner)
  testing.ts       appHandler: the handler from source files, for tests
  project.ts       project scan (routes, islands, app, shell, error page)
  plugins.ts       rolldown plugins only: jsx, css, selfAlias, virtual
  driver.ts        glue both drivers share: runtime paths, rolldown option
                   sets, generated modules (server, Worker, runner), worker.ts
  build.ts         production driver
  dev.ts           dev driver
  cli.ts           `fu dev` / `fu build` / `fu serve`
example/           runnable app exercising every feature (workspace member)
fu-todo/           complete app with SQLite and a JSON API (workspace member;
                   private repo only, published separately as janit/fu-todo)
```

`build.ts` and `dev.ts` are each a page: everything they would otherwise
duplicate lives in `driver.ts`. `plugins.ts` knows nothing about projects.
`deno task check` runs `deno fmt --check`, `deno lint`, type checks of the
framework and both apps, and the tests; `deno task check:pkg` (private repo
only) packs and exercises the npm artefact.

Exported functions keep explicit return types. JSR's slow-types rule imposed
that and JSR is gone, but the habit makes the public surface readable without
inference and stays.

## Versions

Preact 11 (`^11.0.0`), `@preact/signals` 2.11, rolldown 1.2,
lightningcss 1.33, srvx 1.0, crossws 0.4. The Worker targets celld 0.6. rolldown's `devMode` is marked "not ready for
public usage"; instability here is accepted deliberately.

## Verified

Production build on Deno and Node; one Worker and its runner serving on Node,
Bun and Deno; dev server with island HMR, CSS HMR and route rebuild; hydration
in dev and prod; CSS Modules with `composes`; wildcard routing; the npm
artefact building, serving and dev-serving an app through its own bin.

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
