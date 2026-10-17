// Client navigation: fetch the destination page, swap the Partial regions,
// hydrate what arrived. Loaded by the boot module only when <body> carries
// data-fu-nav, so a page without it never pays for this file.
//
// Three layers. Pure decisions (which click, which regions, which nodes move,
// which scripts, which response) take plain objects. `createNavigator` is the
// flow (history, supersession, fallbacks, events) against a `NavHost`, so it
// runs without a browser. `installNav` is the host: the only code here that
// touches the DOM.
//
// The rule throughout: anything unexpected ends in a full load of the
// destination, which is always correct.
import { render } from "preact";
import { hydrateIslands } from "./client.ts";
import {
  BUILD_ATTR,
  BUILD_PARAM,
  BUILD_RELOAD_HEADER,
  NAV_ATTR,
  PARTIAL_PARAM,
  REGION_NAME,
} from "./nav-protocol.ts";

/** On `window` before the fetch. `detail` is a `NavDetail`. */
export const NAV_START = "fu:nav-start";
/** On `window` after the swap, once the islands that arrived are hydrated. */
export const NAV_END = "fu:nav";
/** On `window` before every fallback to a full load. `detail.error` says why. */
export const NAV_ERROR = "fu:nav-error";

export interface NavDetail {
  /** The page on screen when the navigation began. */
  from: string;
  to: string;
}

type Manifest = Record<string, () => Promise<Record<string, unknown>>>;

/** The partial-fetch URL for a destination: the page plus the protocol params. */
export function partialUrl(href: string, build: string): string {
  const u = new URL(href);
  u.searchParams.set(PARTIAL_PARAM, "1");
  if (build) u.searchParams.set(BUILD_PARAM, build);
  return u.href;
}

export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

export interface AnchorLike {
  href: string;
  target: string;
  rel?: string;
  hasAttribute(name: string): boolean;
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

/**
 * The destination to navigate to on the client, or null to leave the click to
 * the browser. The nearest `data-fu-nav` decides, at click time, so an island
 * can switch a document off by setting the attribute to "off".
 */
export function interceptTarget(
  a: AnchorLike | null,
  ev: ClickLike,
  current: string,
): string | null {
  if (!a || ev.defaultPrevented || ev.button !== 0) return null;
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return null;
  // An SVG <a> has an SVGAnimatedString in both; it is not ours to follow.
  if (typeof a.href !== "string" || typeof a.target !== "string") return null;
  if (a.target && a.target.toLowerCase() !== "_self") return null;
  if (a.hasAttribute("download")) return null;
  if (/(^|\s)external(\s|$)/i.test(a.rel ?? "")) return null;
  const scope = a.closest(`[${NAV_ATTR}]`);
  if (!scope || scope.getAttribute(NAV_ATTR) === "off") return null;
  let to: URL;
  let from: URL;
  try {
    from = new URL(current);
    to = new URL(a.href, current);
  } catch {
    return null;
  }
  // The scheme too: a blob: URL carries the origin of the page that made it.
  if (to.origin !== from.origin || !/^https?:$/.test(to.protocol)) return null;
  // fetch() refuses a URL with credentials in it.
  if (to.username || to.password) return null;
  // Any fragment on the same page is the browser's, the empty one of
  // `href="#"` included: `URL.hash` is "" for that, the href still ends in #.
  if (to.href.includes("#") && to.pathname === from.pathname && to.search === from.search) {
    return null;
  }
  return to.href;
}

export interface NodeLike {
  nodeType: number;
  data?: string | null;
  nextSibling: NodeLike | null;
  firstChild: NodeLike | null;
  parentNode: NodeLike | null;
}

export interface Region {
  name: string;
  start: NodeLike;
  end: NodeLike;
}

const COMMENT = 8;
const ELEMENT = 1;
// Exact matches of the comment's data, untrimmed: what the server writes and
// nothing that merely resembles it.
const OPEN = new RegExp(`^fu:p:(${REGION_NAME})$`);
const CLOSE = "/fu:p";

const isMarker = (n: NodeLike): boolean =>
  n.nodeType === COMMENT && (n.data === CLOSE || OPEN.test(n.data ?? ""));

/** Whether a marker comment sits anywhere below `n`. */
function holdsMarker(n: NodeLike): boolean {
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (isMarker(c) || holdsMarker(c)) return true;
  }
  return false;
}

/**
 * The regions under `root`, and whether the markers are sound: every opening
 * one closed by a sibling, no closing one on its own, no name twice, and no
 * marker of any kind inside a region. Markers in raw HTML that the app
 * rendered are indistinguishable from real ones, so this is the only check
 * there is; unsound markers mean some part of the page would be swapped
 * wrongly or not at all.
 */
function scan(root: NodeLike): { regions: Map<string, Region>; sound: boolean } {
  const regions = new Map<string, Region>();
  let sound = true;
  const visit = (first: NodeLike | null) => {
    for (let n = first; n; n = n.nextSibling) {
      if (n.nodeType === COMMENT) {
        const open = OPEN.exec(n.data ?? "");
        if (!open) {
          if (n.data === CLOSE) sound = false;
          continue;
        }
        let depth = 0;
        let e: NodeLike | null = n.nextSibling;
        for (; e; e = e.nextSibling) {
          if (e.nodeType !== COMMENT) {
            if (holdsMarker(e)) sound = false;
            continue;
          }
          if (OPEN.test(e.data ?? "")) {
            depth++;
            sound = false;
          } else if (e.data === CLOSE && depth-- === 0) break;
        }
        if (!e) {
          sound = false;
          continue;
        }
        if (regions.has(open[1])) sound = false;
        else regions.set(open[1], { name: open[1], start: n, end: e });
        n = e;
        continue;
      }
      if (n.firstChild) visit(n.firstChild);
    }
  };
  visit(root.firstChild);
  return { regions, sound };
}

/**
 * Every outermost Partial region under `root`, by name, as found: a nested
 * region is not listed, an opening marker without a closing one is ignored,
 * and of two regions with one name the first is listed. Whether the page may
 * be navigated at all is `soundRegions`' question, not this function's.
 */
export function findRegions(root: NodeLike): Map<string, Region> {
  return scan(root).regions;
}

/**
 * The regions of a page that can take part in a navigation, or null when it
 * cannot: no region, a name twice, a region inside a region, an opening or a
 * closing marker without its partner, or any marker anywhere inside a region.
 */
export function soundRegions(root: NodeLike): Map<string, Region> | null {
  const { regions, sound } = scan(root);
  return sound && regions.size > 0 ? regions : null;
}

/**
 * The live regions paired with the ones that arrived, in live document order;
 * or null when the two pages cannot be stitched: either is not sound, or the
 * two sets of names differ. Two regimes of page are never mixed; null means a
 * full load.
 */
export function matchRegions(live: NodeLike, next: NodeLike): Array<[Region, Region]> | null {
  const a = soundRegions(live);
  const b = soundRegions(next);
  if (!a || !b || a.size !== b.size) return null;
  const pairs: Array<[Region, Region]> = [];
  for (const [name, region] of a) {
    const other = b.get(name);
    if (!other) return null;
    pairs.push([region, other]);
  }
  return pairs;
}

const JS_TYPE = /^(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/;

/**
 * Scripts a full page load would run: no type, a JavaScript MIME type, or
 * `module`. Data scripts (ld+json, importmap, templates) are not.
 */
export function isExecutableScript(type: string | null): boolean {
  const t = (type ?? "").trim().toLowerCase();
  return t === "" || JS_TYPE.test(t);
}

export interface ScriptLike {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

/**
 * What to do with a script that arrived in a swapped region. "leave": it is
 * data, or `nomodule` (every browser that loaded this runtime has modules).
 * "run": re-create it. "wait": re-create it and hold the scripts after it
 * until it has loaded, because it is a classic external script without
 * `async` or `defer`, which on a full load blocks the ones that follow.
 */
export function scriptAction(s: ScriptLike): "leave" | "run" | "wait" {
  const type = s.getAttribute("type");
  if (!isExecutableScript(type)) return "leave";
  const module = (type ?? "").trim().toLowerCase() === "module";
  if (!module && s.hasAttribute("nomodule")) return "leave";
  const blocks = s.hasAttribute("src") && !module && !s.hasAttribute("async") &&
    !s.hasAttribute("defer");
  return blocks ? "wait" : "run";
}

/** An element as far as planning a swap needs one. */
export interface ElementLike extends NodeLike, ScriptLike {
  localName: string;
  querySelectorAll(selector: string): Iterable<ElementLike>;
}

/** Everything a swap does to the document, decided before anything is touched. */
export interface SwapPlan {
  /** Per region, in live document order: what leaves, and what arrives ahead of `before`. */
  regions: Array<{ before: NodeLike; remove: NodeLike[]; insert: NodeLike[] }>;
  /** The island markers in the nodes that leave, in document order. */
  unmount: ElementLike[];
  /** The island markers in the nodes that arrive, in document order. */
  hydrate: ElementLike[];
  /** The scripts that arrive and must be re-created to run, in document order. */
  scripts: Array<{ script: ElementLike; wait: boolean }>;
}

/** The nodes between a region's markers. */
function between(region: Region): NodeLike[] {
  const out: NodeLike[] = [];
  for (let n = region.start.nextSibling; n && n !== region.end; n = n.nextSibling) out.push(n);
  return out;
}

/** The elements among `nodes`, and below them, that `selector` and `isRoot` pick, in order. */
function collect(
  nodes: NodeLike[],
  selector: string,
  isRoot: (el: ElementLike) => boolean,
): ElementLike[] {
  const out: ElementLike[] = [];
  for (const n of nodes) {
    if (n.nodeType !== ELEMENT) continue;
    const el = n as ElementLike;
    if (isRoot(el)) out.push(el);
    out.push(...el.querySelectorAll(selector));
  }
  return out;
}

const ISLAND = "data-island";

/**
 * Plan the swap of each live region for the one that arrived: the nodes
 * between the live markers leave, the nodes between the arrived markers take
 * their place. Islands are unmounted on the nodes that leave and hydrated on
 * the nodes that arrive; the two sets are disjoint, so an island never
 * hydrates into an element another instance owns, and every marker that
 * arrives is hydrated exactly once because it is a new element. An island
 * outside every region is in neither list and lives on.
 */
export function planSwap(pairs: Array<[Region, Region]>): SwapPlan {
  const plan: SwapPlan = { regions: [], unmount: [], hydrate: [], scripts: [] };
  const isIsland = (el: ElementLike) => el.hasAttribute(ISLAND);
  for (const [live, next] of pairs) {
    const remove = between(live);
    const insert = between(next);
    plan.regions.push({ before: live.end, remove, insert });
    plan.unmount.push(...collect(remove, `[${ISLAND}]`, isIsland));
    plan.hydrate.push(...collect(insert, `[${ISLAND}]`, isIsland));
    for (const script of collect(insert, "script", (el) => el.localName === "script")) {
      const action = scriptAction(script);
      if (action !== "leave") plan.scripts.push({ script, wait: action === "wait" });
    }
  }
  return plan;
}

/** As much of a fetch `Response` as the navigator reads. */
export interface NavResponse {
  ok: boolean;
  status: number;
  redirected: boolean;
  /** The URL the response came from: after a redirect, not the one asked for. */
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * Why a response cannot be swapped in, or null when it can. A redirect is
 * refused as well: the address bar holds the URL that was asked for, and only
 * a full load shows the one the server sent the browser to.
 */
export function refusal(res: NavResponse): string | null {
  if (res.headers.get(BUILD_RELOAD_HEADER)) return "the server asked for a full load";
  if (res.redirected) return "the request was redirected";
  if (!res.ok) return `the server answered ${res.status}`;
  if (!/^\s*text\/html\s*(;|$)/i.test(res.headers.get("content-type") ?? "")) {
    return "the answer is not HTML";
  }
  return null;
}

/**
 * Where a redirected fetch ended, as a URL to load in full: the final URL
 * without the two protocol params (the rest of its query byte for byte), with
 * the fragment that was asked for when it has none of its own, as a browser
 * following the redirect would have it. Null when the final URL is on another
 * origin or cannot be read: then the original is loaded, and the browser
 * follows the redirect itself.
 */
export function redirectTarget(finalUrl: string, to: string): string | null {
  let final: URL;
  let asked: URL;
  try {
    final = new URL(finalUrl);
    asked = new URL(to);
  } catch {
    return null;
  }
  if (final.origin !== asked.origin) return null;
  const query = final.search.slice(1).split("&").filter((pair) => {
    const key = pair.split("=")[0];
    return pair !== "" && key !== PARTIAL_PARAM && key !== BUILD_PARAM;
  }).join("&");
  return final.origin + final.pathname + (query ? "?" + query : "") + (final.hash || asked.hash);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The scroll position kept on a history entry's state, if a sane one is there. */
function position(state: unknown): [x: number, y: number] | null {
  const at = isObject(state) ? state.fu : null;
  return Array.isArray(at) && at.length === 2 && at.every(Number.isFinite)
    ? at as [number, number]
    : null;
}

/** The page a URL names: everything but the fragment. */
const page = (url: string): string => url.split("#")[0];

/**
 * Everything the navigator needs from the browser. `installNav` supplies the
 * real one; the tests a recording one. Not part of the app-facing API.
 */
export interface NavHost {
  /** The page's build id, stamped on every fetch. "" when the page has none. */
  build: string;
  /** `location.href`. */
  href(): string;
  /** `history.state`. */
  state(): unknown;
  pushState(state: unknown, url: string): void;
  /** The current entry keeps its URL. */
  replaceState(state: unknown): void;
  scroll(): [x: number, y: number];
  scrollTo(x: number, y: number): void;
  /** Scroll to the element a fragment ("#id") names. False when there is none. */
  scrollToHash(hash: string): boolean;
  fetch(url: string, signal: AbortSignal): Promise<NavResponse>;
  /** Whether the live document has sound regions to swap. */
  ready(): boolean;
  /**
   * Swap the regions of the fetched page into the live document, at once and
   * for all regions or not at all. Null: the two pages do not match and
   * nothing was touched. Otherwise the swap is done, and the promise resolves
   * when the islands that arrived are hydrated.
   */
  commit(html: string): Promise<void> | null;
  /** `location.replace`. */
  replace(url: string): void;
  /** `location.reload`. */
  reload(): void;
  emit(type: string, detail: NavDetail & { error?: unknown }): void;
}

export interface Navigator {
  /**
   * A click on a link to `to` that `interceptTarget` let through. True when
   * the navigator has taken it and the browser must not; false to let the
   * browser navigate.
   */
  click(to: string): boolean;
  /** A `popstate`: the address bar moved to another history entry. */
  pop(): void;
  /**
   * The app called `history.replaceState`: the entry the user is on may name
   * another URL now, and what is on screen is that entry's page.
   */
  replaced(): void;
  /** The page was scrolled: keep the position on the current history entry. */
  remember(): void;
  /** Abandon the pending navigation, if any. */
  stop(): void;
}

interface Pending {
  ac: AbortController;
  to: string;
  push: boolean;
  /** The swap has happened: the document shows `to`. Only hydration is left. */
  committed: boolean;
}

/**
 * The navigation flow.
 *
 * What decides is the page on screen, never `history.state`: the navigator
 * remembers the URL it last drew, and a `popstate` to an entry that names
 * another page (path or query differs) fetches and draws it, whoever made the
 * entry and whatever state it carries. An app may call `pushState` and
 * `replaceState` with its own state freely. A `popstate` that changes the
 * fragment only is the browser's.
 *
 * "The URL it last drew" follows the entry the user is on: when the app gives
 * that entry another URL with `replaceState`, the page on screen is now known
 * by that URL, and Back to it later draws nothing. `pushState` by the app is
 * not followed: the entry it leaves still names the page on screen, and the
 * one it makes is asked of the server when Forward reaches it from elsewhere.
 *
 * A history entry is made before the fetch, so every fallback after a click
 * is `replace` (Back must not land on the same URL twice) and every fallback
 * after a `popstate`, where nothing was made, is `reload`. The latest
 * navigation wins: an earlier one is aborted and, where it is past its fetch,
 * does nothing more once it notices. `fu:nav-start` is therefore followed by
 * `fu:nav`, by `fu:nav-error` and a full load, or by the `fu:nav-start` of
 * the navigation that replaced it.
 *
 * Scroll is the browser's by default (`history.scrollRestoration` is left
 * alone, so a reload keeps its position). After a swap the navigator scrolls
 * itself: to the top or the fragment's element for a click, and for Back and
 * Forward to the position it kept on that entry, under `fu` in the entry's
 * state, merged into whatever state the app keeps there. That is best effort:
 * with no position there (the app replaced the state) nothing is scrolled.
 */
export function createNavigator(host: NavHost): Navigator {
  let pending: Pending | null = null;
  /** The URL of the page on screen: the address bar runs ahead of it during a fetch. */
  let shown = host.href();
  /** A full load is on its way: nothing more is ours. */
  let dead = false;

  /** Keep the scroll position on the current entry, beside the app's own state. */
  const stamp = (): void => {
    const state = host.state();
    // A state that is not an object is the app's, and there is no merging into it.
    if (state != null && !isObject(state)) return;
    try {
      host.replaceState({ ...(state as Record<string, unknown> | null), fu: host.scroll() });
    } catch {
      // Browsers cap how often history may be written. The position is a nicety.
    }
  };

  const go = async (to: string, push: boolean): Promise<void> => {
    const prior = pending;
    prior?.ac.abort();
    // The entry the address bar was on when this began was never drawn.
    const unseen = !!prior && !prior.committed;
    const here = host.href();
    // The browser moves the fragment on its own; pick that up.
    if (push && !unseen) shown = here;
    const from = shown;
    // Read now: by the time the page arrives the browser may have scrolled.
    const kept = push ? null : position(host.state());
    const nav: Pending = { ac: new AbortController(), to, push, committed: false };
    pending = nav;
    const stale = () => pending !== nav;
    const fail = (error: unknown, load?: string | null) => {
      host.emit(NAV_ERROR, { from, to, error });
      dead = true;
      nav.ac.abort();
      if (load) host.replace(load);
      else if (push) host.replace(to);
      else host.reload();
    };
    host.emit(NAV_START, { from, to });
    try {
      // A click that "refreshes" the current page must not grow history.
      if (push && to !== here) {
        // Remember where the page being left was scrolled to, for Back. Not
        // for an entry that was never drawn: the scroll is another page's.
        if (!unseen) stamp();
        host.pushState({ fu: [0, 0] }, to);
      }
      const res = await host.fetch(partialUrl(to, host.build), nav.ac.signal);
      if (stale()) return;
      const refused = refusal(res);
      if (refused) {
        // One hop saved: the browser is sent where the redirect ended.
        const final = res.redirected ? redirectTarget(res.url, to) : null;
        return fail(new Error("fu: " + refused), final);
      }
      const html = await res.text();
      if (stale()) return;
      const hydrated = host.commit(html);
      if (!hydrated) return fail(new Error("fu: the page's regions or build differ"));
      nav.committed = true;
      shown = to;
      if (push) {
        const hash = new URL(to).hash;
        if (!hash || !host.scrollToHash(hash)) host.scrollTo(0, 0);
      } else if (kept) host.scrollTo(...kept);
      await hydrated;
      if (stale()) return;
      host.emit(NAV_END, { from, to });
    } catch (error) {
      if (!stale()) fail(error);
    } finally {
      if (!stale()) pending = null;
    }
  };

  return {
    click(to: string): boolean {
      if (dead || !host.ready()) return false;
      // A second click on a link whose page is already on its way.
      if (pending && pending.push && !pending.committed && pending.to === to) return true;
      void go(to, true);
      return true;
    },
    pop(): void {
      const here = host.href();
      if (page(here) !== page(shown)) {
        if (dead) host.reload();
        else void go(here, false);
        return;
      }
      // Back on the page that is on screen: a fragment entry, an entry of the
      // app's own, or the page a pending navigation was leaving. Nothing to
      // draw; but that navigation is over, and whoever heard it start is told.
      if (pending && !pending.committed) {
        pending.ac.abort();
        pending = null;
        host.emit(NAV_END, { from: shown, to: here });
      }
    },
    replaced(): void {
      // Not while the address bar is ahead of the page: the entry that was
      // rewritten is the destination's, and the page on screen is another.
      if (!(pending && !pending.committed)) shown = host.href();
    },
    remember(): void {
      // Not while the address bar is ahead of the page: the position on
      // screen belongs to another entry than the current one.
      if (!dead && !(pending && !pending.committed)) stamp();
    },
    stop(): void {
      pending?.ac.abort();
      pending = null;
    },
  };
}

/**
 * Scripts inserted through DOM APIs never run. A region that arrived by
 * navigation must behave as it does on a full load, so each executable script
 * is replaced by a fresh element with the same attributes and text, in
 * document order; the browser runs the replacement. Data scripts stay. The
 * scripts ahead of the first blocking external one run before this returns.
 */
async function runScripts(scripts: SwapPlan["scripts"]): Promise<void> {
  for (const { script, wait } of scripts) {
    const old = script as unknown as Element;
    // Not connected: a later navigation, or an earlier script, removed it.
    if (!old.isConnected) continue;
    const fresh = document.createElement("script");
    for (const a of old.attributes) {
      try {
        fresh.setAttribute(a.name, a.value);
      } catch {
        // A name the HTML parser accepts and the DOM does not.
      }
    }
    fresh.textContent = old.textContent;
    const loaded = wait
      ? new Promise<void>((done) => {
        fresh.addEventListener("load", () => done());
        fresh.addEventListener("error", () => done());
      })
      : null;
    old.replaceWith(fresh);
    if (loaded) await loaded;
  }
}

/**
 * Parse the fetched page and swap its regions in. Everything up to and
 * including the removal and insertion of nodes is synchronous, so two
 * navigations can never interleave their halves of a page; only hydration,
 * which waits for island chunks, is left to the returned promise.
 */
function commit(text: string, build: string, manifest: Manifest): Promise<void> | null {
  const next = new DOMParser().parseFromString(text, "text/html");
  // A page from another deploy cannot be hydrated by this one's boot module.
  // A page without the attribute is "" on both sides, as `installNav` reads it.
  const theirs = next.documentElement.getAttribute(BUILD_ATTR) ?? "";
  if (theirs !== build) return null;
  const pairs = matchRegions(document as unknown as NodeLike, next as unknown as NodeLike);
  if (!pairs) return null;
  // DOMParser parses with scripting off, where <noscript> holds elements. In
  // this document they would be live: images and frames meant for no-script
  // browsers would load. Make them the text they are when scripting is on.
  for (const ns of next.querySelectorAll("noscript")) ns.textContent = ns.innerHTML;
  const plan = planSwap(pairs);
  // No list of hydrated elements is kept: render(null) unmounts an island and
  // does nothing to a marker that never got one. Each is on its own, as in
  // hydration: one that throws does not keep the others mounted.
  for (const el of plan.unmount) {
    try {
      render(null, el as unknown as Element);
    } catch (err) {
      console.error(`[fu] ${el.getAttribute(ISLAND)} failed to unmount`, err);
    }
  }
  for (const { before, remove, insert } of plan.regions) {
    const end = before as unknown as Node;
    const parent = end.parentNode!;
    for (const n of remove) parent.removeChild(n as unknown as Node);
    for (const n of insert) parent.insertBefore(document.adoptNode(n as unknown as Node), end);
  }
  runScripts(plan.scripts).catch((err) =>
    console.error("[fu] a script in a swapped region failed", err)
  );
  return hydrateIslands(manifest, plan.hydrate as unknown as HTMLElement[]);
}

function scrollToHash(hash: string): boolean {
  const id = hash.slice(1);
  let el = document.getElementById(id);
  if (!el) {
    try {
      el = document.getElementById(decodeURIComponent(id));
    } catch {
      // A malformed escape names nothing.
    }
  }
  el?.scrollIntoView({ behavior: "instant" });
  return !!el;
}

/**
 * Intercept same-origin link clicks under `data-fu-nav`, fetch the page with
 * the partial protocol, and swap its Partial regions into the live document.
 * Anything unexpected (a reload directive, a redirect, a non-HTML or error
 * answer, a region set or build that differs, a throw) falls back to a full
 * load of the destination, announced by `fu:nav-error`. The click is
 * cancelled with `preventDefault` only; it still propagates.
 * Returns a function that removes the listeners and abandons a pending
 * navigation.
 */
export function installNav(manifest: Manifest): () => void {
  const build = document.documentElement.getAttribute(BUILD_ATTR) ?? "";
  // history.replaceState as it was found: the browser's, or an app's wrapper.
  const replaceState = history.replaceState;
  let installed = true;
  const nav = createNavigator({
    build,
    href: () => location.href,
    state: () => history.state,
    pushState: (state, url) => history.pushState(state, "", url),
    // Not through the wrapper below: the scroll stamp is no news about the URL.
    replaceState: (state) => replaceState.call(history, state, ""),
    scroll: () => [scrollX, scrollY],
    // Instant: a stylesheet's `scroll-behavior: smooth` is for in-page jumps.
    scrollTo: (left, top) => scrollTo({ left, top, behavior: "instant" }),
    scrollToHash,
    // Looked up at call time, so an app's wrapper around fetch still applies.
    fetch: (url, signal) =>
      fetch(url, { signal, credentials: "same-origin", headers: { accept: "text/html" } }),
    ready: () => soundRegions(document as unknown as NodeLike) !== null,
    commit: (html) => commit(html, build, manifest),
    replace: (url) => location.replace(url),
    reload: () => location.reload(),
    emit: (type, detail) => {
      dispatchEvent(new CustomEvent(type, { detail }));
    },
  });

  const onClick = (ev: MouseEvent) => {
    // A link inside a shadow root (the target is retargeted to its host) and
    // an <area> are not found here: those clicks stay the browser's.
    const a = (ev.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    const to = interceptTarget(a, ev, location.href);
    if (to && nav.click(to)) ev.preventDefault();
  };
  const onPop = () => nav.pop();
  // The app may rename the entry it is on (a share URL, a filter in the
  // query). There is no event for that, so the call itself is watched.
  // pushState is deliberately not: see `createNavigator`.
  const wrapper: History["replaceState"] = function (this: History, ...args): void {
    replaceState.apply(this, args);
    if (installed) nav.replaced();
  };
  history.replaceState = wrapper;
  // Once the scrolling has settled, not on every frame of it.
  let settled: ReturnType<typeof setTimeout> | undefined;
  const onScroll = () => {
    clearTimeout(settled);
    settled = setTimeout(nav.remember, 150);
  };
  document.addEventListener("click", onClick);
  addEventListener("popstate", onPop);
  addEventListener("scroll", onScroll, { passive: true });
  return () => {
    document.removeEventListener("click", onClick);
    removeEventListener("popstate", onPop);
    removeEventListener("scroll", onScroll);
    clearTimeout(settled);
    nav.stop();
    installed = false;
    // Unless someone wrapped it again since: theirs calls ours, which now
    // only passes the call on.
    if (history.replaceState === wrapper) history.replaceState = replaceState;
  };
}
