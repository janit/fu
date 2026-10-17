# Fresh Urquell

A minimal islands framework: file-system routing, SSR and hydration on
Preact 11, built by [rolldown](https://rolldown.rs) into one Worker module.
Runs on **[celld](https://celld.dev)** (and anything else that runs Workers),
and on **Deno, Node and Bun** through a runner on [srvx](https://srvx.h3.dev).

No Vite, no Babel, no esbuild. The bundler, JSX transform and CSS engine are
all Rust.

```
core     router + render + client + navigation + hmr runtime + app, errors, types
drivers  build + dev + cli + shared driver glue + rolldown plugins
server   asset store and static files, the runner for Node/Deno/Bun, the in-process test handler
```

## What this is

Fresh Urquell is inspired by [Deno Fresh](https://usefresh.dev/), and aims to be
just a single pint of glue code — enough to form a functional, simple framework
on top of known good libraries, and no more. The interesting work already lives
in Preact, rolldown, srvx and lightningcss; this only binds them together.

It is experimental and primarily just for myself. Use it accordingly.

## Installing it

On Node (22.12 or later) or Bun:

```sh
npm i @janit/fu preact @preact/signals
npx fu dev          # and: npx fu build
```

On Deno 2, the packages have to land in a real `node_modules/`, and the JSX
settings are yours to give:

```sh
deno add npm:@janit/fu npm:preact@^11 npm:@preact/signals
deno run -A npm:@janit/fu/cli dev .
```

```jsonc
// deno.json
{
  "nodeModulesDir": "auto",
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "preact" }
}
```

`@preact/signals` is an optional peer: leave it out if no island imports it. A
build fails on an import that resolves to nothing, rather than producing a
server that cannot start.

npm is the only channel. The framework hands its own runtime modules to
rolldown, so it must be a real directory on disk, which an npm install is. It
was published to JSR up to 0.0.4 and is no longer updated there, so do not
install it from JSR: Deno keeps JSR packages as remote `https:` modules, and a
bundler cannot fetch one.

The npm package ships compiled JavaScript, because Deno refuses to type-strip
TypeScript inside `node_modules`.

## Quick start

```sh
npm install        # once: installs the toolchain (rolldown, lightningcss, srvx)

deno task dev      # example app, dev server with HMR on localhost:1337
deno task build    # example app, production build


deno task test     # unit tests, no browser
deno task check    # format, lint, types (framework and both apps), tests
```

The CLI behind those tasks is `fu dev [root] [--port N] [--host H]`,
`fu build [root] [--out DIR]` and `fu serve [root] [--port N] [--host H] [--out DIR]`,
which serves a build on the runtime running it. The root defaults to the working directory and must contain
`routes/`. The dev server listens on `--port` (1337) and its HMR socket on the
port after it. It binds to `127.0.0.1` and answers only to loopback names
(`localhost`, `127.0.0.1`, any `*.localhost`), because it hands out source and
stack traces. `--host 0.0.0.0` opens it to the network, for a container or
another device; `--host <name>` binds and admits that one name. `fu --help` and
`fu --version` do what they say. `fu dev` stops on SIGINT (Ctrl+C) and on
SIGTERM: it closes the HMR socket, the dev server and the watchers, and exits
with code 0, within two seconds at the latest.

A build is one artifact for every runtime:

```
.output/
  server/index.mjs   the Worker: `export default { fetch }`, and what worker.ts exports
  server/serve.mjs   the runner: serves that Worker on Node, Deno or Bun
  public/_fu/        the client files, under content-hashed names
```

Run it on whichever runtime you like:

```sh
node example/.output/server/serve.mjs
bun  example/.output/server/serve.mjs
deno run -A example/.output/server/serve.mjs
```

The runner listens on `PORT` (3000 if unset or empty; anything but a port
number is an error naming it) and `HOST` (every interface if unset or empty),
hands the Worker the process environment as `env` and `.output/public` as
`env.ASSETS`, and stops on SIGINT and SIGTERM, giving `waitUntil` work still
running two seconds to finish. It uses each runtime's own server: `Deno.serve`,
`Bun.serve`, `node:http`. For celld, see [Deploying to
celld](#deploying-to-celld).

A build minifies the client, serves it from `/_fu/` under content-hashed names
with a year-long `immutable` cache, and
announces as `modulepreload` what the page is going to run, so that its
islands start loading in one round trip after the HTML: the chunks the boot
module imports statically (on every page), and, for each island the page
rendered, that island's chunk and the chunks it imports statically. A page
without islands announces none of the island code, and a chunk reached only
by a dynamic `import()` (a library an island loads on demand, the navigation
runtime) is never announced: it is fetched when it is asked for. The dev
server serves plain names from `/` and preloads nothing. It links `/style.css`
only while the app has a stylesheet (CSS imported by a route, the shell or an
island): an app without CSS requests no such file. The link is decided on every
render, so it appears on the first page rendered after the first stylesheet is
written; a page already open gets it through the hot reload message that
announces the sheet, and no reload is needed. A build is unaffected.

### Knowing when the page is hydrated

Islands hydrate after the page has loaded, because the boot module imports
their chunks dynamically. When the first hydration pass is over the boot
module sets `data-fu-hydrated` (empty) on `<html>` and dispatches a plain
`fu:hydrated` event on `window`; the names are `HYDRATED_ATTR` and
`HYDRATED_EVENT` in `@janit/fu/client`. The pass is over when every island on
the page has been hydrated or has failed: a chunk that does not load or an
island that throws is logged, as before, and does not hold the signal back or
stop the others. A page with no islands is signalled too. It fires once per
document; a client navigation does not fire it again, `fu:nav` already means
that the islands that arrived are hydrated. The server never renders the
attribute. The signal is independent of the navigation runtime, which loads
beside the islands: it can be installed before or after the signal. A test
that drives a browser waits for `html[data-fu-hydrated]`; code that must run
after hydration listens for the event, after checking the attribute (a
listener added late would miss it).

## Deploying to celld

The Worker is what celld runs. The app owns its `wrangler.jsonc`; fu never
writes one, and `fu build` prints the lines it needs:

```jsonc
{
  "name": "my-app",
  "main": ".output/server/index.mjs",
  "compatibility_date": "2026-10-01",
  "assets": {
    "directory": ".output/public",
    "binding": "ASSETS",
    "run_worker_first": ["/_fu/*"]
  }
}
```

`binding` must be `ASSETS`: that is where the Worker looks for the asset
store. `run_worker_first` sends the client files through the Worker, which
serves them from that store with the year-long cache header and answers
anything else under `/_fu/` with an uncacheable 404; without it celld serves
them itself, with its default `max-age=0`. An app that serves its own static
files through [`assets()`](#static-files) lists their paths there too, or sets
`true` to run every request through the Worker. Put those files in the asset
directory as part of your own build step: fu writes only `public/_fu/`, and
clears only that when `--out` names a directory of yours. The Worker is one
file, so `"no_bundle": true` works, or celld's esbuild may bundle it again.

Nothing of the app runs when the Worker is loaded. On the first request
`prepare(env)` from `worker.ts` runs, if there is one, and only then are
`app.ts`, the shell and the routes evaluated, so code at module scope can
read what `prepare` set up. That holds for what the app reaches through
`app.ts` and the routes; a module that `worker.ts` itself imports runs when
the Worker is loaded, as any import does.

### `worker.ts`

Optional, at the project root, beside `app.ts`:

```ts
import type { Env } from "@janit/fu";
import { bindEnv } from "./lib/env.ts";

/** Called once per isolate, before the app's modules run. */
export async function prepare(env: Env): Promise<void> {
  bindEnv(env);
}

/** Everything else is exported by the Worker as it is: handlers and classes. */
export const scheduled = { async scheduled(event, env, ctx) {} };
export class Room { /* a Durable Object */ }
```

`prepare` is called, not exported; a `prepare` that throws fails that request
and is tried again on the next. (A route module that throws at module scope
fails every request until the next deploy, as a failed import would.) Under
`fu dev` each rebuild is a fresh Worker, so `prepare` runs again after every
save, and whatever it opened stays open: dev only, but a `prepare` that opens
connections will collect them across a long session. Every other export is re-exported by the
Worker unchanged, which is how a Durable Object class, a `scheduled` or a
`queue` handler reaches celld; celld refuses a deploy whose exports are not
all handlers or classes. A default export, `export *`, a destructured export
and a `prepare` that is not a function fail the build. fu adds no wrapper for
Durable Objects, KV, queues or cron: they are celld's, reached through `env`.

### `ctx.env`, `ctx.waitUntil`, `ctx.assets`

```ts
app.use(async (ctx) => {
  const res = await ctx.next();
  ctx.waitUntil(report(ctx.env.LOG_URL as string, ctx.url.pathname));
  return res;
});
```

- **`ctx.env`** is the Worker's `env`: on celld the `vars` and bindings of
  `wrangler.jsonc`; under the runner and `fu dev` the process environment.
  On celld `vars` reach `env` and not `process.env`, so read
  configuration from here, or copy what a library wants into `process.env`
  in `prepare(env)`.
  Type your own by augmenting the `Env` interface:
  `declare module "@janit/fu" { interface Env { LOG_URL: string } }`.
- **`ctx.waitUntil(promise)`** keeps the isolate alive until the promise
  settles: celld may stop an isolate once the response is sent, and work not
  handed over here can be cut off. Under the runner a rejection is logged,
  and stopping the server waits for what is still running (two seconds at
  most); under `fu dev` the work runs on and a rejection is logged.
- **`ctx.assets`** is the asset store, `env.ASSETS`: celld's binding, or
  `.output/public` under the runner (the client directory in `fu dev`).
  `null` where there is none. See [Static files](#static-files).

## Project shape

```
app.ts (or app.tsx)               middleware chain (optional)
state.ts                          your State type (a convention, not scanned)
middleware/*.ts                   one concern per file (a convention; app.ts imports them)
routes/_app.tsx                   shell wrapping every page (optional)
routes/_error.tsx                 error page (optional)
routes/index.tsx              ->  /
routes/about.tsx              ->  /about
routes/blog/[slug].tsx        ->  /blog/:slug
routes/files/[...rest].tsx    ->  /files/:rest*
islands/Counter.tsx               interactive, hydrated on the client
islands/counter.module.css        CSS Modules, scoped
```

Every `.ts`, `.tsx`, `.js` and `.jsx` file under `routes/` is a route, except:
files and directories starting with `_` (framework files, and a place for your
own helpers, such as `routes/_parts/`), tests (`*_test.*`, `*.test.*`) and
`.d.ts` files. The same goes for `islands/`.

A file name is taken literally, so `routes/a+b.tsx` answers `/a+b`. A param
name (`[slug]`, `[...rest]`) must be an identifier; `[my-id]` is refused at
startup, and so are two files that would answer the same path
(`blog.tsx` and `blog/index.tsx`).

A route exports a page component, and optionally `handlers`:

```tsx
export const handlers = {
  GET: () => ({ renderedAt: new Date().toISOString() }),
};

export default function About(ctx: PageContext) {
  return <p>{(ctx.data as { renderedAt: string }).renderedAt}</p>;
}
```

Return a `Response` from a handler to short-circuit; return anything else and
it lands on `ctx.data`. A route with no page has nothing to render that data
with, so there a handler must return a `Response`; forgetting to is a 500.

Handlers are keyed by HTTP method. A page renders for `GET` and `HEAD` whether
or not it has a `GET` handler, so a route with only `POST` still shows its form.
`HEAD` runs the `GET` handler and drops the body. `OPTIONS` is answered for you,
and any other method without a handler is a 405 carrying `Allow`.

### Route params

A request path is matched as it is written, split on `/` and on nothing else.
An encoded slash (`%2F`, `%2f`) is part of its segment, never a separator:
`/s/abc%2Fdef` has two segments and answers `routes/s/[code].tsx`, and
`/dublin%2Fcork` has one, so it does not answer `routes/[from]/[to].tsx`. A
static segment of a route matches a segment that percent-decodes to it, so
`/%61bout` reaches `routes/about.tsx`, and a route whose file name is not ASCII
is reached by its percent-encoded path.

A matched route gets its params twice:

| request path | `ctx.params` | `ctx.rawParams` |
|---|---|---|
| `/s/abc` | `{ code: "abc" }` | `{ code: "abc" }` |
| `/s/a%26b%20c+d` | `{ code: "a&b c+d" }` | `{ code: "a%26b%20c+d" }` |
| `/s/abc%2Fdef` | `{ code: "abc%2Fdef" }` | `{ code: "abc%2Fdef" }` |
| `/s/abc%252Fdef` | `{ code: "abc%2Fdef" }` | `{ code: "abc%252Fdef" }` |
| `/s/a%5Cb` | `{ code: "a%5Cb" }` | `{ code: "a%5Cb" }` |
| `/files/a%20b/c%2Fd` (`files/[...rest]`) | `{ rest: "a b/c%2Fd" }` | `{ rest: "a%20b/c%2Fd" }` |
| `/files` (`files/[...rest]`) | `{}` | `{}` |
| `/s/%E0%A4%A` (malformed) | `{ code: "%E0%A4%A" }` | `{ code: "%E0%A4%A" }` |

- `ctx.params` is each segment decoded with `decodeURIComponent`, one segment
  at a time, **except that decoding never makes a separator**: an encoded
  slash or backslash (`%2F`, `%2f`, `%5C`, `%5c`) stays in the param as the
  URL wrote it, case included. A wildcard is its decoded segments joined with
  `/`, so it holds exactly as many `/` as the path had separators and can be
  split on `/` safely.
- This is deliberate, and so is the next rule: **no param is ever `.` or
  `..`**, and none can be read as a path that climbs.
  `/blog/..%2F..%2Fetc%2Fpasswd` gives `slug: "..%2F..%2Fetc%2Fpasswd"`, one
  segment of text.
- **Warning:** params keep `%2F` and `%5C` encoded on purpose. Do not run
  `decodeURIComponent` on a param before using it in a file path or in the
  URL of an upstream request: that turns `..%2F..%2Fetc` back into a path.
- `%252F` is decoded once, to `%2F`, so `%2F` in `ctx.params` is what both
  `%2F` and `%252F` give. `ctx.rawParams` tells them apart.
- `ctx.rawParams` has the same keys with the text exactly as
  `ctx.url.pathname` spells it, undecoded; a wildcard is its raw segments
  joined with `/`. Use it to decode by another rule:
  `decodeURI(ctx.rawParams.code)` leaves `%23 %24 %26 %2B %2C %2F %3A %3B
  %3D %3F %40` encoded and decodes the rest (`%5C` included).
- A segment with a malformed escape (`%`, `%zz`, a cut-off UTF-8 sequence)
  still matches, and both objects carry that whole segment as written.
  Nothing throws, and `decodeURI` on it will: catch that.
- A segment that decodes to something holding NUL is never a param: no param
  route answers such a path.
- An empty segment and a trailing slash match nothing: `/about/` and `//about`
  are not `/about`.
- Dot segments never reach a route. The URL of a request has them resolved
  before fu reads it, written out or encoded: `/files/a/../b` and
  `/files/a/%2e%2e/b` both arrive as `/files/b`. (The matcher resolves them
  the same way for a direct caller, and hands none to a param.)
- Both objects are `{}` in a middleware until `ctx.next()` has resolved.

### Async pages

The page component, `routes/_error.tsx` and `routes/_app.tsx` may each be an
`async function`:

```tsx
export default async function Post(ctx: PageContext<State>) {
  const post = await loadPost(ctx.params.slug);
  if (!post) throw new HttpError(404);
  ctx.state.pageTitle = post.title; // the shell reads this
  return <article>{post.body}</article>;
}
```

fu calls an async one itself, with what it would have been rendered with (the
page and the error page get `ctx`, the shell `{ ctx, children }`), awaits it
and renders what it resolved to. The order is fixed: the page (or the error
page) settles first, then the shell is called. So whatever an async page
writes on `ctx.state` or `ctx.head` is there when the shell runs. A
synchronous page is rendered inside the tree, as always, which means after
the shell has run: a shell cannot read state that a synchronous page writes
while rendering. Write it from a handler, or make the page async.

- An async component is called outside the renderer, so it **cannot use
  hooks** (`useState`, `useContext`, `useId`, signals hooks). What it returns
  can: components and islands in it render as anywhere else.
- A rejection is a throw: from the page it goes to the error page with the
  status of an `HttpError`, or 500; from the error page it falls back to the
  plain-text response; from the shell it is a 500 in plain text.
- **State survives a failure.** `ctx.state` is one object for the whole
  request and is never reset. What an async page wrote there before it
  rejected (and what a handler or a synchronous page wrote before throwing)
  is still there when the error page and the shell run. `ctx.head` is reset,
  `ctx.state` is not: an error page that must not show a half-computed title
  or view name overwrites it.
- "Async" means declared with the `async` keyword. Nothing else can be awaited,
  and nothing is dropped silently: a page, error page or shell that returns a
  promise without being `async` (a class whose `render()` returns one
  included), and an async component anywhere else in the tree, fail the
  render with an error that names the component. An island cannot be the
  page, the error page or the shell, async or not: that fails too.
- Known limits. A component further down the tree that returns a promise
  without being `async`, function or class, is the one case fu cannot see:
  Preact renders nothing for it. And detection is by the keyword, so a build
  step that compiled `async` away would turn an async page into the "returned
  a promise" failure (loud, not silent); fu's own build does not.

## Middleware

`app.ts` composes an ordered chain. Registration order is outermost first, so
the first registered runs first on the way in and **unwinds last** — it has the
final say on headers, including on short-circuit responses from further in.

```ts
import { App } from "@janit/fu";

const app = new App<State>();

app.use(async (ctx) => {                 // outermost: unwinds last
  const res = await ctx.next();
  res.headers.set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'");
  res.headers.set("X-Frame-Options", "DENY");
  return res;
});

app.use((ctx) =>                         // short-circuit: never calls next()
  ctx.url.pathname === "/healthz"
    ? new Response("ok")
    : ctx.next()
);

app.use((ctx) => {                       // populate state for everything below
  ctx.state.tenant = resolveTenant(ctx.req);
  return ctx.next();
});

export default app;
```

A middleware either returns a `Response` (short-circuiting) or returns
`ctx.next()`. Await `next()` first to inspect or mutate the response. Throwing
propagates outward past any `await ctx.next()`. Pass `ctx` itself along, never
a copy: its fields are views onto one shared context, and `{ ...ctx }` copies
none of them.

Middleware runs **before** routing, so `ctx.params` and `ctx.rawParams` are
empty inside it — match on `ctx.url.pathname`. That is what lets a middleware answer a request no route
exists for: redirects, `/healthz`, `/robots.txt`.

Redirects need nothing special — read state, read the URL, return a response:

```ts
export const redirects: Middleware<State> = (ctx) => {
  const hit = table[ctx.url.pathname];
  if (!hit) return ctx.next();
  return new Response(null, { status: hit.status, headers: { location: hit.to } });
};
```

Nothing in a request says whether `fu dev` or a build is serving it, and the
same middleware runs in both. So the dev server sets `FU_DEV=1` in its own
environment before it starts the app, and a built server never does. Read it
for anything that must be laxer in dev — a Content-Security-Policy, say, which
has to name the HMR socket on `port + 1`, because a different port is a
different origin:

```ts
const dev = ctx.env.FU_DEV === "1"; // inside a middleware; ctx.env on every runtime
const connectSrc = dev ? "connect-src 'self' ws://localhost:*" : "connect-src 'self'";
```

## Errors

Anything thrown by a handler, a page or a middleware is turned into a response
rather than reaching the server as an unhandled crash. So are 404 and 405.
`HttpError` takes a status from 400 to 599.

```ts
import { type Handlers, HttpError } from "@janit/fu";

export const handlers: Handlers<State> = {
  GET(ctx) {
    if (!ctx.state.session) throw new HttpError(403, "Not yours");
    ...
  },
};
```

`HttpError` takes response headers as a third argument —
`new HttpError(429, "Slow down", { headers: { "retry-after": "30" } })` — and
they are sent whether or not an error page renders.

An optional `routes/_error.tsx` renders them, receiving `ctx` like any page with
`ctx.error` set to `{ status, message }`. It is wrapped by `routes/_app.tsx`, so
error pages inherit the app's markup. Without one you get plain text.

Two things the framework does for you:

- **An unexpected throw never renders its message.** `ctx.error.message` is
  generic for it, and for a 5xx from another library; the real error goes to
  `ctx.error.cause` and is logged, because a thrown error's message routinely
  carries connection strings and file paths. A message you wrote yourself, in
  `new HttpError(...)`, is rendered at any status, 5xx included.
- **No failure the framework renders is cacheable.** Its error responses carry
  `no-store`, and the error page adds `<meta name="robots" content="noindex">`
  (the plain-text fallback has no such tag, and neither has a shell that
  [owns the document](#owning-the-document)). During a deploy a valid URL can
  404 for a few seconds, and a shared cache would pin that. One place is not
  yours: everything under `/_fu/` belongs to the built client files. A path
  there that is not a file, and any method but GET and HEAD, gets a plain
  404 and never reaches your routes, middleware or error page. That 404 is
  `no-store` too: a page left open across a deploy asks for chunks of the old
  build, and a cached 404 would outlive a rollback. The year-long `immutable`
  header goes on a client file asked for by the exact URL the build gave it
  (a query string allowed) and served from the asset store (200, 206 or 304),
  and on nothing else. No path is interpreted: `/_fu/boot-abc.js/` and
  `/_fu/%62oot-abc.js` are not that URL and get the 404, and `//_fu/x`,
  `/_fu%2Fx`, `/_FU/x` and the like are not under the prefix, reach your app
  like any other unknown path, and come back with the headers your app gave
  them.

Errors from a handler or a page are caught at the route boundary and returned
*through* the middleware chain, so security headers and logging middleware still
see them. A middleware that throws is different: the throw propagates outward
past every `await ctx.next()`, so an outer middleware can catch it, and only what
nobody catches becomes an error response — at the very top, after the chain has
unwound, without the headers the middleware would have set. To refuse a request
from middleware, return the response rather than throwing.

## Page metadata

`ctx.head` is the channel from a route to the document `<head>`. Middleware can
write to it too.

```ts
export const handlers = {
  GET: (ctx: PageContext<State>) => {
    ctx.head.title = `${ctx.params.slug} — Fresh Urquell`;
    // ctx.url.origin echoes the request's Host header; a real site configures its origin.
    ctx.head.canonical = `${ctx.url.origin}/blog/${ctx.params.slug}`;
    ctx.head.jsonLd = { "@context": "https://schema.org", "@type": "BlogPosting" };
    return null;
  },
};
```

The framework renders `title`, `description`, `canonical`, `robots`, `image`,
`lang`, arbitrary `links` and a JSON-LD block. An optional `routes/_app.tsx`
wraps the body markup and can read `ctx.state`.

An island is any component under `islands/`. It renders on the server and
hydrates on the client:

```tsx
import { useSignal } from "@preact/signals";
import styles from "./counter.module.css";

export default function Counter({ start = 0 }) {
  const n = useSignal(start);
  return <button class={styles.badge} onClick={() => n.value++}>{n}</button>;
}
```

Every export of an island file is an island, default or named, so one file can
hold several. Props travel to the client as JSON: strings, numbers, arrays and
plain objects cross; a function or JSX element (including JSX `children`) fails
the render with an error naming the prop, rather than hydrating without it.

An island rendered inside another island is part of the outer one: it hydrates
with it and gets no boundary of its own, so editing it in dev reloads the page
rather than hot-swapping. A class component works as an island,
but its state does not survive a hot swap the way hook state does. Islands
hydrate independently, so one that throws is reported in the console and the
rest of the page still works.

## Owning the document

A `routes/_app.tsx` that returns `<html>` owns the whole document. fu writes
the doctype in front of it and nothing else: no charset, no viewport, no
`lang` (`ctx.head.lang` is for fu's own document and is not used here).

```tsx
import { FuHead, FuScripts, type ShellProps } from "@janit/fu";

export default function Shell({ ctx, children }: ShellProps<State>) {
  return (
    <html lang={ctx.state.lang}>
      <head>
        <meta charset="utf-8" />
        <FuHead />
      </head>
      <body>
        {children}
        <FuScripts />
      </body>
    </html>
  );
}
```

`<FuHead />` is where fu's head tags go: the `ctx.head` fields that were set,
the stylesheets, the preloads and the JSON-LD block. `<FuScripts />` is where
the boot script goes, usually last in `<body>`. Leave one out and what it
stands for is not emitted (no stylesheets, or no hydration), with one warning
in the server log; place one twice and the render fails. A shell that returns
anything else is wrapped in fu's document as before, and the two components
are ignored there.

**On the error page the head is the shell's too.** Before `routes/_error.tsx`
renders, fu clears what the failed page put in `ctx.head` (keeping `lang` and
`links`, which are app-wide) and gives it two defaults: a title such as
`404 Not Found`, and `robots: "noindex"`. In fu's own document those are
emitted. An owning shell writes its own `<title>` and robots tag, so there
`<FuHead />` leaves the two defaults out and emits only what the app itself
assigned to `ctx.head` after that reset, which in practice means from the
error page or the shell, a title or robots value included. The reset takes
everything else with it: a `description`, `canonical`, `image` or `jsonLd`
that a middleware set before calling `ctx.next()` is gone on the error path,
in either kind of document (a middleware that wants a field on every page,
error pages too, uses `links`, or sets it in the shell). What fu still
guarantees for every error response is the status and
`cache-control: no-store`; saying `noindex` on an error page is then the
shell's job:

```tsx
{ctx.error && <meta name="robots" content="noindex" />}
```

The defaults stay readable (`ctx.head.title` is `"404 Not Found"` while the
error page renders), so a shell can still use them. Assigning to a field is
what makes it the app's, whatever the value: code that copies the head onto
itself, such as `Object.assign(ctx.head, { ...ctx.head })`, assigns the two
defaults too, and an owning shell then emits them again.

## Response status and headers

A handler or a middleware sets `ctx.response.status` and
`ctx.response.headers` and the rendered page carries them:

```ts
export const handlers = {
  GET: (ctx: PageContext<State>) => {
    ctx.response.status = 410;
    ctx.response.headers.set("cache-control", "public, max-age=60");
    return { gone: true };
  },
};
```

A `Response` returned by a handler ignores them, and so does every error
response: a handler that set a public `cache-control` and then threw cannot
make the error cacheable. A status of 400 or more is sent `no-store` whatever
the headers say. The status must be 200 to 599 and not 204, 205 or 304, which
cannot carry a page; anything else fails the render. `set-cookie` is appended,
every other header replaces.

## Static files

`@janit/fu/static` has two middlewares: `assets()` reads the runtime's asset
store, so it works on celld and everywhere else; `staticFiles()` reads a
directory, so it needs a filesystem. Both serve from inside the middleware
chain: a middleware registered before them can answer a path itself and still
decorates what is served (security headers, say), and anything that is not a
file falls through to `ctx.next()`. Unlike `/_fu/`, which is served before the
app runs.

```ts
import { assets } from "@janit/fu/static";
import { STATIC_PATHS } from "./static-paths.gen.ts"; // your build's list

app.use(assets({
  isStatic: (pathname) => STATIC_PATHS.has(pathname),
  cacheControl: (pathname, url) =>
    url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "public, max-age=3600",
  contentType: (pathname) => pathname === "/LICENSE" ? "text/plain; charset=utf-8" : null,
}));
```

`assets()` answers `GET` and `HEAD` from `ctx.assets` (celld's `ASSETS`
binding, or the directory the runner and `fu dev` hand over). A 200, 206 or
304 from the store is passed on with `cacheControl(pathname, url)` put on it,
a 304 included, and with `contentType(pathname)` when the store sent no type
(celld sends none for an unknown extension); anything else, a miss included,
falls through. `isStatic` is asked first, with the raw path, so a page request
costs no lookup in the store; without it every GET is tried. `store` gives it
a store of its own, such as `assetsFromDir(dir)`. On celld it needs
`run_worker_first` to cover those paths, or celld answers them before the
Worker is asked.

`assetsFromDir(dir, { etag })` is the store over a directory that the runner
and `fu dev` use. It answers as celld's does, as far as an app can tell: the
file or a 304, a 404 for a miss, a 405 for another method.

```ts
import { staticFiles } from "@janit/fu/static";

app.use(staticFiles({
  dir: "/srv/app/static",
  cacheControl: (pathname) => pathname.startsWith("/icons/") ? "public, max-age=604800" : null,
}));
```

`staticFiles()` is `assetsFromDir` as a middleware, reading the path in
`ctx.url` (so a middleware before it may rewrite it). It imports `node:fs`, so
it does not work on celld; an app that imports only `assets()` from the same
module gets none of that code in its Worker. What it and `assetsFromDir`
promise:

- **Paths.** The raw path is split on `/` and each segment decoded on its own,
  so an encoded slash is never a separator. A segment that is empty, starts
  with a dot (`.`, `..`, dotfiles), holds a slash, a backslash or a NUL once
  decoded, or is malformed, is not served. No directory listing and no
  `index.html`.
- **Symlinks are followed** and their targets are not checked against `dir`.
  Only put links you trust there.
- **`dir` should be absolute.** A relative one is resolved once, against the
  directory the server was started from. If the result is not a directory, a
  warning is logged at startup and every request falls through.
- **Validators.** A weak `ETag` from size and modification time, and
  `Last-Modified`; a matching `If-None-Match` (which wins when both are sent)
  or `If-Modified-Since` gets a 304. `Cache-Control` is whatever
  `cacheControl(pathname, url)` returns for a file that is served, given the
  decoded path; none by default. A 304 carries the same `ETag`,
  `Last-Modified` and `Cache-Control` as the 200 would, as RFC 9110 asks, so
  a cache refreshes its entry with them.
- **Your own ETag.** The built-in tag changes whenever a file is written
  again, identical bytes or not, which every image build does. An app that
  knows better passes `etag: (pathname, stat) => string | null`, with
  `stat` being `{ size, mtimeMs }`: return the complete header value, quotes
  included (`'"' + hash + '"'`, or `W/"..."` for a weak one), or `null` for
  the built-in tag. It is asked once per served file, and its value is the
  one sent and the one `If-None-Match` is compared with. Anything that is
  not an entity-tag, a tag with a comma in it (`If-None-Match` is a
  comma-separated list, so it could never match), or a throw, is logged once
  and the built-in tag used.
- **Types.** `Content-Type` comes from a fixed list of extensions and every
  response is `X-Content-Type-Options: nosniff`, so a file whose extension is
  not on the list (`src/static.ts`) arrives as `application/octet-stream`, a
  download.
- **No byte ranges** (`Accept-Ranges: none`; a `Range` header gets the whole
  file) and no compression. Put large media somewhere else.

## Client navigation

Off unless a page asks for it. Wrap what a navigation should replace in
`<Partial name="...">`, in the body and, if the title and meta tags should
follow, in `<head>`; put `data-fu-nav` on `<body>`; and, optionally, a build id
on `<html>`:

```tsx
<html lang="en" data-fu-build={BUILD}>
  <head>
    <meta charset="utf-8" />
    <Partial name="head">
      <title>{title}</title>
    </Partial>
    <FuHead />
  </head>
  <body data-fu-nav="on">
    <Nav />
    <main>
      <Partial name="content">{children}</Partial>
    </main>
    <FuScripts />
  </body>
</html>
```

A click on a link then fetches the destination with `?fu-partial=1` (and
`&__b=<build>` when the page has a build id), replaces each region of the page
on screen with the region of the same name from the answer, hydrates the
islands that arrived and unmounts the ones that left. Everything outside the
regions stays as it is: an island there keeps its state.

The boot module requests the navigation chunk only when `<body>` carries
`data-fu-nav` as the page loads, alongside the island chunks. A page without
the attribute requests nothing extra and behaves as before. The value `"off"`
loads the chunk and holds it back: the attribute is read again at every click,
on the nearest ancestor of the link that has it, so a script can switch a
document, or one part of it, on and off.

**Which clicks.** A plain left click on an `<a href>` to the same origin over
http(s), that nobody called `preventDefault` on. Left to the browser: a
modified click, `target` other than `_self`, `download`, `rel="external"`, a
link to a fragment of the page on screen, and every form. Forms are never
intercepted; a submit is a full load.

**The server's side.** The answer to a partial fetch is the ordinary page, in
full; `ctx.partial` is true for it, should a page want to skip work. Both
parameters are in `ctx.url`: a page that echoes `ctx.url.search` into a
canonical link or a form action should drop them. A middleware can refuse a
client from another deploy by answering with the `x-fu-reload` header:

```ts
import { BUILD_PARAM, BUILD_RELOAD_HEADER } from "@janit/fu";

app.use((ctx) => {
  const theirs = ctx.url.searchParams.get(BUILD_PARAM);
  if (!ctx.partial || !theirs || theirs === BUILD) return ctx.next();
  return new Response(null, { headers: { [BUILD_RELOAD_HEADER]: "1", "cache-control": "no-store" } });
});
```

**When it will not swap.** Anything unexpected ends in a full load of the
destination, which is always correct: the `x-fu-reload` header, an error
status, an answer that is not HTML, a `data-fu-build` that differs from the
page's own, a failed fetch. So does a redirect: the browser is sent to the URL
the redirect ended on (one extra request), not shown a page under the wrong
address. And so does any doubt about the regions: on either page a name used
twice, a region inside a region, a marker without its partner, or the two
pages not having the same set of names. A page on screen whose own regions are
unsound is not navigated on the client at all.

**Raw HTML is trusted.** Regions are delimited by comments
(`<!--fu:p:name-->`, `<!--/fu:p-->`). Text rendered through Preact cannot
contain one, but `dangerouslySetInnerHTML` can, and such a comment is
indistinguishable from fu's own. The integrity rules above turn most of that
into a full load; they are not a sanitiser.

**Scripts.** Executable scripts that arrive in a region are re-created and
run, in document order, as on a full load, every time the region is entered: a
script that registers a global listener registers it again. A classic external
script without `async` or `defer` holds back the ones after it until it has
loaded. Data scripts (`application/ld+json`, an import map) and `nomodule`
scripts are left alone. A script that must run once per document belongs
outside every `Partial`.

**Back and Forward.** fu remembers the URL of the page it last drew. A
`popstate` whose path or query differs from it fetches and swaps that page,
whoever made the history entry and whatever state it holds; one that differs
in the fragment only is the browser's. The app may use `history.pushState` and
`replaceState` freely: `replaceState` on the current entry is followed (the
page on screen is then known by its new URL, and coming back to it later draws
nothing), `pushState` is not, so an entry the app pushed under another path is
asked of the server when Forward reaches it, and has to be a route.

**Scroll.** `history.scrollRestoration` is left alone, so a reload keeps its
position as in any document. After a click the page is at the top, or at the
element the fragment names. For Back and Forward the position is restored
after the swap from the history entry, where fu keeps it under the key `fu` of
`history.state`, merged into whatever object the app keeps there (a state that
is not an object is left alone, and that entry gets no position).

**Events**, on `window`, with `detail: { from, to }`: `fu:nav-start` before
the fetch; `fu:nav` after the swap, once the islands that arrived are
hydrated; `fu:nav-error`, with `detail.error`, before every fallback to a full
load. The latest navigation wins, and one that was overtaken gets no closing
event of its own. Back to the page on screen while a fetch is pending ends
that navigation with a `fu:nav` whose `from` and `to` are the same.

The runtime's own entry points are `hydrateIslands(manifest, markers?)` in
`@janit/fu/client` and `installNav(manifest)` in `@janit/fu/nav`. The generated
boot module calls both; an app has no need to. `hydrateIslands` keeps no
record of what it hydrated, so an element must be passed to it once.

## In-process tests

```ts
import { appHandler } from "@janit/fu/testing";

const handler = await appHandler("/abs/path/to/app", {
  env: { API_URL: "http://api.test" }, // ctx.env; default {}
  assetStore: assetsFromDir("/abs/path/to/static"), // ctx.assets; default none
});
const res = await handler(new Request("http://x/about"));
// What a single request passes goes over those defaults, as celld's would:
await handler(new Request("http://x/"), { waitUntil: (p) => pending.push(p) });
```

The app's request handler, built from its source files and routed exactly as
the built server would. No bundler runs, so whatever runs the test loads the
sources (Deno as they are; Node strips types from `.ts` on its own and needs a
loader for `.tsx`), and islands render as plain components without their
`data-island` markers: a test that asserts markers or assets needs a real
build. The modules go through the runtime's module cache, so two handlers for
one app share its module-level state.

## What works

Routing (static, dynamic and wildcard, on the raw segments of the path),
middleware with typed shared state, page metadata, a root shell that may own
the whole document, async pages, status and headers per page, static files, SSR, island
hydration, signals, CSS and CSS Modules with `composes`, native CSS nesting and
`@layer`, opt-in client navigation, and HMR that preserves component state.

Editing an island hot-swaps its markup **without losing hook state**. Editing
CSS swaps the stylesheet in place. Editing a route rebuilds the server.

## Architecture

Two layers with a hard boundary. The core is bundler-agnostic — it consumes
only a route manifest and an asset list, both plain data:

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

The core's whole contract with a runtime is one function,
`(request, { env, waitUntil, assets }) => Promise<Response>`, and it never
learns whether celld or the runner called it.

Everything bundler-specific lives in the drivers (`src/build.ts`, `src/dev.ts`),
the glue they share (`src/driver.ts`: locating the runtime modules, scanning a
project, the generated modules, the rolldown option sets) and the rolldown
plugins (`src/plugins.ts`). The runner (`src/serve.ts`) knows srvx and nothing
of the bundler. The same core ran unchanged under a Vite driver during
prototyping, so swapping the build layer stays cheap.

Routing compares path segments, with no pattern engine: a route with no param
is matched by string equality against the decoded path, and a param route
whose segment count or first segment cannot fit is skipped before anything is
allocated. With 16 routes on Deno a static hit is ~55 ns, a dynamic one
~500 ns and a miss ~1500 ns (`URLPattern.exec`, which did this until 0.5.2,
cost ~1900 ns for the dynamic hit).

See [the design doc](docs/design.md) for
the full rationale and the undocumented traps this implementation encodes.

## Tests

```sh
deno task test
```

`deno test` over the whole workspace, no browser needed. What only a browser
can show (islands hydrating, hot swaps keeping state, stylesheets swapping) is
`deno task check:browser`, which drives headless Chromium through a build and
through the dev server while editing files under it. The framework suite is written against the
failure modes this framework actually hit, so each one guards a real regression:

| area | what it pins down |
|---|---|
| router | static beats dynamic beats wildcard, ties broken by the earliest literal segment, never by file order; wildcards span segments and match their own base path; an encoded slash never separates segments, against a param, a wildcard or a static segment; params decode per segment, but `%2F` and `%5C` stay encoded, so decoding never makes a separator, and `rawParams` are the URL's text; no param is a dot segment, written out or encoded; a malformed escape matches and is handed over as written; NUL never reaches a param; a non-ASCII static route matches its percent-encoded request; empty segments, a trailing slash and dot segments match as they did before the matcher was rewritten; matching is case-sensitive; a path of 8000 segments, valid or not, is matched in linear time |
| middleware | outer unwinds last and decorates inner short-circuits; `next()` twice rejects; throws propagate |
| render | head escaping; JSON-LD cannot close its own `<script>`; 404 vs 405, `Allow`, HEAD and OPTIONS; islands get a marker |
| errors | a 500 never leaks its message; error responses are uncacheable; a broken error page falls back; an owning shell gets none of fu's error defaults in its head |
| async | an async page, error page and shell are awaited, page first; a promise nobody can await fails the render, naming the component |
| build | a missing file under `/_fu/` is `no-store` while a real one stays immutable; a page preloads exactly the chunks its islands import statically; the Worker is one file exporting only handlers, with no `node:` import of fu's, and runs nothing of the app before `prepare` |
| assets | a store's file gets the app's headers, a 304 too; a miss or a write falls through; the store's immutable headers are copied; `/_fu/` exact hits only |
| serve | the runner hands the Worker the environment and `ASSETS`; a body reaches it; a `waitUntil` failure is logged, not fatal, and close waits for work in flight; a bad `PORT` is refused by name, an empty `HOST` is none |
| document | an owning shell is recognised behind comments and a doctype in any case, in linear time; a marker placed twice fails; the marker token never reaches a client |
| static | traversal, dotfiles and encoded separators are refused before any filesystem call; a matching etag beats a stale date; an app's own etag is the one compared; a response nobody reads holds no file open |
| navigation | which clicks are taken; unsound or mismatched regions mean a full load; the latest navigation wins at every await; history and scroll for clicks, Back and Forward; an app's `replaceState` is followed |
| plugins | `composes` keeps every class name; CSS output changes with content; the JSX transform never touches rolldown's runtime; the package self-alias |
| driver | the server entry imports only the optional files that exist; `worker.ts` exports are carried, `prepare` is called once and retried after a failure, and what celld cannot take is refused |
| dev | the HMR socket admits only the dev server's own pages, not another site or a rebound name; a patch is written and sent before it is reported delivered; a rebuild that does not load leaves the last one serving; SIGTERM and SIGINT end a real dev server with code 0 and free both ports |
| cli | flags without a command mean dev; a port is decimal and leaves room for the HMR socket; each flag is refused where it does not apply |

Two of these were found by writing the suite, not before it: `ctx.next()` called
twice resumed at the wrong depth, and a middleware throwing synchronously
escaped the chain entirely instead of rejecting.

## Known gaps

- HMR works only from the machine running `fu dev`. With `--host 0.0.0.0` the
  pages are reachable across the network, but the HMR client always dials
  `localhost`, and the socket admits only the dev server's own pages, which is
  what keeps a DNS-rebinding page from reading your source. A page opened from
  another machine renders and hydrates, but does not hot-swap.
- Nothing is compressed: not the HTML, not the client files (celld negotiates
  no encodings, so pre-compressed copies would be dead bytes). Put a
  compressing proxy in front.
- The dev server's memory grows with every save: each rebuild of the server is
  loaded as a new module, and a runtime never frees one it has loaded. Restart
  it in a long session.
- `fu dev` runs the Worker on Node, Deno or Bun, resolving packages as that
  runtime does; the build resolves them as a Worker would (`workerd`,
  `worker`). A package that differs between the two behaves as the build has
  it only in the build. `celld dev` over `.output` is the runtime-true check.
- The package exports more than the documented API. The supported surface is
  `App`, `HttpError`, `statusText`, `FuHead`, `FuScripts`, `Partial`, the
  navigation protocol constants (`PARTIAL_PARAM`, `BUILD_PARAM`,
  `BUILD_RELOAD_HEADER`, `NAV_ATTR`, `BUILD_ATTR`), the types `Handlers`,
  `Middleware`, `PageContext`, `ResponseOverride` and `ShellProps` (the props
  of `routes/_app.tsx`: `{ ctx, children }`), and the subpaths
  `Env`, `AssetStore` and `RequestExtra`, and the subpaths
  `@janit/fu/static` (`assets`, `assetsFromDir`, `staticFiles`),
  `@janit/fu/serve` (`serveWorker`) and `@janit/fu/testing` (`appHandler`).
  The rest (`createHandler`, `compose`, the router, the `./build`, `./dev`,
  `./render`, `./router`, `./plugins`, `./client`, `./nav` subpaths) is what
  the drivers and tests use, and may change in any release.
- Client navigation has been driven in Chromium only. It does not manage
  focus or announce a navigation to a screen reader, does not use view
  transitions, and remembers the scroll position of the window only, not of
  an inner scrolling element. It writes that position with
  `history.replaceState` each time scrolling settles; WebKit refuses more
  than 100 history writes in 30 seconds, shared with the app's own, and a
  refused write is dropped silently.
- `Partial` is also the name of TypeScript's `Partial<T>`. A file that imports
  the component and needs the type imports it under another name:
  `import { Partial as Region } from "@janit/fu"`.
- The dev server finds routes and islands once, at start. Editing one
  rebuilds, but a newly added file needs a restart.
- **Adding or removing a hook** in an island breaks hook order during HMR. It
  does not crash, but needs a manual refresh.
- An editor that truncates or renames a file on save can be read mid-save. The
  island then keeps its previous code (with a console warning) rather than
  crashing, and that save is lost: save again to apply it.
- Naming an anonymous `export default () => {}` island shifts source positions,
  so that one module's sourcemap is dropped rather than left wrong.
- `ctx.rawParams` is raw as far as the URL of the `Request` is: URL parsing
  has already resolved dot segments (encoded ones too), escaped what cannot
  stand in a path, and turned `\` into `/`. An escape that was sent is not
  changed, in spelling or in case.
- No sourcemaps in dev, no error overlay, no prerendering, no per-route CSS
  splitting.
- No per-directory `_middleware.ts`. Middleware is registered programmatically
  in `app.ts`; scope it with a path check. (Measured against a real app: nested
  middleware had zero uses across 43 middleware.)
- Deliberately absent: streaming SSR, nested layouts, wrappers for Durable
  Objects, KV, queues and cron (they are celld's, reached through `ctx.env`
  and `worker.ts`).

## Status

Alpha, and built on deliberately unstable ground: Preact 11 is days old, celld
is beta, and rolldown's `devMode` is marked *"not ready for public usage"*.
That instability is an accepted trade.

MIT.
