import type { RouteError } from "./types.ts";

/**
 * Throw from a handler or middleware to produce a specific status.
 *
 * ```ts
 * if (!session) throw new HttpError(403, "Not your todo");
 * ```
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? statusText(status));
    this.name = "HttpError";
    this.status = status;
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
 */
export function toRouteError(err: unknown): RouteError {
  if (err instanceof HttpError) {
    return { status: err.status, message: err.message, cause: err };
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status <= 599) {
    const message = (err as { message?: unknown }).message;
    return {
      status,
      message: typeof message === "string" && message ? message : statusText(status),
      cause: err,
    };
  }
  return { status: 500, message: statusText(500), cause: err };
}
