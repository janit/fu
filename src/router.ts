// Routing on the segments of the raw pathname: it is split on a literal `/`
// only, so an encoded one (`%2F`) never separates anything.
import type { RouteManifest, RouteModule } from "./types.ts";

/** One segment of a route: its text, or a param (`rest`: a wildcard). */
export type Part = string | { name: string; rest: boolean };

export interface Route<S = Record<string, unknown>> {
  /** The manifest key, e.g. "/routes/blog/[slug].tsx". For error messages. */
  file: string;
  /**
   * The route in URLPattern spelling, e.g. "/blog/:slug". It names the route
   * and orders it; matching reads `parts`.
   */
  pattern: string;
  /** The route segment by segment, after the leading slash. */
  parts: Part[];
  load: () => Promise<RouteModule<S>>;
  /** Lower sorts first: static beats dynamic beats wildcard. */
  score: number;
  /**
   * The path itself, as the file names spell it, when no segment is a param:
   * the route is then matched by string equality.
   */
  literal: string | null;
  /** Segments in the pattern, counting the empty one before the leading slash. */
  segments: number;
  /** The loaded module, cached by the renderer after the first request. */
  module?: RouteModule<S>;
}

export interface Matched<S = Record<string, unknown>> {
  route: Route<S>;
  /** Each param's segment(s), decoded one at a time; `%2F` and `%5C` stay as written. */
  params: Record<string, string>;
  /** The same keys, as the pathname spells them. */
  rawParams: Record<string, string>;
}

/** `[name]` or `[...name]`, as a whole path segment. */
const PARAM = /^\[(\.\.\.)?(.*)\]$/;
/** What URLPattern reads as one param name; `[my-id]` would become `:my` plus a literal `-id`. */
const PARAM_NAME = /^[A-Za-z_$][\w$]*$/;
/** Anything URLPattern would read as syntax rather than as a literal character. */
const PATTERN_SYNTAX = /[:*?+(){}\\]/g;

interface Parsed {
  pattern: string;
  /** The pattern with param names dropped: two files with the same shape collide. */
  shape: string;
  /** The path itself when no segment is a param, else null. */
  literal: string | null;
  /** 0 static, 1 dynamic, 2 wildcard. */
  score: number;
  parts: Part[];
}

function parse(file: string): Parsed {
  let p = file.replace(/^\/routes/, "").replace(/\.[tj]sx?$/, "");
  if (p.endsWith("/index")) p = p.slice(0, -"/index".length);
  let score = 0;
  const shape: string[] = [];
  const parts: Part[] = [];
  const pattern = p.split("/").map((s, i) => {
    const m = PARAM.exec(s);
    if (!m) {
      // A file name is a literal: `a+b.tsx` answers `/a+b`.
      const escaped = s.replace(PATTERN_SYNTAX, "\\$&");
      shape.push(escaped);
      // The first is the empty one before the leading slash.
      if (i) parts.push(s);
      return escaped;
    }
    const [, rest, name] = m;
    if (!PARAM_NAME.test(name)) {
      throw new Error(
        `fu: ${file}: the param name "${name}" must be letters, digits, _ or $, ` +
          `and not start with a digit`,
      );
    }
    score = Math.max(score, rest ? 2 : 1);
    shape.push(rest ? ":*" : ":");
    parts.push({ name, rest: !!rest });
    return ":" + name + (rest ? "*" : "");
  }).join("/") || "/";
  return {
    pattern,
    shape: shape.join("/") || "/",
    literal: score === 0 ? p || "/" : null,
    score,
    parts,
  };
}

/**
 * `/routes/blog/[slug].tsx` -> `/blog/:slug`
 * `/routes/files/[...rest].tsx` -> `/files/:rest*`
 * `/routes/index.tsx` -> `/`
 */
export function filePathToPattern(file: string): string {
  return parse(file).pattern;
}

export function buildRoutes<S = Record<string, unknown>>(
  manifest: RouteManifest<S>,
): Route<S>[] {
  const out: Route<S>[] = [];
  const shapes = new Map<string, string>();
  for (const [file, load] of Object.entries(manifest)) {
    const { pattern, shape, literal, score, parts } = parse(file);
    // Which of two such files answered used to depend on the order they were
    // listed in, with no word about the other.
    const twin = shapes.get(shape);
    if (twin) throw new Error(`fu: ${twin} and ${file} both answer ${pattern}; remove one`);
    shapes.set(shape, file);
    out.push({
      file,
      pattern,
      parts,
      load,
      score,
      literal,
      segments: countSegments(pattern),
    });
  }
  return out.sort((a, b) =>
    a.score - b.score || b.segments - a.segments || bySegment(a.pattern, b.pattern)
  );
}

/**
 * Tie-break between routes of the same kind and length, so the winner never
 * depends on the order the file system listed them in: compared segment by
 * segment, a literal beats a param (`/blog/:slug` before `/:lang/about`), and
 * what is still tied sorts by pattern.
 */
function bySegment(a: string, b: string): number {
  const as = a.split("/"), bs = b.split("/");
  for (let i = 0; i < as.length && i < bs.length; i++) {
    const d = Number(as[i].startsWith(":")) - Number(bs[i].startsWith(":"));
    if (d) return d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function countSegments(pathname: string): number {
  let n = 1;
  for (let i = 0; i < pathname.length; i++) if (pathname.charCodeAt(i) === 47 /* / */) n++;
  return n;
}

/** An encoded separator: `%2F` or `%5C`, in either case. */
const SEPARATOR = /%(?:2f|5c)/i;
const SEPARATORS = /%(?:2f|5c)/gi;

/**
 * A segment percent-decoded for `params`, except that an encoded slash or
 * backslash stays as written: decoding never makes a separator, so a param
 * has a `/` only where the path had one and cannot be read as a path that
 * climbs. `%252F` decodes once, to `%2F`. A segment whose escapes are
 * malformed is left whole, as written.
 */
function decodeSegment(s: string): string {
  if (!s.includes("%")) return s;
  try {
    if (!SEPARATOR.test(s)) return decodeURIComponent(s);
    let out = "";
    let last = 0;
    for (const m of s.matchAll(SEPARATORS)) {
      out += decodeURIComponent(s.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + decodeURIComponent(s.slice(last));
  } catch {
    return s;
  }
}

const isDot = (s: string): boolean => s === "." || s === "..";

/**
 * The path as URL parsing would leave it: `.` dropped, `..` taking the
 * segment before it. `dec` decides, so `%2e%2e` is a dot segment like `..`.
 * A request's pathname has none left (its URL was parsed); this is for a
 * direct caller of `match`.
 */
function resolveDots(raw: string[], dec: string[]): [raw: string[], dec: string[]] {
  const r: string[] = [];
  const d: string[] = [];
  let dot = false;
  for (let i = 0; i < dec.length; i++) {
    dot = isDot(dec[i]);
    if (!dot) {
      r.push(raw[i]);
      d.push(dec[i]);
    } else if (dec[i] === "..") {
      r.pop();
      d.pop();
    }
  }
  // `/a/.` is `/a/`.
  if (dot) {
    r.push("");
    d.push("");
  }
  return [r, d];
}

/** The segments after the leading slash. A backslash written out separates too, as in a URL. */
function split(pathname: string): string[] {
  return (pathname.includes("\\") ? pathname.replaceAll("\\", "/") : pathname).slice(1).split("/");
}

/** A segment nothing takes: no static segment is empty or holds NUL, and no param may be. */
const untakable = (s: string): boolean => s === "" || s.includes("\0");

/**
 * First route that matches, in `buildRoutes` order.
 *
 * The pathname is taken as written and split on `/`: `%2F` is part of its
 * segment, never a separator. A static segment of a route matches a segment
 * that decodes to it (`/%61bout` reaches `/about`, however it is escaped).
 * A route with no param compares by equality with the whole decoded path.
 *
 * Deliberately, no param is ever a dot segment: a segment that is `.` or `..`
 * once decoded is resolved the way URL parsing does it, and a path that had
 * one reaches a wildcard route only, with what is left.
 *
 * The cost is linear in the length of the path. It is split and decoded once
 * for all routes, a path with a segment nothing can take (empty, or holding
 * NUL) is refused in that one pass, and `fit` never retries.
 */
export function match<S = Record<string, unknown>>(
  routes: Route<S>[],
  pathname: string,
): Matched<S> | null {
  let raw: string[] | undefined;
  let dec: string[] = [];
  /** The decoded path, for the static routes. */
  let key: string | null = pathname;
  if (pathname.includes("%")) {
    raw = split(pathname);
    dec = raw.map(decodeSegment);
    key = pathname.includes("\\") ? null : "/" + dec.join("/");
  }
  /** 0 not looked at yet, 1 every route may fit, 2 only a wildcard route, 3 none. */
  let state = 0;
  for (const route of routes) {
    if (route.literal !== null) {
      if (route.literal === key) return { route, params: {}, rawParams: {} };
      continue;
    }
    if (state === 0) {
      // Static routes sort first: a path with no escape is not split for them.
      raw ??= dec = split(pathname);
      state = 1;
      if (dec.some(isDot)) {
        [raw, dec] = resolveDots(raw, dec);
        state = 2;
      }
      if (dec.some(untakable)) state = 3;
    }
    if (state === 3 || state === 2 && route.score !== 2) continue;
    const m = fit(route, raw!, dec);
    if (m) return m;
  }
  return null;
}

/** Whether the parts `from` to `to` match the segments starting at `at`. A param matches any. */
function same(parts: Part[], from: number, to: number, dec: string[], at: number): boolean {
  for (let i = from; i < to; i++) {
    const part = parts[i];
    if (typeof part === "string" && part !== dec[at + i - from]) return false;
  }
  return true;
}

/**
 * The route matched against the segments, or null. Every segment can be taken
 * by a param (`match` has seen to that), so nothing is tried twice:
 *
 * - without a wildcard, the parts and the segments pair off one to one;
 * - the parts before the first wildcard are tied to the start of the path and
 *   those after the last to its end, and with one wildcard that settles it:
 *   it has what lies between, none included (`/files/[...rest]` answers
 *   `/files`, with no `rest` key);
 * - with several, each run of parts between two wildcards is put as far right
 *   as it goes, last run first. That gives every wildcard but the last as
 *   many segments as the rest of the route allows, the first before the
 *   second: what a pattern engine's greedy match gives.
 *
 * So one route costs the number of segments, times the longest run of parts
 * between two wildcards when it has several: a property of the route file,
 * never of the request.
 */
function fit<S>(route: Route<S>, raw: string[], dec: string[]): Matched<S> | null {
  const parts = route.parts;
  const n = dec.length;
  let first = 0;
  while (first < parts.length && !isRest(parts[first])) first++;
  /** at[i]: the segment part i starts at; a wildcard runs to at[i + 1]. */
  let at: number[] | undefined;
  if (first === parts.length) {
    if (n !== parts.length || !same(parts, 0, n, dec, 0)) return null;
  } else {
    let last = parts.length - 1;
    while (!isRest(parts[last])) last--;
    // What follows the last wildcard starts here.
    let end = n - (parts.length - 1 - last);
    if (end < first || !same(parts, 0, first, dec, 0)) return null;
    if (!same(parts, last + 1, parts.length, dec, end)) return null;
    at = [];
    for (let i = 0; i <= first; i++) at[i] = i;
    for (let i = parts.length; i > last; i--) at[i] = n - (parts.length - i);
    // The runs between wildcards, from the last back to the first.
    for (let to = last; to > first;) {
      let from = to - 1;
      while (!isRest(parts[from])) from--;
      from++;
      let start = end - (to - from);
      while (start >= first && !same(parts, from, to, dec, start)) start--;
      if (start < first) return null;
      for (let i = from; i <= to; i++) at[i] = start + i - from;
      end = start;
      to = from - 1;
    }
  }
  const m: Matched<S> = { route, params: {}, rawParams: {} };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (typeof part === "string") continue;
    const a = at ? at[i] : i;
    const b = part.rest ? at![i + 1] : a + 1;
    if (b - a === 1) {
      m.params[part.name] = dec[a];
      m.rawParams[part.name] = raw[a];
    } else if (b > a) {
      // The `/` put between the segments of a wildcard are the only ones a param holds.
      m.params[part.name] = dec.slice(a, b).join("/");
      m.rawParams[part.name] = raw.slice(a, b).join("/");
    }
  }
  return m;
}

const isRest = (part: Part): boolean => typeof part !== "string" && part.rest;
