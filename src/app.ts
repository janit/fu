import type { Ctx, Middleware } from "./types.ts";

/**
 * Composes a middleware chain around a terminal handler.
 *
 * The chain is an onion: the first middleware registered is outermost, so it
 * runs first on the way in and unwinds last on the way out — which is what lets
 * it overwrite headers any inner middleware set. A middleware that returns
 * without calling `ctx.next()` short-circuits everything beneath it.
 *
 * One ctx is shared by the whole chain: every level reads and writes the same
 * fields, so what the router writes (`params`, `data`, `error`) is visible to
 * every middleware on the way out, however deep the chain. Only `next` is
 * per-level.
 */
function settle(fn: () => Response | Promise<Response>): Promise<Response> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

/** A middleware that forgets `return` would otherwise hand the server `undefined`. */
function mustBeResponse(res: unknown): Response {
  if (res instanceof Response) return res;
  throw new Error(`fu: a middleware resolved to ${typeof res}, not a Response (missing return?)`);
}

const ROOT = Symbol("fu.root");
const FIELDS = ["req", "url", "params", "state", "head", "data", "error"] as const;

/**
 * Prototype for the per-level view: each field forwards to the root ctx. Built
 * once, so a level costs one small object rather than a copy of every field.
 */
const levelProto: object = Object.create(
  null,
  Object.fromEntries(FIELDS.map((k) => [k, {
    get(this: { [ROOT]: Record<string, unknown> }) {
      return this[ROOT][k];
    },
    set(this: { [ROOT]: Record<string, unknown> }, v: unknown) {
      this[ROOT][k] = v;
    },
    enumerable: true,
  }])),
);

export function compose<S>(
  middleware: readonly Middleware<S>[],
  terminal: (ctx: Ctx<S>) => Response | Promise<Response>,
): (ctx: Ctx<S>) => Promise<Response> {
  return (root: Ctx<S>): Promise<Response> => {
    const dispatch = (i: number): Promise<Response> => {
      const mw = middleware[i];
      // A middleware or handler that throws SYNCHRONOUSLY would otherwise
      // escape the composed function entirely rather than rejecting, and no
      // downstream .catch would ever see it.
      if (!mw) return settle(() => terminal(root));

      // Each level gets its own view so that `next` is bound to THAT level.
      // A single shared object cannot work: the inner dispatch would overwrite
      // `ctx.next`, and an outer middleware calling it a second time would
      // silently resume at the wrong depth instead of failing.
      let called = false;
      const ctx = Object.create(levelProto) as Ctx<S> & { [ROOT]: Ctx<S> };
      ctx[ROOT] = root;
      ctx.next = () => {
        if (called) {
          return Promise.reject(
            new Error("fu: ctx.next() called more than once in one middleware"),
          );
        }
        called = true;
        return dispatch(i + 1);
      };
      return settle(() => mw(ctx)).then(mustBeResponse);
    };
    return dispatch(0);
  };
}

/**
 * The application: an ordered middleware chain.
 *
 * ```ts
 * const app = new App<State>();
 * app.use(securityHeaders);
 * app.use(resolveTenant);
 * export default app;
 * ```
 *
 * Middleware runs before routing, so `ctx.params` is empty inside it — match on
 * `ctx.url.pathname` instead. That is deliberate: it lets a middleware answer a
 * request (a redirect, `/healthz`, `/robots.txt`) without a route existing.
 */
export class App<S = Record<string, unknown>> {
  readonly #middleware: Middleware<S>[] = [];

  /** Register a middleware. Returns `this` so calls can chain. */
  use(middleware: Middleware<S>): this {
    this.#middleware.push(middleware);
    return this;
  }

  /** The registered chain, in registration order. */
  get middleware(): readonly Middleware<S>[] {
    return this.#middleware;
  }
}
