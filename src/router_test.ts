import { assertEquals, assertThrows } from "@std/assert";
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

Deno.test("overlapping routes of the same kind resolve the same whatever the file order", () => {
  const files = ["/routes/[lang]/about.tsx", "/routes/blog/[slug].tsx", "/routes/[a]/[b].tsx"];
  for (const order of [files, [...files].reverse()]) {
    const routes = buildRoutes(Object.fromEntries(order.map((f) => [f, mod])));
    // The earliest literal segment decides.
    assertEquals(match(routes, "/blog/about")?.route.pattern, "/blog/:slug");
    assertEquals(match(routes, "/en/about")?.route.pattern, "/:lang/about");
    assertEquals(match(routes, "/en/other")?.route.pattern, "/:a/:b");
  }
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

Deno.test("a static route with non-ASCII characters matches its encoded request path", () => {
  // Literal routes are matched by string equality against the pattern's
  // canonical pathname, which is what a URL's pathname carries.
  const routes = buildRoutes({ "/routes/über.tsx": mod, "/routes/[slug].tsx": mod });
  assertEquals(match(routes, "/%C3%BCber")?.route.pattern, "/über");
});

Deno.test("a wildcard also matches its own base path", () => {
  const routes = buildRoutes({ "/routes/files/[...rest].tsx": mod });
  assertEquals(match(routes, "/files")?.route.pattern, "/files/:rest*");
  assertEquals(match(routes, "/file"), null);
});

Deno.test("an escaped separator stays escaped in a param; NUL is no match", () => {
  // Decoding never makes a separator, so no param can be read as a path
  // that climbs: `..%2F..` is one segment of text, not three.
  const routes = buildRoutes({ "/routes/blog/[slug].tsx": mod });
  assertEquals(match(routes, "/blog/..%2F..%2Fetc%2Fpasswd")?.params, {
    slug: "..%2F..%2Fetc%2Fpasswd",
  });
  assertEquals(match(routes, "/blog/a%2Fb")?.params, { slug: "a%2Fb" });
  assertEquals(match(routes, "/blog/..%5C..%5Cwin.ini")?.params, { slug: "..%5C..%5Cwin.ini" });
  assertEquals(match(routes, "/blog/a%00b"), null);
});

Deno.test("a wildcard holds as many slashes as the path had separators", () => {
  const routes = buildRoutes({ "/routes/files/[...rest].tsx": mod });
  assertEquals(match(routes, "/files/a%2Fb")?.params, { rest: "a%2Fb" });
  assertEquals(match(routes, "/files/a/b%2Fc")?.params, { rest: "a/b%2Fc" });
  assertEquals(match(routes, "/files/..%2F..%2Fetc%2Fpasswd")?.params, {
    rest: "..%2F..%2Fetc%2Fpasswd",
  });
  // A dot segment, written out or encoded, is resolved and never handed over.
  assertEquals(match(routes, "/files/a/.%2E/b")?.params, { rest: "b" });
  assertEquals(match(routes, "/files/%2E%2E"), null);
  assertEquals(match(routes, "/files/a%00"), null);
});

Deno.test("a segment with an encoded slash goes to the param route, not past it", () => {
  const routes = buildRoutes({
    "/routes/blog/[slug].tsx": mod,
    "/routes/blog/[...rest].tsx": mod,
  });
  const m = match(routes, "/blog/a%2Fb");
  assertEquals(m?.route.pattern, "/blog/:slug");
  assertEquals(m?.params, { slug: "a%2Fb" });
});

Deno.test("a malformed escape matches and is handed over as written, not thrown", () => {
  const routes = buildRoutes({ "/routes/blog/[slug].tsx": mod });
  assertEquals(match(routes, "/blog/%E0%A4%A")?.params, { slug: "%E0%A4%A" });
  assertEquals(match(routes, "/blog/%")?.params, { slug: "%" });
});

Deno.test("pattern syntax in a file name is a literal character, not a pattern", () => {
  // `a+b.tsx` used to fail URLPattern parsing and take the whole app down at
  // startup; `(admin)` became a regex group that matched `/admin/x`.
  const routes = buildRoutes({
    "/routes/a+b.tsx": mod,
    "/routes/(admin)/x.tsx": mod,
    "/routes/what?.tsx": mod,
    "/routes/[slug].tsx": mod,
  });
  assertEquals(match(routes, "/a+b")?.route.pattern, "/a\\+b");
  assertEquals(match(routes, "/(admin)/x")?.params, {});
  assertEquals(match(routes, "/admin/x"), null);
  assertEquals(match(routes, "/what%3F")?.params, {});
  assertEquals(match(routes, "/aab")?.params, { slug: "aab" });
  // However the request escapes it, the file name is the text compared.
  assertEquals(match(routes, "/a%2Bb")?.route.pattern, "/a\\+b");
  const percent = buildRoutes({ "/routes/100%.tsx": mod });
  assertEquals(match(percent, "/100%25")?.route.file, "/routes/100%.tsx");
  assertEquals(match(percent, "/100%")?.route.file, "/routes/100%.tsx");
});

Deno.test("a param name URLPattern would misread is refused, naming the file", () => {
  // `[my-id]` became `:my-id`: a param `my` followed by a literal `-id`.
  assertThrows(() => buildRoutes({ "/routes/[my-id].tsx": mod }), Error, "/routes/[my-id].tsx");
  assertThrows(() => buildRoutes({ "/routes/[...].tsx": mod }), Error, "param name");
});

Deno.test("two files that answer the same path are refused", () => {
  assertThrows(
    () => buildRoutes({ "/routes/blog.tsx": mod, "/routes/blog/index.tsx": mod }),
    Error,
    "/routes/blog/index.tsx",
  );
  assertThrows(
    () => buildRoutes({ "/routes/[x].tsx": mod, "/routes/[y].tsx": mod }),
    Error,
    "both",
  );
});

Deno.test("a needlessly escaped path still reaches its literal route", () => {
  const routes = buildRoutes({
    "/routes/about.tsx": mod,
    "/routes/café.tsx": mod,
    "/routes/[x].tsx": mod,
  });
  assertEquals(match(routes, "/%61bout")?.route.pattern, "/about");
  assertEquals(match(routes, "/caf%c3%a9")?.route.pattern, "/café");
});

// ---- 0.5.3: matching on raw segments, params decoded per segment, rawParams ----

const table = () =>
  buildRoutes({
    "/routes/index.tsx": mod,
    "/routes/about.tsx": mod,
    ["/routes" + CAFE + ".tsx"]: mod,
    "/routes/s/[code].tsx": mod,
    "/routes/[a]/[b].tsx": mod,
    "/routes/files/[...rest].tsx": mod,
    "/routes/[...slug].tsx": mod,
  });

type P = Record<string, string>;
/** path, the pattern that answers (null: none), params, rawParams when they differ. */
type Row = [path: string, pattern: string | null, params?: P, rawParams?: P];

const CAFE = "/caf" + String.fromCharCode(0xe9);
const TOKYO = String.fromCharCode(0x6771, 0x4eac);

const ROWS: Record<string, Row[]> = {
  "plain static, param and wildcard": [
    ["/", "/", {}],
    ["/about", "/about", {}],
    ["/s/abc", "/s/:code", { code: "abc" }],
    ["/dublin/cork", "/:a/:b", { a: "dublin", b: "cork" }],
    ["/files/a/b/c.txt", "/files/:rest*", { rest: "a/b/c.txt" }],
    ["/files", "/files/:rest*", {}],
  ],
  "static beats param beats catch-all for the same raw path": [
    ["/about", "/about", {}],
    ["/s/x", "/s/:code", { code: "x" }],
    ["/x/y", "/:a/:b", { a: "x", b: "y" }],
    ["/x", "/:slug*", { slug: "x" }],
    ["/x/y/z", "/:slug*", { slug: "x/y/z" }],
    ["/s/x/y", "/:slug*", { slug: "s/x/y" }],
  ],
  "an encoded slash is never a separator": [
    // In params too it stays as written, in its own case: decoding makes no separator.
    ["/s/abc%2Fdef", "/s/:code", { code: "abc%2Fdef" }],
    ["/s/abc%2fdef", "/s/:code", { code: "abc%2fdef" }],
    // One segment, so not the two-segment route.
    ["/dublin%2Fcork", "/:slug*", { slug: "dublin%2Fcork" }],
    ["/dublin%2Fcork/x", "/:a/:b", { a: "dublin%2Fcork", b: "x" }],
    // A wildcard has one `/` per real separator.
    ["/files/a%2Fb/c", "/files/:rest*", { rest: "a%2Fb/c" }],
    ["/files/a%20b%2Fc/d%2fe", "/files/:rest*", { rest: "a b%2Fc/d%2fe" }, {
      rest: "a%20b%2Fc/d%2fe",
    }],
    // Against a static segment: neither `/about` nor `/s/[code]` nor `/files/...`.
    ["/about%2Fx", "/:slug*", { slug: "about%2Fx" }],
    ["/s%2Fabc", "/:slug*", { slug: "s%2Fabc" }],
    ["/files%2fa", "/:slug*", { slug: "files%2fa" }],
    ["/s/..%2F..%2Fetc", "/s/:code", { code: "..%2F..%2Fetc" }],
  ],
  "an encoded backslash stays encoded as well": [
    ["/s/a%5Cb", "/s/:code", { code: "a%5Cb" }],
    ["/s/a%5cb%20c", "/s/:code", { code: "a%5cb c" }, { code: "a%5cb%20c" }],
  ],
  "double encoding is decoded once": [
    // So `%2F` in params is what `%2F` and `%252F` both give; rawParams tells them apart.
    ["/s/abc%252Fdef", "/s/:code", { code: "abc%2Fdef" }, { code: "abc%252Fdef" }],
    ["/s/%252e%252e", "/s/:code", { code: "%2e%2e" }, { code: "%252e%252e" }],
  ],
  "encoded reserved characters and a literal plus": [
    [
      "/s/a%26b%3Fc%23d%2Be%3Df%25g%20h+i",
      "/s/:code",
      { code: "a&b?c#d+e=f%g h+i" },
      { code: "a%26b%3Fc%23d%2Be%3Df%25g%20h+i" },
    ],
  ],
  "non-ASCII text, and escapes that did not need to be": [
    ["/s/%E6%9D%B1%E4%BA%AC", "/s/:code", { code: TOKYO }, { code: "%E6%9D%B1%E4%BA%AC" }],
    ["/caf%C3%A9", CAFE, {}],
    ["/caf%c3%a9", CAFE, {}],
    ["/%61bout", "/about", {}],
    ["/%73/%61bc", "/s/:code", { code: "abc" }, { code: "%61bc" }],
  ],
  "a malformed escape is handed over as written": [
    ["/s/%", "/s/:code", { code: "%" }],
    ["/s/%E0%A4%A", "/s/:code", { code: "%E0%A4%A" }],
    ["/s/%zz", "/s/:code", { code: "%zz" }],
    // Decoded per segment: the sound one still is.
    [
      "/dublin%E0%A4%A/cork%20x",
      "/:a/:b",
      { a: "dublin%E0%A4%A", b: "cork x" },
      { a: "dublin%E0%A4%A", b: "cork%20x" },
    ],
    ["/%E0%A4%A", "/:slug*", { slug: "%E0%A4%A" }],
    ["/files/a%20b/%zz", "/files/:rest*", { rest: "a b/%zz" }, { rest: "a%20b/%zz" }],
    ["/about%", "/:slug*", { slug: "about%" }],
  ],
  "rawParams of a path with a dot segment are what is left of it": [
    ["/files/a/../b", "/files/:rest*", { rest: "b" }],
    ["/files/a/%2e%2e/b%20c", "/files/:rest*", { rest: "b c" }, { rest: "b%20c" }],
  ],
  "a segment that only looks like a dot segment is text": [
    ["/s/...", "/s/:code", { code: "..." }],
    ["/s/..a", "/s/:code", { code: "..a" }],
    ["/s/..%2Fx", "/s/:code", { code: "..%2Fx" }],
  ],
};

for (const [name, rows] of Object.entries(ROWS)) {
  Deno.test(`raw-segment matching: ${name}`, () => {
    const routes = table();
    for (const [path, pattern, params, rawParams] of rows) {
      const m = match(routes, path);
      assertEquals(m?.route.pattern ?? null, pattern, path);
      assertEquals(m?.params, params, path);
      assertEquals(m?.rawParams, rawParams ?? params, path);
    }
  });
}

// What 0.5.2 did with empty segments, a trailing slash, dot segments (written
// out or encoded: it made no difference), NUL and a backslash, to the letter:
// every row passes on the 0.5.2 matcher. A request never gets here with a dot
// segment or a backslash (URL parsing resolves them first); `match` called
// directly does.
Deno.test("empty segments, a trailing slash and dot segments match as they did in 0.5.2", () => {
  const routes = table();
  const rows: Row[] = [
    ["//", null],
    ["//about", null],
    ["/about/", null],
    ["/s/abc/", null],
    ["/dublin//cork", null],
    ["/files/", null],
    ["/files/a/", null],
    ["/files//a", null],
    // Only a wildcard route sees the path with its dot segments resolved.
    ["/./about", "/:slug*", { slug: "about" }],
    ["/x/../about", "/:slug*", { slug: "about" }],
    ["/dublin/./cork", "/:slug*", { slug: "dublin/cork" }],
    ["/files/a/../b", "/files/:rest*", { rest: "b" }],
    ["/files/a/./b", "/files/:rest*", { rest: "a/b" }],
    // Resolved to `/`, which a catch-all at the root does not answer.
    ["/files/..", null],
    ["/s/..", null],
    ["/..", null],
    ["/files/x/..", null],
    ["/files/a/.", null],
    ["/s/.", null],
    // An encoded dot segment is a dot segment: resolved, never handed to a param.
    ["/s/%2e%2e", null],
    ["/s/%2E", null],
    ["/s/.%2e", null],
    ["/files/%2e%2e", null],
    ["/files/a/%2e%2e", null],
    ["/files/a/%2e%2e/b", "/files/:rest*", { rest: "b" }],
    ["/files/a/%2e/b", "/files/:rest*", { rest: "a/b" }],
    ["/x/%2e%2e/about", "/:slug*", { slug: "about" }],
    ["/%2e%2e/about", "/:slug*", { slug: "about" }],
    // NUL is never a param. A backslash written out is a separator, as URL
    // parsing has it (a request's pathname never holds one).
    ["/s/a%00b", null],
    ["/s/a\\b", "/:slug*", { slug: "s/a/b" }],
    ["/files/a\\b", "/files/:rest*", { rest: "a/b" }],
  ];
  for (const [path, pattern, params] of rows) {
    const m = match(routes, path);
    assertEquals(m?.route.pattern ?? null, pattern, path);
    assertEquals(m?.params, params, path);
  }
  // With no wildcard route there is nothing a dot segment can reach.
  const plain = buildRoutes({ "/routes/about.tsx": mod, "/routes/blog/[slug].tsx": mod });
  for (
    const path of ["/x/../about", "/./about", "/blog/./x", "/blog/..", "/blog/x/.", "/blog/x/"]
  ) {
    assertEquals(match(plain, path), null, path);
  }
  // A wildcard answers its base path, but the base of a root catch-all is not `/`.
  assertEquals(match(buildRoutes({ "/routes/[...slug].tsx": mod }), "/"), null);
});

Deno.test("matching is case-sensitive, for a static route and for a static segment of any route", () => {
  const routes = buildRoutes({
    "/routes/about.tsx": mod,
    "/routes/Case.tsx": mod,
    "/routes/blog/[slug]/edit.tsx": mod,
    "/routes/files/[...rest]/raw.tsx": mod,
    "/routes/[...slug].tsx": mod,
  });
  // The whole path of a static route.
  assertEquals(match(routes, "/about")?.route.pattern, "/about");
  assertEquals(match(routes, "/About")?.route.pattern, "/:slug*");
  assertEquals(match(routes, "/%41bout")?.route.pattern, "/:slug*");
  assertEquals(match(routes, "/Case")?.route.pattern, "/Case");
  assertEquals(match(routes, "/case")?.route.pattern, "/:slug*");
  // A static segment first, in the middle, last, and after a wildcard.
  assertEquals(match(routes, "/blog/x/edit")?.route.pattern, "/blog/:slug/edit");
  assertEquals(match(routes, "/Blog/x/edit")?.route.pattern, "/:slug*");
  assertEquals(match(routes, "/blog/x/Edit")?.route.pattern, "/:slug*");
  assertEquals(match(routes, "/blog/x/%45dit")?.route.pattern, "/:slug*");
  assertEquals(match(routes, "/files/a/b/raw")?.route.pattern, "/files/:rest*/raw");
  assertEquals(match(routes, "/files/a/b/RAW")?.route.pattern, "/:slug*");
  assertEquals(match(routes, "/FILES/a/b/raw")?.route.pattern, "/:slug*");
  // With nothing to fall to, it is no match.
  const bare = buildRoutes({ "/routes/about.tsx": mod, "/routes/blog/[slug]/edit.tsx": mod });
  assertEquals(match(bare, "/ABOUT"), null);
  assertEquals(match(bare, "/blog/x/EDIT"), null);
});

Deno.test("a route's static text is its file name, compared with the decoded request segment", () => {
  // So a file name that itself holds an escape is reached by escaping its
  // percent sign: `100%25.tsx` is the text "100%25", which a request spells
  // `100%2525`. `/100%25` is the text "100%", the other file.
  const routes = buildRoutes({ "/routes/100%25.tsx": mod, "/routes/100%.tsx": mod });
  assertEquals(match(routes, "/100%2525")?.route.file, "/routes/100%25.tsx");
  assertEquals(match(routes, "/100%25")?.route.file, "/routes/100%.tsx");
  assertEquals(match(routes, "/100%")?.route.file, "/routes/100%.tsx");
  assertEquals(match(buildRoutes({ "/routes/100%25.tsx": mod }), "/100%25"), null);
});

Deno.test("a wildcard in the middle, and two of them, take what the pattern always gave them", () => {
  // The first wildcard is as long as the rest of the route allows.
  const routes = buildRoutes({
    "/routes/[...a]/x/[...b].tsx": mod,
    "/routes/w/[...a]/[b].tsx": mod,
    "/routes/v/[...a]/y/z/[...b]/end.tsx": mod,
    "/routes/u/[...a]/[...b].tsx": mod,
  });
  const got = (path: string) => {
    const m = match(routes, path);
    return m ? [m.route.pattern, m.params] : null;
  };
  assertEquals(got("/p/x/q"), ["/:a*/x/:b*", { a: "p", b: "q" }]);
  assertEquals(got("/p/x/q/x/r"), ["/:a*/x/:b*", { a: "p/x/q", b: "r" }]);
  assertEquals(got("/x/x/x"), ["/:a*/x/:b*", { a: "x/x" }]);
  assertEquals(got("/x"), ["/:a*/x/:b*", {}]);
  assertEquals(got("/p/q"), null);
  assertEquals(got("/w/a/b/c"), ["/w/:a*/:b", { a: "a/b", b: "c" }]);
  assertEquals(got("/w/c"), ["/w/:a*/:b", { b: "c" }]);
  assertEquals(got("/v/1/y/z/2/y/z/3/end"), ["/v/:a*/y/z/:b*/end", { a: "1/y/z/2", b: "3" }]);
  assertEquals(got("/v/y/z/end"), ["/v/:a*/y/z/:b*/end", {}]);
  assertEquals(got("/v/y/y/z/end"), ["/v/:a*/y/z/:b*/end", { a: "y" }]);
  assertEquals(got("/v/1/y/2/z/end"), null);
  assertEquals(got("/u/1/2/3"), ["/u/:a*/:b*", { a: "1/2/3" }]);
  assertEquals(got("/u"), ["/u/:a*/:b*", {}]);
});

Deno.test("a run between two wildcards never takes a segment the parts before the first one own", () => {
  // `/x` has one `x`, and the route needs two: the one before the first
  // wildcard cannot also be the one between the two.
  const routes = buildRoutes({ "/routes/x/[...a]/x/[...b].tsx": mod });
  assertEquals(match(routes, "/x"), null);
  assertEquals(match(routes, "/x/x")?.params, {});
  assertEquals(match(routes, "/x/p/x/q")?.params, { a: "p", b: "q" });
  assertEquals(match(routes, "/x/x/x")?.params, { a: "x" });
  assertEquals(match(routes, "/y/x"), null);
});

// ---- the cost of a match is linear in the length of the path ----
// The first matcher of 0.5.3 retried every length of a wildcard and rescanned
// the path on each try: one request of 8000 segments ending in `/` took 2.5 s.

type Routes = ReturnType<typeof table>;
const repeat = (s: string, n: number) => Array(n).fill(s).join("/");
/** The quickest of a few runs, in milliseconds. */
function cost(routes: Routes, path: string): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    match(routes, path);
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

const LONG_TABLES: Record<string, () => Routes> = {
  "the fixture table": table,
  "two catch-alls and a route with two wildcards": () =>
    buildRoutes({
      "/routes/files/[...rest].tsx": mod,
      "/routes/[...slug].tsx": mod,
      "/routes/[...a]/x/[...b].tsx": mod,
    }),
  // No catch-all to fall to: these shapes are matched, or refused, on their own.
  "wildcards with fixed parts around and between them": () =>
    buildRoutes({
      "/routes/[...a]/x/[...b]/end.tsx": mod,
      "/routes/[...a]/x/y/[...b]/stop.tsx": mod,
      "/routes/files/[...dir]/[name]/last.tsx": mod,
      "/routes/[...a]/[c]/[...b]/never.tsx": mod,
    }),
};

const LONG_SHAPES: Record<string, (n: number) => string> = {
  "all valid": (n) => "/files/" + repeat("a", n),
  "a trailing slash": (n) => "/files/" + repeat("a", n) + "/",
  "an empty segment in the middle": (n) =>
    "/files/" + repeat("a", n / 2) + "//" + repeat("a", n / 2),
  "NUL at the end": (n) => "/files/" + repeat("a", n - 1) + "/a%00",
  // Every `x` is a place the first wildcard could end and the second begin.
  "a tail that fails after both wildcards had options": (n) => "/" + repeat("x", n) + "/",
  "all x, valid: both wildcards have every option": (n) => "/" + repeat("x", n),
  "x and y alternating": (n) => "/" + repeat("x/y", n / 2),
  "escaped all through": (n) => "/files/" + repeat("a%20b%2Fc", n),
};

for (const [tname, routes] of Object.entries(LONG_TABLES)) {
  for (const [sname, shape] of Object.entries(LONG_SHAPES)) {
    Deno.test(`a path of 8000 segments is matched in linear time: ${tname}, ${sname}`, () => {
      const r = routes();
      cost(r, shape(200)); // warm
      const at2000 = cost(r, shape(2000));
      const at8000 = cost(r, shape(8000));
      assertEquals(at8000 < 50, true, `8000 segments took ${at8000.toFixed(2)} ms`);
      // Four times the path: about four times the time when linear, sixteen
      // when quadratic. The floor keeps timer noise out of the ratio.
      assertEquals(
        at8000 < 8 * Math.max(at2000, 0.25),
        true,
        `2000 segments ${at2000.toFixed(3)} ms, 8000 segments ${at8000.toFixed(3)} ms`,
      );
    });
  }
}
