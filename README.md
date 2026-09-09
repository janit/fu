# Fresh Urquell

A minimal islands framework: file-system routing, SSR and hydration on
Preact 11, built by [rolldown](https://rolldown.rs) and served by
[Nitro](https://nitro.build). Runs on **Deno, Node and Bun**.

No Vite, no Babel, no esbuild. The bundler, JSX transform and CSS engine are
all Rust.

```
core     ~300 lines   router + render + client + hmr runtime
drivers  ~400 lines   build + dev + shared rolldown plugins
```

## What this is

Fresh Urquell is inspired by [Deno Fresh](https://usefresh.dev/), and aims to be
just a single pint of glue code — enough to form a functional, simple framework
on top of known good libraries, and no more. The interesting work already lives
in Preact, rolldown, Nitro and lightningcss; this only binds them together.

It is experimental and primarily just for myself. Use it accordingly.

## Installing it

```sh
deno add npm:@janit/fu        # or: npm i @janit/fu
```

Install from **npm**, not JSR. The framework hands its own runtime modules to
rolldown, and a bundler cannot resolve a remote module — Deno keeps JSR packages
as `https:` URLs, so `jsr:@janit/fu` builds nothing. npm gives a real directory
on disk. (The JSR copy exists for reading the API and for runtime-only use.)

The npm package ships compiled JavaScript, because Deno refuses to type-strip
TypeScript inside `node_modules`.

## Quick start

```sh
npm install        # once: installs the toolchain (rolldown, nitro, lightningcss)

deno task dev      # example app, dev server with HMR on 0.0.0.0:1337
deno task build    # example app, production build

deno task todo:dev     # the fu-todo example app
deno task todo:build
deno task todo:start   # serve its build on :1337

deno task test     # 41 unit tests
deno task check    # types + tests + jsr publish dry-run
deno task check:pkg  # build and serve a real app from the packed npm artefact
```

Both example apps build against **this checkout's `src/`**, never a published
package, so the framework and the apps can be changed and tested together
before anything is released. `npm install` at the root is the only setup step;
it serves the whole repo.

Then run the build on whichever runtime you like — one artifact, three runtimes:

```sh
node example/.output/server/index.mjs
bun  example/.output/server/index.mjs
deno run -A example/.output/server/index.mjs
```

## Project shape

```
app.ts                            middleware chain (optional)
state.ts                          your State type
middleware/*.ts                   one concern per file
routes/_app.tsx                   shell wrapping every page (optional)
routes/index.tsx              ->  /
routes/about.tsx              ->  /about
routes/blog/[slug].tsx        ->  /blog/:slug
routes/files/[...rest].tsx    ->  /files/:rest*
islands/Counter.tsx               interactive, hydrated on the client
islands/counter.module.css        CSS Modules, scoped
```

Files under `routes/` starting with `_` are framework files, not routes.

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
it lands on `ctx.data`.

## Middleware

`app.ts` composes an ordered chain. Registration order is outermost first, so
the first registered runs first on the way in and **unwinds last** — it has the
final say on headers, including on short-circuit responses from further in.

```ts
import { App } from "@janit/fu";

const app = new App<State>();

app.use(async (ctx) => {                 // outermost: unwinds last
  const res = await ctx.next();
  res.headers.set("X-Frame-Options", "SAMEORIGIN");
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
propagates outward past any `await ctx.next()`.

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

## Errors

Anything thrown by a handler, a page or a middleware is turned into a response
rather than reaching the server as an unhandled crash. So are 404 and 405.

```ts
import { HttpError } from "@janit/fu";

export const handlers = {
  GET(ctx) {
    if (!ctx.state.session) throw new HttpError(403, "Not yours");
    ...
  },
};
```

An optional `routes/_error.tsx` renders them, receiving `ctx` like any page with
`ctx.error` set to `{ status, message }`. It is wrapped by `routes/_app.tsx`, so
error pages inherit the app's markup. Without one you get plain text.

Two things the framework does for you:

- **A 500 never renders its underlying message.** `ctx.error.message` is generic
  for 5xx; the real error goes to `ctx.error.cause` and is logged, because a
  thrown error's message routinely carries connection strings and file paths.
  A `4xx` keeps whatever message you gave it.
- **No failure is cacheable.** Error responses carry `no-store` and `noindex`.
  During a deploy a valid URL can 404 for a few seconds, and a shared cache
  would pin that.

Errors are caught at the route boundary and returned *through* the middleware
chain, so security headers and logging middleware still see them.

## Page metadata

`ctx.head` is the channel from a route to the document `<head>`. Middleware can
write to it too.

```ts
export const handlers = {
  GET: (ctx: PageContext<State>) => {
    ctx.head.title = `${ctx.params.slug} — Fresh Urquell`;
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
type Assets = { js: { href: string }[]; css: { href: string }[] };
```

Everything bundler-specific lives in the drivers (`src/build.ts`, `src/dev.ts`)
and the shared plugins (`src/plugins.ts`). The same core ran unchanged under a
Vite driver during prototyping, so swapping the build layer stays cheap.

See [the design doc](docs/design.md) for
the full rationale and the nine undocumented traps this implementation encodes.

## Tests

```sh
deno task test
```

`deno test` over `src/`, no browser needed. The suite is written against the
failure modes this framework actually hit, so each one guards a real regression:

| area | what it pins down |
|---|---|
| router | static beats dynamic beats wildcard; wildcards span segments; params decode |
| middleware | outer unwinds last and decorates inner short-circuits; `next()` twice rejects; throws propagate |
| render | head escaping; JSON-LD cannot close its own `<script>`; 404 vs 405; islands get a marker |
| errors | a 500 never leaks its message; error responses are uncacheable; a broken error page falls back |
| plugins | `composes` keeps every class name; CSS output changes with content; the JSX transform never touches rolldown's runtime; the H3Event unwrap |

Two of these were found by writing the suite, not before it: `ctx.next()` called
twice resumed at the wrong depth, and a middleware throwing synchronously
escaped the chain entirely instead of rejecting.

## Publishing

Two public repos ship from this private one, each as a squashed snapshot so no
private history leaks:

```sh
./scripts/publish.sh      --dry-run --tag v0.0.1 "First public release"  # -> janit/fu
./scripts/publish-todo.sh --dry-run --tag v0.0.1 "First public release"  # -> janit/fu-todo
```

`scripts/publish-lib.sh` holds the mechanics: a baseline exclude list that is
the privacy boundary, a staged-tree backstop that refuses the push if anything
private reaches the index anyway, semver tagging derived from the public repo's
existing tags, and version stamping so the git tag and `deno.json` cannot drift.
`fu-todo/` is stripped from `janit/fu`; the framework specifier is rewritten
from `../src/mod.ts` on the way into `janit/fu-todo`.

## Known gaps

- **Adding or removing a hook** in an island breaks hook order during HMR. It
  does not crash, but needs a manual refresh.
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

Alpha, and built on deliberately unstable ground: Preact 11 is a release
candidate, Nitro 3 is beta, and rolldown's `devMode` is marked *"not ready for
public usage"*. That instability is an accepted trade.

MIT.
