/**
 * Fresh Urquell — a minimal islands framework on Preact, rolldown and Nitro.
 *
 * This entrypoint is the bundler-agnostic core: it needs only a route manifest
 * and an asset list, both plain data. Drivers live in `./build.ts` and
 * `./dev.ts`.
 */
export { App, compose } from "./app.ts";
export { HttpError, statusText, toRouteError } from "./errors.ts";
export { createHandler, document, renderError } from "./render.ts";
export type { HandlerParts, ShellProps } from "./render.ts";
export { buildRoutes, filePathToPattern, match } from "./router.ts";
export type { Matched, Route } from "./router.ts";
export type {
  Asset,
  Assets,
  Ctx,
  FuOptions,
  Head,
  Middleware,
  PageContext,
  RouteError,
  RouteHandler,
  RouteManifest,
  RouteModule,
} from "./types.ts";
