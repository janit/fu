import type { Ctx, Middleware } from "./types.ts";

/**
 * Composes a middleware chain around a terminal handler.
 *
 * The chain is an onion: the first middleware registered is outermost, so it
 * runs first on the way in and unwinds last on the way out — which is what lets
 * it overwrite headers any inner middleware set. A middleware that returns
 * without calling `ctx.next()` short-circuits everything beneath it.
 *
 * `ctx.state` and `ctx.head` are shared by reference across the whole chain, so
 * mutations are visible both further in and further out. Each level otherwise
 * gets its own shallow copy, which is what makes `next` per-level.
 */
function settle(fn: () => Response | Promise<Response>): Promise<Response> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

export function compose<S>(
  middleware: readonly Middleware<S>[],
  terminal: (ctx: Ctx<S>) => Response | Promise<Response>,
): (ctx: Ctx<S>) => Promise<Response> {
  return (root: Ctx<S>): Promise<Response> => {
    const dispatch = (i: number, prev: Ctx<S>): Promise<Response> => {
      const mw = middleware[i];
      // A middleware or handler that throws SYNCHRONOUSLY would otherwise
      // escape the composed function entirely rather than rejecting, and no
      // downstream .catch would ever see it.
      if (!mw) return settle(() => terminal(prev));

      // Each level gets its own ctx so that `next` is bound to THAT level.
      // A single shared object cannot work: the inner dispatch would overwrite
      // `ctx.next`, and an outer middleware calling it a second time would
      // silently resume at the wrong depth instead of failing.
      let called = false;
      const ctx: Ctx<S> = {
        ...prev,
        next: () => {
          if (called) {
            return Promise.reject(
              new Error("fu: ctx.next() called more than once in one middleware"),
            );
          }
          called = true;
          return dispatch(i + 1, ctx);
        },
      };
      return settle(() => mw(ctx));
    };
    return dispatch(0, root);
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

  /** Wrap a terminal handler in this app's chain. */
  compose(
    terminal: (ctx: Ctx<S>) => Response | Promise<Response>,
  ): (ctx: Ctx<S>) => Promise<Response> {
    return compose(this.#middleware, terminal);
  }
}
