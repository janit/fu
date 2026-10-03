import { assertEquals, assertThrows } from "@std/assert";
import { HttpError, statusText, toRouteError } from "./errors.ts";

Deno.test("HttpError carries a status and a default message", () => {
  const e = new HttpError(403);
  assertEquals(e.status, 403);
  assertEquals(e.message, "Forbidden");
  assertEquals(new HttpError(403, "Not yours").message, "Not yours");
  assertEquals(e instanceof Error, true);
});

Deno.test("HttpError can carry response headers through to the error", () => {
  const e = new HttpError(429, undefined, { headers: { "retry-after": "30" } });
  assertEquals(e.headers?.get("retry-after"), "30");
  assertEquals(toRouteError(e).headers?.get("retry-after"), "30");
  assertEquals(new HttpError(404).headers, undefined);
});

Deno.test("statusText falls back sensibly for unknown codes", () => {
  assertEquals(statusText(404), "Not Found");
  assertEquals(statusText(599), "Internal Server Error");
  assertEquals(statusText(418), "Error");
});

Deno.test("toRouteError honours a status wherever it comes from", () => {
  assertEquals(toRouteError(new HttpError(404)).status, 404);
  // Errors from other libraries (h3, fetch wrappers) map instead of collapsing.
  assertEquals(toRouteError({ status: 403, message: "nope" }), {
    status: 403,
    message: "nope",
    cause: { status: 403, message: "nope" },
  });
  assertEquals(toRouteError({ status: 401 }).message, "Unauthorized");
});

Deno.test("an ordinary throw becomes a 500 whose message is generic", () => {
  const e = toRouteError(new Error("connection string leaked here"));
  assertEquals(e.status, 500);
  // The real message must not reach the client; it is kept on `cause` to log.
  assertEquals(e.message, "Internal Server Error");
  assertEquals((e.cause as Error).message, "connection string leaked here");
});

Deno.test("a nonsense status is not treated as a status", () => {
  assertEquals(toRouteError({ status: 200 }).status, 500);
  assertEquals(toRouteError({ status: "403" }).status, 500);
  assertEquals(toRouteError(null).status, 500);
});

Deno.test("a foreign 5xx error's message is not reflected either", () => {
  // The contract in types.ts is that `message` is safe to render. An error from
  // another library can carry both a status AND a message full of detail —
  // node:sqlite puts the database path in one — so 5xx is generic regardless of
  // where the error came from.
  const raw = { status: 500, message: "SQLITE_CANTOPEN: unable to open /data/todos.db" };
  const e = toRouteError(raw);
  assertEquals(e.status, 500);
  assertEquals(e.message, "Internal Server Error");
  assertEquals(e.cause, raw);
  assertEquals(
    toRouteError({ status: 503, message: "upstream pg://user:pw@host" }).message,
    "Service Unavailable",
  );
  // Below 500 the message is developer-facing and still rendered.
  assertEquals(toRouteError({ status: 403, message: "Not your todo" }).message, "Not your todo");
});

Deno.test("an HttpError over 500 keeps its own message, because the app wrote it", () => {
  // HttpError is constructed by the app itself, so its message is trusted; the
  // rule only guards messages that arrived from somewhere else.
  assertEquals(toRouteError(new HttpError(500, "custom")).message, "custom");
});

Deno.test("HttpError refuses a status that is not an error", () => {
  // 204 and 304 cannot carry the body the renderer attaches, and the failure
  // surfaced as an unrelated RangeError from the Response constructor.
  for (const status of [99, 200, 204, 304, 600, 404.5, NaN]) {
    assertThrows(() => new HttpError(status), RangeError, "400");
  }
  assertEquals(new HttpError(400).status, 400);
  assertEquals(new HttpError(599).status, 599);
});

Deno.test("the message boundary sits exactly between 499 and 500", () => {
  const foreign = (status: number) => toRouteError({ status, message: "db at /var/secret" });
  assertEquals(foreign(499).message, "db at /var/secret");
  assertEquals(foreign(500).message, "Internal Server Error");
  // And the status boundary of HttpError itself.
  assertThrows(() => new HttpError(399), RangeError);
  assertThrows(() => new HttpError(600), RangeError);
});
