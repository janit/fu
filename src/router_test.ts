import { assertEquals } from "@std/assert";
import { buildRoutes, filePathToPattern, match } from "./router.ts";
import type { RouteManifest } from "./types.ts";

const mod = () => Promise.resolve({});

Deno.test("filePathToPattern maps the routing conventions", () => {
  assertEquals(filePathToPattern("/routes/index.tsx"), "/");
  assertEquals(filePathToPattern("/routes/about.tsx"), "/about");
  assertEquals(filePathToPattern("/routes/blog/index.tsx"), "/blog");
  assertEquals(filePathToPattern("/routes/blog/[slug].tsx"), "/blog/:slug");
  assertEquals(filePathToPattern("/routes/files/[...rest].tsx"), "/files/:rest*");
  assertEquals(filePathToPattern("/routes/a/[b]/c/[d].tsx"), "/a/:b/c/:d");
  assertEquals(filePathToPattern("/routes/api/todos/index.ts"), "/api/todos");
});

Deno.test("routes sort static before dynamic before wildcard", () => {
  const manifest: RouteManifest = {
    "/routes/files/[...rest].tsx": mod,
    "/routes/[slug].tsx": mod,
    "/routes/about.tsx": mod,
  };
  assertEquals(buildRoutes(manifest).map((r) => r.pattern), [
    "/about",
    "/:slug",
    "/files/:rest*",
  ]);
});

Deno.test("a static route wins over a dynamic one that also matches", () => {
  const routes = buildRoutes({ "/routes/[slug].tsx": mod, "/routes/about.tsx": mod });
  assertEquals(match(routes, "/about")?.route.pattern, "/about");
  assertEquals(match(routes, "/anything-else")?.route.pattern, "/:slug");
});

Deno.test("match extracts params, spans segments for wildcards, and decodes", () => {
  const routes = buildRoutes({
    "/routes/blog/[slug].tsx": mod,
    "/routes/files/[...rest].tsx": mod,
    "/routes/index.tsx": mod,
  });
  assertEquals(match(routes, "/")?.route.pattern, "/");
  assertEquals(match(routes, "/blog/hello-world")?.params, { slug: "hello-world" });
  assertEquals(match(routes, "/files/a/b/c.txt")?.params, { rest: "a/b/c.txt" });
  assertEquals(match(routes, "/blog/hello%20world")?.params, { slug: "hello world" });
});

Deno.test("no route returns null rather than throwing", () => {
  assertEquals(match(buildRoutes({ "/routes/index.tsx": mod }), "/nope"), null);
});

Deno.test("a dynamic segment does not swallow extra path segments", () => {
  const routes = buildRoutes({ "/routes/blog/[slug].tsx": mod });
  assertEquals(match(routes, "/blog/a/b"), null);
});
