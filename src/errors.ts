import type { RouteError } from "./types.ts";

/**
 * Throw from a handler or middleware to produce a specific status.
 *
 * ```ts
 * if (!session) throw new HttpError(403, "Not your todo");
 * ```
 *
 * In middleware, prefer returning the response: a throw there unwinds past the
 * middleware that would have set headers on it.
 */
export class HttpError extends Error {
  readonly status: number;
  /** Sent on the error response, e.g. `Allow`, `Retry-After`, `WWW-Authenticate`. */
  readonly headers?: Headers;

  constructor(status: number, message?: string, init?: { headers?: HeadersInit }) {
    super(message ?? statusText(status));
    this.name = "HttpError";
    this.status = status;
    if (init?.headers) this.headers = new Headers(init.headers);
  }
}

const TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export function statusText(status: number): string {
  return TEXT[status] ?? (status >= 500 ? "Internal Server Error" : "Error");
}

/**
 * Normalise anything thrown into a status and a message.
 *
 * A `status` property is honoured wherever it appears, so errors from other
 * libraries (h3, fetch wrappers) map sensibly instead of collapsing to 500.
 * Their message is only carried through below 500: a foreign 5xx can say
 * anything — node:sqlite names the database path, a driver quotes the SQL —
 * and `message` is the one field the error page renders.
 */
export function toRouteError(err: unknown): RouteError {
  if (err instanceof HttpError) {
    return err.headers
      ? { status: err.status, message: err.message, headers: err.headers, cause: err }
      : { status: err.status, message: err.message, cause: err };
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status <= 599) {
    const message = (err as { message?: unknown }).message;
    const safe = status < 500 && typeof message === "string" && message
      ? message
      : statusText(status);
    return { status, message: safe, cause: err };
  }
  return { status: 500, message: statusText(500), cause: err };
}
