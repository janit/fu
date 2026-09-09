import { assertEquals } from "@std/assert";
import { HttpError, statusText, toRouteError } from "./errors.ts";

Deno.test("HttpError carries a status and a default message", () => {
  const e = new HttpError(403);
  assertEquals(e.status, 403);
  assertEquals(e.message, "Forbidden");
  assertEquals(new HttpError(403, "Not yours").message, "Not yours");
  assertEquals(e instanceof Error, true);
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
