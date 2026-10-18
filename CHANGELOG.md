# Changelog

Releases before 0.5.3 are described by their commits (`git log`).

## 0.6.1

The first published 0.6. Fixes a crash in the runner that 0.6.0, tagged but
never published to npm, shipped with.

- **The runner no longer dies on the first client file under Deno without
  `--allow-sys`.** `assetsFromDir` checked a file was readable with
  `node:fs` `access`, which on Deno asks for the uid; refused, it threw
  outside any handler and ended the process. fu-todo's image runs Deno with
  `--allow-net --allow-read --allow-write=/data --allow-env`, so a container
  served its first page and went down on the first script. The check now
  opens and closes the file, which needs read access only. A test runs
  `assetsFromDir` in a Deno process with exactly those permissions, and
  `check:pkg` serves the app that way instead of with `-A`.

## 0.6.0 (tagged, not published to npm)

celld is the primary runtime. `fu build` writes one Worker module, which celld
runs as it is, and a runner that serves the same module on Node, Deno and Bun.
Nitro, h3 and unenv are no longer dependencies. `ctx` gains `env`, `waitUntil`
and `assets`.

### The surface a deployment reads

| what | value |
|---|---|
| build | `fu build [root] [--out DIR]`; no target flag, there is one artifact |
| the Worker (`main` in `wrangler.jsonc`) | `<out>/server/index.mjs`, default `<root>/.output/server/index.mjs`; one file, `export default { fetch }` plus what `worker.ts` exports |
| the asset directory (`assets.directory`) | `<out>/public`; fu writes `public/_fu/` only |
| the assets binding (`assets.binding`) | `ASSETS`, fixed |
| `run_worker_first` | at least `["/_fu/*"]`, or `true` when the app serves files through `assets()` |
| `no_bundle` | either works: the Worker is one file with no import but `node:` ones the app wrote |
| environment bridge | `prepare(env)` exported by `<root>/worker.ts` (or `.js`), called once per isolate before any app module runs; there is no CLI flag or config key for it |
| runner | `<out>/server/serve.mjs`: `node`, `bun` or `deno run -A` it; `PORT` (3000), `HOST` |
| serve a build | `fu serve [root] [--port N] [--host H] [--out DIR]` |
| `Ctx` additions | `env: Env`, `waitUntil(promise: Promise<unknown>): void`, `assets: AssetStore \| null` |
| static files | `assets({ isStatic?, cacheControl?, contentType?, store? })` from `@janit/fu/static` |

fu never writes a `wrangler.json`. Verified under `celld dev` 0.6.2
(`check:celld`): the example serves, renders its error page, serves client
files from `ASSETS` as immutable and a stale one as a `no-store` 404, and
hydrates in Chromium; `prepare(env)` runs before the app and sees `.dev.vars`;
`ctx.env`, `ctx.waitUntil` and `ctx.assets` arrive; the same build serves with
`no_bundle` set. Answers to the open questions: **`process.env` is not
populated from `vars`** (read configuration from `ctx.env`, or copy it in
`prepare`); `process.versions.node` is a string; `console.log` from the Worker
reaches the terminal under `celld dev --logs`. Also verified: the Worker's lazy
initialisation (below), and the Worker served by the runner on Node, Deno and
Bun, a build through the packed package and a browser run included.

### Behaviour changes

**The build output is a Worker and a runner, not a Nitro server.**

| | 0.5.3 | 0.6.0 |
|---|---|---|
| start a build | `node .output/server/index.mjs` | `node .output/server/serve.mjs`; `index.mjs` is the Worker and does not listen |
| `NITRO_PRESET` | picked a Nitro platform preset | ignored; there is one artifact |
| `.output/nitro.json` | written | not written; a custom `--out` dir is never cleared whole, only its `public/_fu/` and `server/` |
| `public/_fu/*.br`, `.gz`, `.zst` | written for files worth compressing | not written: celld negotiates no encodings; compress in a proxy |
| `GET /_fu/<file>/` (trailing slash) | the file, `no-store` | 404, `no-store` |
| a miss under `/_fu/` | Nitro's JSON 404, `no-store` | plain-text 404, `no-store` |
| `/_fu/%62oot-x.js`, a spelling Nitro resolved | the file, without the long cache header | 404, `no-store`: a client file is its exact URL |
| `HOST` in the environment | read by Nitro's server | read by the runner, as before; empty means every interface |
| `PORT=abc`, `PORT=0x50` | whatever Nitro made of it | refused at start, naming `PORT` |
| a malformed escape in `fu dev` | h3's 400 JSON | reaches the app, as in a build |
| a static file in `fu dev` | Nitro's public-asset handler | `Cache-Control: no-cache`, with an `ETag` |
| `fu dev` memory | grew with each save inside Nitro | grows with each save, by the rebuilt server module (documented) |

What an app has to do:

- Start the built server through `serve.mjs`, or `fu serve`. A Dockerfile's
  `CMD` and a `start` task change by one file name.
- An app that read `NITRO_PRESET` for a platform build has no equivalent;
  celld, or anything else that runs Workers, takes the Worker as it is.
- **`Ctx.env`, `Ctx.waitUntil` and `Ctx.assets` are required fields.** Code
  that only reads a `Ctx` is unaffected; code that builds one by hand (a test
  calling a middleware with a made-up context) adds
  `env: {}, waitUntil: () => {}, assets: null`, as 0.5.3 added `rawParams`.
- A package the app depends on now resolves through the `workerd` and
  `worker` export conditions, and never `node` or `browser`, in the build and
  so under the runner too. One whose `node` export the app relied on
  resolves to its worker or default export now. `fu dev` resolves as its own
  runtime does.
- Code at module scope in `app.ts`, the shell, the error page and the routes
  runs on the first request instead of at server start (after `prepare`, if
  there is one). Under the runner the difference is a few milliseconds on
  the first request; a module-scope failure is now that request's 500 and is
  retried on the next, instead of a server that does not start.

### Added

- `worker.ts` at the project root: `prepare(env)`, called once per isolate
  before the app's modules run, and every other export re-exported by the
  Worker (Durable Object classes, `scheduled`, `queue`). A default export,
  `export *`, a destructured export and a `prepare` that is not a function
  fail the build.
- `ctx.env` (the Worker's `env`; the process environment under the runner and
  `fu dev`), `ctx.waitUntil(promise)` (celld's `ctx.waitUntil`; under the
  runner a rejection is logged and stopping waits up to two seconds for work
  still running; under `fu dev` it runs on and a rejection is logged), `ctx.assets`
  (`env.ASSETS`; `null` without one). Types `Env` (augmentable),
  `AssetStore`, `RequestExtra`.
- `createHandler(parts)` returns `(request, extra?) => Promise<Response>`;
  `extra` is `{ env?, waitUntil?, assets? }`, defaulting to `{}`, a no-op and
  `null`.
- `assets({ isStatic?, cacheControl?, contentType?, store? })` in
  `@janit/fu/static`: GET and HEAD from the asset store, with the app's
  `Cache-Control` (on a 304 too) and a `Content-Type` where the store sent
  none; a miss or another method falls through. The response is a copy, so
  an outer middleware can set headers on it.
- `assetsFromDir(dir, { etag? })` in `@janit/fu/static`: an `AssetStore`
  over a directory, answering as celld's does (file or 304, 404, 405).
- `@janit/fu/serve`: `serveWorker(worker, { publicDir?, port?, hostname?,
  env?, exitOnSignal? })`, the runner's adapter. Each runtime serves with its
  own server (`Deno.serve`, `Bun.serve`, `node:http`).
- `fu serve [root] [--port N] [--host H] [--out DIR]`, and `--out DIR` for
  `fu build`.
- `appHandler(root, { env?, assetStore? })`, and the returned handler takes
  a per-request `extra`, which goes over those defaults.
- `build()` returns `{ worker, runner, publicDir }`, and prints the
  `wrangler.jsonc` lines for celld.

### Removed

- The `nitro` dependency, and with it h3 and unenv. `srvx` serves the runner
  and the dev server; `crossws` the HMR socket, as before.
- `presetOption`, `nitroOptions`, `assetCacheModule`, `writeAssetCachePlugin`,
  `assetErrorModule`, `writeAssetErrorHandler` and `EntryOptions.hosts`,
  `.assetsPrefix` from the (unsupported) build and driver exports.

### Verified

- Spike: with `codeSplitting: false`, rolldown 1.2.12 keeps every module of a
  dynamically imported graph lazy in the single output file, with top-level
  await and third-party packages, minified or not. Pinned by a build test: a
  route's module-scope code runs after `prepare`, on the first request.
- No `node:` import of fu's own reaches the Worker, also when the app imports
  `assets()` from the module that holds `staticFiles`.
- `deno task check`, `check:pkg` (the packed artefact built under Node and
  served by the runner on Deno, Node and Bun, dev-served, rebuilt with nothing
  hoisted) and `check:browser`.

## 0.5.3 (unpublished)

Routes are matched on the raw path segments, and a route gets its params
undecoded as well, in `ctx.rawParams`. `ctx.params` stays safe by default:
decoding never makes a path separator, and no param is a dot segment.

### Behaviour changes

**An encoded slash (`%2F`, `%2f`) no longer splits a path, and no longer makes
a param route step aside.** The pathname is split on a literal `/` only, and
an encoded slash or backslash stays encoded in `ctx.params`.

| request | 0.5.2 | 0.5.3 |
|---|---|---|
| `/s/abc%2Fdef`, routes `s/[code]` and `[...slug]` | `[...slug]`, `slug: "s/abc/def"` | `s/[code]`, `code: "abc%2Fdef"` |
| `/dublin%2Fcork`, routes `[from]/[to]` and `[...slug]` | `[...slug]`, `slug: "dublin/cork"` | `[...slug]`, `slug: "dublin%2Fcork"` |
| `/files/a%2Fb/c`, route `files/[...rest]` | `rest: "a/b/c"` | `rest: "a%2Fb/c"` |
| `/blog/a%2Fb`, route `blog/[slug]` only | 404 | `blog/[slug]`, `slug: "a%2Fb"` |
| `/blog/a%5Cb`, route `blog/[slug]` only | 404 | `blog/[slug]`, `slug: "a%5Cb"` |
| `/blog/..%2F..%2Fetc`, route `blog/[slug]` | 404 | `blog/[slug]`, `slug: "..%2F..%2Fetc"` |
| `/blog/%E0%A4%A` (malformed), route `blog/[slug]` | 404 (`appHandler`), h3's 400 JSON (built server) | `blog/[slug]`, `slug: "%E0%A4%A"` |
| `/a%2Bb`, routes `a+b` and `[slug]` | `[slug]` | `a+b` |

What an app has to do:

- A catch-all that splits `ctx.params.slug` on `/` now gets it right without
  further care: the param has exactly one `/` per separator the path had, so
  `/dublin%2Fcork` is one piece, `dublin%2Fcork`. A piece that should show a
  slash to a person has to be decoded once more by the app
  (`piece.replace(/%2f/gi, "/")`), knowingly.
- An app that relied on `%2F` reaching a catch-all, or on a 404 for it, now
  gets the param route. If such a path must not be accepted, say so in the
  route: `if (/%2f|%5c/i.test(ctx.rawParams.code)) throw new HttpError(404)`.
- `%2F` in `ctx.params` is what `%2F` and `%252F` both give (double encoding
  is decoded once, as before). `ctx.rawParams` tells them apart.
- A request with a malformed percent escape now reaches the route, with that
  segment as written in both `params` and `rawParams`, in a built server and
  through `appHandler`. A route that calls `decodeURI` or
  `decodeURIComponent` on a raw param must catch the `URIError`.
- **`Ctx.rawParams` is a required field**, and so are `Matched.rawParams`
  and `Route.parts`. Code that only reads a `Ctx` is unaffected, but code that
  builds one (a test that calls a middleware or `compose` with a hand-made
  context, as fu's own tests do) stops type-checking until it adds
  `rawParams: {}`. The same goes for anything that builds a `Matched` or a
  `Route` by hand.
- A route file whose name itself holds a percent escape is reached by another
  URL than before. The route's static text is the file name, compared with
  the request segment after decoding: `100%25.tsx` is the text `100%25`, so it
  answers `/100%2525` and no longer `/100%25` (which is the text `100%`, the
  file `100%.tsx`).
- **`Route.urlPattern` is gone, and so is the `urlpattern-polyfill`
  dependency.** `Route` is exported as a type from `@janit/fu` and
  `@janit/fu/router`, so this removes a member of an exported type; it was
  never documented, and the router is listed in the README as unsupported
  surface. Side effect: on Node 22, which has no `URLPattern`, fu no longer
  installs a global one. An app that used the global there needs its own
  polyfill.

### Added

- `ctx.rawParams`: the same keys as `ctx.params`, as `ctx.url.pathname`
  spells them. A wildcard is its raw segments joined with `/`. Set for
  handlers and pages, visible to a middleware once `ctx.next()` has resolved,
  and present through `appHandler`. Required on the `Ctx` type (see
  "Behaviour changes").
- `Matched.rawParams` and `Route.parts` on the (unsupported) router exports,
  both required.

### Changed

- A static route segment matches a request segment that percent-decodes to
  it, whatever was escaped: `/%61bout` and `/a%2Bb` reach `about.tsx` and
  `a+b.tsx`. An encoded slash never equals a real one here either. A file
  name is taken as text: `100%.tsx` answers `/100%25`.
- A built server no longer lets h3 answer a malformed path with its own 400:
  the generated nitro plugin sets `allowMalformedURL`, and fu routes the
  request. Under `/_fu/` it stays nitro's uncacheable 404.
- The matcher is fu's own; `URLPattern` is no longer run (24 kB less in a
  built server). A match costs time in proportion to the length of the path:
  the path is split and decoded once, and no route is tried twice. A path of
  8000 segments is matched, or refused, in under a millisecond.
- A client file asked for under a trailing slash (`/_fu/boot-x.js/`, which
  nitro's static handler serves with the file) now carries `no-store`; it had
  no cache header. `immutable` stays for the exact built path only.
- A backslash written out in a string handed to `match()` is a separator,
  like `/`, for param and wildcard routes, and no static route answers such a
  string. Only a direct caller can pass one: the pathname of a request never
  holds a backslash. 0.5.2 gave the same answer for a wildcard route on a path
  without dot segments (`/files/a\b` gives `rest: "a/b"` in both); elsewhere
  it could differ, because it counted the segments before URL parsing turned
  the backslash into a slash (`/a\b` with `[a]/[b]` and `[...slug]`: 0.5.2
  the catch-all with `slug: "a/b"`, 0.5.3 `[a]/[b]`).

### Unchanged, and pinned by tests that pass on the 0.5.2 matcher

- **No param is ever `.` or `..`.** A dot segment, written out or encoded
  (`..`, `%2e%2e`, `.%2E`: 0.5.2 made no difference between them, and neither
  does 0.5.3), is resolved the way URL parsing resolves it. A path that had
  one reaches no static or param route; a wildcard route sees what is left
  (`/files/a/%2e%2e/b` gives `rest: "b"`). A request never gets that far with
  one: the URL of a `Request` is already resolved.
- A decoded segment holding NUL is never a param.
- An empty segment or a trailing slash matches nothing (`//`, `/about/`,
  `/files/`, `/blog//x`); a wildcard answers its base path (`/files`) with no
  key; a catch-all at the root does not answer `/`.
- Route order: static, then param, then wildcard; ties by the earliest
  literal segment.
- The client: no chunk changed by a byte (boot 11826 B), and the HTML of the
  example and fixture apps is byte-identical.

### Known limits

- `fu dev` still answers a malformed path with h3's 400 JSON: nitro's dev
  server has an h3 app of its own in front that fu cannot configure.
- `rawParams` is raw as far as the URL of the `Request` is. URL parsing has
  already resolved dot segments, escaped what cannot stand in a path and
  turned `\` into `/`.
