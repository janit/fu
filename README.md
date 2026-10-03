# Fresh Urquell

A minimal islands framework: file-system routing, SSR and hydration on
Preact 11, built by [rolldown](https://rolldown.rs) and served by
[Nitro](https://nitro.build). Runs on **Deno, Node and Bun**.

No Vite, no Babel, no esbuild. The bundler, JSX transform and CSS engine are
all Rust.

```
core     ~670 lines   router + render + client + hmr runtime + app, errors, types
drivers  ~610 lines   build + dev + cli + shared driver glue + rolldown plugins
```
(code lines, comments and blanks excluded)

## What this is

Fresh Urquell is inspired by [Deno Fresh](https://usefresh.dev/), and aims to be
just a single pint of glue code — enough to form a functional, simple framework
on top of known good libraries, and no more. The interesting work already lives
in Preact, rolldown, Nitro and lightningcss; this only binds them together.

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
npm install        # once: installs the toolchain (rolldown, nitro, lightningcss)

deno task dev      # example app, dev server with HMR on localhost:1337
deno task build    # example app, production build


deno task test     # unit tests, no browser
deno task check    # format, lint, types (framework and both apps), tests
```

The CLI behind those tasks is `fu dev [root] [--port N] [--host H]` and
`fu build [root]`. The root defaults to the working directory and must contain
`routes/`. The dev server listens on `--port` (1337) and its HMR socket on the
port after it. It binds to `127.0.0.1` and answers only to loopback names
(`localhost`, `127.0.0.1`, any `*.localhost`), because it hands out source and
stack traces. `--host 0.0.0.0` opens it to the network, for a container or
another device; `--host <name>` binds and admits that one name. `fu --help` and
`fu --version` do what they say.

Then run the build on whichever runtime you like — one artifact, three runtimes:

```sh
node example/.output/server/index.mjs
bun  example/.output/server/index.mjs
deno run -A example/.output/server/index.mjs
```

The built server listens on `PORT`, 3000 if unset: `PORT=1337 node ...`.

That holds because `fu build` always uses Nitro's `node-server` preset, whichever
runtime runs the build. Set `NITRO_PRESET` to build for a specific platform
instead. The portable preset has a price on Deno, where it runs through the
`node:http` compatibility layer: `NITRO_PRESET=deno-server` cut the CPU cost of
a request that renders nothing (a JSON API, a middleware short-circuit) by
about 40%, and made no difference to a rendered page.

A build minifies the client, serves it from `/_fu/` under content-hashed names
with a year-long `immutable` cache, pre-compresses the files big enough to gain
from it (brotli, gzip, zstd) and
announces the shared chunks, and the chunks of the islands that page rendered,
as `modulepreload`, so a page's islands start loading in one round trip after
the HTML. The dev server serves plain names
from `/`.

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

Middleware runs **before** routing, so `ctx.params` is empty inside it — match
on `ctx.url.pathname`. That is what lets a middleware answer a request no route
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
const dev = Deno.env.get("FU_DEV") === "1"; // process.env.FU_DEV on Node and Bun
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
  (the plain-text fallback has no such tag). During a deploy a valid URL can
  404 for a few seconds, and a shared cache would pin that. The exception is a
  missing file under `/_fu/`: Nitro answers that itself, as JSON with no cache
  header, and it never reaches your middleware or error page.

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
with it and gets no boundary of its own. A class component works as an island,
but its state does not survive a hot swap the way hook state does. Islands
hydrate independently, so one that throws is reported in the console and the
rest of the page still works.

## What works

Routing (static, dynamic and wildcard, via the web-standard `URLPattern`),
middleware with typed shared state, page metadata, a root shell, SSR, island
hydration, signals, CSS and CSS Modules with `composes`, native CSS nesting and
`@layer`, and HMR that preserves component state.

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
  preload?: { href: string }[];
  islands?: Record<string, string>; // island file -> its chunk's URL
};
```

Everything bundler-specific lives in the drivers (`src/build.ts`, `src/dev.ts`),
the glue they share (`src/driver.ts`: locating the runtime modules, scanning a
project, the rolldown and nitro option sets) and the rolldown plugins
(`src/plugins.ts`). The same core ran unchanged under a Vite driver during
prototyping, so swapping the build layer stays cheap.

Routing is on `URLPattern`, but `exec` costs microseconds per route on Deno,
so it only runs when it can matter: a route with no pattern syntax is matched
by string equality against its canonical pathname, and a pattern whose
segment count cannot fit the path is skipped. A static hit is ~65 ns and a
dynamic one ~1.6 µs with 16 routes, down from 28 µs and 57 µs.

See [the design doc](docs/design.md) for
the full rationale and the fourteen undocumented traps this implementation encodes.

## Tests

```sh
deno task test
```

`deno test` over the whole workspace, no browser needed. The framework suite is written against the
failure modes this framework actually hit, so each one guards a real regression:

| area | what it pins down |
|---|---|
| router | static beats dynamic beats wildcard, ties broken by the earliest literal segment, never by file order; wildcards span segments and match their own base path; params decode, but an escaped `/`, NUL, backslash or dot segment never reaches one; a non-ASCII static route matches its percent-encoded request |
| middleware | outer unwinds last and decorates inner short-circuits; `next()` twice rejects; throws propagate |
| render | head escaping; JSON-LD cannot close its own `<script>`; 404 vs 405, `Allow`, HEAD and OPTIONS; islands get a marker |
| errors | a 500 never leaks its message; error responses are uncacheable; a broken error page falls back |
| plugins | `composes` keeps every class name; CSS output changes with content; the JSX transform never touches rolldown's runtime; the package self-alias |
| driver | the server entry imports only the optional files that exist; the H3Event unwrap |
| dev | the HMR socket admits only the dev server's own pages, not another site or a rebound name; a patch is written and sent before it is reported delivered |
| cli | flags without a command mean dev; a port is decimal and leaves room for the HMR socket; build refuses dev's flags |

Two of these were found by writing the suite, not before it: `ctx.next()` called
twice resumed at the wrong depth, and a middleware throwing synchronously
escaped the chain entirely instead of rejecting.

## Known gaps

- HMR works only from the machine running `fu dev`. With `--host 0.0.0.0` the
  pages are reachable across the network, but the HMR client always dials
  `localhost`, and the socket admits only the dev server's own pages, which is
  what keeps a DNS-rebinding page from reading your source. A page opened from
  another machine renders and hydrates, but does not hot-swap.
- HTML responses are not compressed (the built client files are). Put a
  compressing proxy in front, or compress in a middleware.
- The dev server's memory grows with every save, inside nitro and rolldown, by
  a megabyte or a few. Restart it in a long session.
- A stylesheet whose `import` was removed stays in the dev `/style.css` until
  the dev server restarts. A build has no such leftovers.
- A request under `/_fu/` with a method other than GET or HEAD is answered by
  the app, and Nitro puts the assets' year-long cache header on that 404 or
  405. No cache stores a response to such a method, so it is left alone.
- The package exports more than the documented API. `App`, `HttpError`,
  `statusText` and the types `Handlers`, `Middleware`, `PageContext` and
  `ShellProps` (the props of `routes/_app.tsx`: `{ ctx, children }`) are the
  supported surface. The rest (`createHandler`, `compose`, the router, the
  `./build`, `./dev`, `./render`, `./router`, `./plugins` subpaths) is what the
  drivers and tests use, and may change in any release.
- The dev server finds routes and islands once, at start. Editing one
  rebuilds, but a newly added file needs a restart.
- **Adding or removing a hook** in an island breaks hook order during HMR. It
  does not crash, but needs a manual refresh.
- An editor that truncates or renames a file on save can be read mid-save. The
  island then keeps its previous code (with a console warning) rather than
  crashing, and that save is lost: save again to apply it.
- Naming an anonymous `export default () => {}` island shifts source positions,
  so that one module's sourcemap is dropped rather than left wrong.
- `urlpattern-polyfill` is bundled even on Deno and Bun, which have
  `URLPattern` natively — ~24 kB of dead weight there (never executed).
- No sourcemaps in dev, no error overlay, no prerendering, no per-route CSS
  splitting.
- No per-directory `_middleware.ts`. Middleware is registered programmatically
  in `app.ts`; scope it with a path check. (Measured against a real app: nested
  middleware had zero uses across 43 middleware.)
- Deliberately absent: partials, streaming SSR, nested layouts.

## Status

Alpha, and built on deliberately unstable ground: Preact 11 is days old, Nitro
3 is beta, and rolldown's `devMode` is marked *"not ready for public usage"*.
That instability is an accepted trade.

MIT.
