// The navigation flow (history, supersession, fallbacks, events, scroll)
// driven against a recording stand-in for the browser. The pure decisions are
// in nav_test.ts; the DOM half runs in a real browser.
import { assertEquals } from "@std/assert";
import { createNavigator, type NavHost, type NavResponse } from "./nav.ts";

const A = "http://x/a";
const B = "http://x/b";
const C = "http://x/c";
/** What the navigator keeps on an entry: a scroll position, under one key. */
const FU = (x = 0, y = 0) => ({ fu: [x, y] });

function response(
  over: Partial<Omit<NavResponse, "headers" | "text">> & {
    headers?: Record<string, string>;
    body?: string | Promise<string>;
  } = {},
): NavResponse {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    ...over.headers,
  };
  return {
    ok: over.ok ?? true,
    status: over.status ?? 200,
    redirected: over.redirected ?? false,
    url: over.url ?? "",
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    text: () => Promise.resolve(over.body ?? "<html>"),
  };
}

interface Request {
  url: string;
  signal: AbortSignal;
  answer(res?: NavResponse): Promise<void>;
  fail(err: unknown): Promise<void>;
}

/** Let every pending promise reaction run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * A browser as the navigator sees it: a history stack, a scroll position, a
 * fetch whose answers the test hands out, and a log of everything asked of it.
 */
function browser(start = A) {
  const log: string[] = [];
  const entries: Array<{ url: string; state: unknown }> = [{ url: start, state: null }];
  const requests: Request[] = [];
  const self = {
    log,
    entries,
    requests,
    index: 0,
    scroll: [0, 0] as [number, number],
    ready: true,
    /** Fragments that name an element. */
    anchors: new Set<string>(),
    /** What `commit` answers: hydration done at once, by default. */
    commit: ((_html: string) => Promise.resolve()) as NavHost["commit"],
    /** The log since the last call, to assert one step at a time. */
    take(): string[] {
      return log.splice(0);
    },
    /** Back or Forward: move, then fire popstate. */
    async traverse(delta: number): Promise<void> {
      self.index += delta;
      nav.pop();
      await settle();
    },
    async click(to: string): Promise<boolean> {
      const taken = nav.click(to);
      await settle();
      return taken;
    },
    /** What an app does on its own: history.pushState with its own state. */
    appPush(url: string, state: unknown): void {
      entries.splice(self.index + 1);
      entries.push({ url, state });
      self.index++;
    },
    /** history.replaceState by the app, as the wrapper `installNav` puts around it reports it. */
    appReplace(url: string, state: unknown): void {
      entries[self.index] = { url, state };
      nav.replaced();
    },
  };
  const host: NavHost = {
    build: "b1",
    href: () => entries[self.index].url,
    state: () => entries[self.index].state,
    pushState(state, url) {
      entries.splice(self.index + 1);
      entries.push({ url, state });
      self.index++;
      log.push(`pushState ${url} ${JSON.stringify(state)}`);
    },
    replaceState(state) {
      entries[self.index] = { url: entries[self.index].url, state };
      log.push(`replaceState ${JSON.stringify(state)}`);
    },
    scroll: () => self.scroll,
    scrollTo: (x, y) => void log.push(`scrollTo ${x},${y}`),
    scrollToHash(hash) {
      log.push(`scrollToHash ${hash}`);
      return self.anchors.has(hash);
    },
    fetch(url, signal) {
      log.push(`fetch ${url}`);
      return new Promise<NavResponse>((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
        );
        requests.push({
          url,
          signal,
          answer: (res = response()) => (resolve(res), settle()),
          fail: (err) => (reject(err), settle()),
        });
      });
    },
    ready: () => self.ready,
    commit(html) {
      log.push(`commit ${html}`);
      return self.commit(html);
    },
    replace: (url) => void log.push(`location.replace ${url}`),
    reload: () => void log.push("location.reload"),
    emit(type, detail) {
      const why = "error" in detail ? ` (${(detail.error as Error).message})` : "";
      log.push(`${type} ${detail.from} -> ${detail.to}${why}`);
    },
  };
  const nav = createNavigator(host);
  return Object.assign(self, { nav, host });
}
type Browser = ReturnType<typeof browser>;

/** A, then a finished client navigation to B. */
async function atB(): Promise<Browser> {
  const b = browser();
  await b.click(B);
  await b.requests[0].answer(response({ body: "<b>" }));
  b.take();
  return b;
}

Deno.test("a click: start event, scroll remembered, entry pushed, fetch, swap, top, end event", async () => {
  const b = browser();
  b.scroll = [0, 640];
  assertEquals(await b.click(B), true);
  assertEquals(b.take(), [
    `fu:nav-start ${A} -> ${B}`,
    `replaceState {"fu":[0,640]}`,
    `pushState ${B} {"fu":[0,0]}`,
    `fetch ${B}?fu-partial=1&__b=b1`,
  ]);
  await b.requests[0].answer(response({ body: "<b>" }));
  assertEquals(b.take(), ["commit <b>", "scrollTo 0,0", `fu:nav ${A} -> ${B}`]);
  assertEquals(b.entries, [{ url: A, state: FU(0, 640) }, { url: B, state: FU() }]);
});

Deno.test("the scroll position is merged into the app's state, and a state it cannot merge into is left alone", async () => {
  const merged = browser();
  merged.entries[0].state = { rmShareSync: true, fu: [9, 9] };
  merged.scroll = [3, 9];
  await merged.click(B);
  assertEquals(merged.entries[0].state, { rmShareSync: true, fu: [3, 9] });

  // A state that is not a plain object is the app's whole: not overwritten.
  for (const theirs of ["text", 7, ["a"], true]) {
    const b = browser();
    b.entries[0].state = theirs;
    await b.click(B);
    assertEquals(b.entries[0].state, theirs, String(theirs));
    // The navigation itself is not affected.
    assertEquals(b.take().slice(0, 2), [
      `fu:nav-start ${A} -> ${B}`,
      `pushState ${B} {"fu":[0,0]}`,
    ]);
  }
  for (const empty of [null, undefined]) {
    const b = browser();
    b.entries[0].state = empty;
    b.scroll = [1, 2];
    await b.click(B);
    assertEquals(b.entries[0].state, FU(1, 2));
  }
});

Deno.test("a page without a build id sends no build param", async () => {
  const b = browser();
  const fetched: string[] = [];
  const nav = createNavigator({
    ...b.host,
    build: "",
    fetch: (url) => (fetched.push(url), new Promise(() => {})),
  });
  nav.click(B);
  await settle();
  assertEquals(fetched, [`${B}?fu-partial=1`]);
});

Deno.test("a destination with a fragment scrolls to its element, or to the top when there is none", async () => {
  const found = browser();
  found.anchors.add("#sec");
  await found.click(B + "#sec");
  await found.requests[0].answer();
  assertEquals(found.take().slice(-3), [
    "commit <html>",
    "scrollToHash #sec",
    `fu:nav ${A} -> ${B}#sec`,
  ]);

  const missing = browser();
  await missing.click(B + "#nope");
  await missing.requests[0].answer();
  assertEquals(missing.take().slice(-4), [
    "commit <html>",
    "scrollToHash #nope",
    "scrollTo 0,0",
    `fu:nav ${A} -> ${B}#nope`,
  ]);
});

Deno.test("a click on a link to the current URL touches no history entry", async () => {
  const b = browser();
  b.entries[0].state = { app: 1 };
  b.scroll = [0, 300];
  assertEquals(await b.click(A), true);
  assertEquals(b.take(), [`fu:nav-start ${A} -> ${A}`, `fetch ${A}?fu-partial=1&__b=b1`]);
  await b.requests[0].answer();
  assertEquals(b.take(), ["commit <html>", "scrollTo 0,0", `fu:nav ${A} -> ${A}`]);
  assertEquals(b.entries, [{ url: A, state: { app: 1 } }]);
});

Deno.test("a second click on a link whose page is already on its way starts nothing", async () => {
  const b = browser();
  await b.click(B);
  b.take();
  // Taken (the browser must not navigate either), and nothing happens.
  assertEquals(await b.click(B), true);
  assertEquals(b.take(), []);
  assertEquals([b.requests.length, b.requests[0].signal.aborted, b.entries.length], [1, false, 2]);
  await b.requests[0].answer();
  assertEquals(b.take().at(-1), `fu:nav ${A} -> ${B}`);
  // Once it has arrived, the same link is a refresh of the page on screen.
  await b.click(B);
  assertEquals(b.take(), [`fu:nav-start ${B} -> ${B}`, `fetch ${B}?fu-partial=1&__b=b1`]);
});

Deno.test("superseded mid-fetch: the earlier fetch is aborted and never swaps, whatever arrives", async () => {
  const b = browser();
  b.scroll = [0, 100];
  await b.click(B);
  b.take();
  await b.click(C);
  assertEquals(b.requests[0].signal.aborted, true);
  // B was never on screen: C is reached from A, and B's entry gets no scroll
  // position (what is on screen is still A's).
  assertEquals(b.take(), [
    `fu:nav-start ${A} -> ${C}`,
    `pushState ${C} {"fu":[0,0]}`,
    `fetch ${C}?fu-partial=1&__b=b1`,
  ]);
  assertEquals(b.entries.map((e) => [e.url, e.state]), [[A, FU(0, 100)], [B, FU()], [C, FU()]]);
  // A response that got through before the abort took hold changes nothing.
  await b.requests[0].answer(response({ body: "<b>" }));
  assertEquals(b.take(), []);
  await b.requests[1].answer(response({ body: "<c>" }));
  assertEquals(b.take(), ["commit <c>", "scrollTo 0,0", `fu:nav ${A} -> ${C}`]);
});

Deno.test("superseded while the body is still arriving: the earlier page is not swapped in", async () => {
  const b = browser();
  await b.click(B);
  let body = (_: string) => {};
  await b.requests[0].answer(response({ body: new Promise<string>((r) => body = r) }));
  await b.click(C);
  b.take();
  body("<b>");
  await settle();
  assertEquals(b.take(), []);
  await b.requests[1].answer(response({ body: "<c>" }));
  assertEquals(b.take(), ["commit <c>", "scrollTo 0,0", `fu:nav ${A} -> ${C}`]);
});

Deno.test("superseded mid-hydration: the swap stands, its end event is not sent, the next starts from it", async () => {
  const b = browser();
  let hydrated = () => {};
  b.commit = () => new Promise<void>((r) => hydrated = r);
  await b.click(B);
  await b.requests[0].answer(response({ body: "<b>" }));
  // B is on screen, its islands still loading.
  assertEquals(b.take().slice(-2), ["commit <b>", "scrollTo 0,0"]);
  b.commit = () => Promise.resolve();
  b.scroll = [0, 50];
  await b.click(C);
  // B was seen, so it is the page being left: scroll remembered, `from` is B.
  assertEquals(b.take(), [
    `fu:nav-start ${B} -> ${C}`,
    `replaceState {"fu":[0,50]}`,
    `pushState ${C} {"fu":[0,0]}`,
    `fetch ${C}?fu-partial=1&__b=b1`,
  ]);
  hydrated();
  await settle();
  assertEquals(b.take(), []);
  await b.requests[1].answer(response({ body: "<c>" }));
  assertEquals(b.take(), ["commit <c>", "scrollTo 0,0", `fu:nav ${B} -> ${C}`]);
});

Deno.test("the end event waits for the islands that arrived", async () => {
  const b = browser();
  let hydrated = () => {};
  b.commit = () => new Promise<void>((r) => hydrated = r);
  await b.click(B);
  await b.requests[0].answer();
  assertEquals(b.take().includes(`fu:nav ${A} -> ${B}`), false);
  hydrated();
  await settle();
  assertEquals(b.take(), [`fu:nav ${A} -> ${B}`]);
});

Deno.test("Back and Forward re-fetch without pushing and restore the position kept on the entry", async () => {
  const b = browser();
  b.scroll = [12, 640];
  await b.click(B);
  await b.requests[0].answer();
  b.take();
  // The user scrolls B; the position is kept once the scrolling settles.
  b.scroll = [0, 300];
  b.nav.remember();
  assertEquals(b.take(), [`replaceState {"fu":[0,300]}`]);

  await b.traverse(-1);
  assertEquals(b.take(), [`fu:nav-start ${B} -> ${A}`, `fetch ${A}?fu-partial=1&__b=b1`]);
  await b.requests[1].answer(response({ body: "<a>" }));
  assertEquals(b.take(), ["commit <a>", "scrollTo 12,640", `fu:nav ${B} -> ${A}`]);

  // Forward restores exactly as Back does: B was left by Back, not by a click.
  await b.traverse(+1);
  await b.requests[2].answer(response({ body: "<b>" }));
  assertEquals(b.take().slice(-3), ["commit <b>", "scrollTo 0,300", `fu:nav ${A} -> ${B}`]);
  assertEquals(b.entries.length, 2);
});

Deno.test("popstate does not depend on history.state: whatever an entry carries, another page is drawn", async () => {
  // An app may replaceState or pushState with its own state object at any
  // time. That must never leave one page on screen under another's URL.
  for (const state of [null, undefined, "text", 1, { rmShareSync: true }, { fu: "junk" }, [1]]) {
    const b = await atB();
    b.entries[0].state = state;
    await b.traverse(-1);
    assertEquals(
      b.take(),
      [`fu:nav-start ${B} -> ${A}`, `fetch ${A}?fu-partial=1&__b=b1`],
      JSON.stringify(state),
    );
    await b.requests[1].answer(response({ body: "<a>" }));
    // No position was kept there, so nothing is scrolled: the browser's own
    // restoration stands.
    assertEquals(b.take(), ["commit <a>", `fu:nav ${B} -> ${A}`], JSON.stringify(state));
  }
});

Deno.test("a kept position that is not two finite numbers is ignored", async () => {
  for (const fu of [[1], [1, 2, 3], ["1", 2], [NaN, 0], [0, Infinity], { 0: 1, 1: 2 }, 5]) {
    const b = await atB();
    b.entries[0].state = { fu };
    await b.traverse(-1);
    await b.requests[1].answer();
    assertEquals(b.take().some((l) => l.startsWith("scrollTo")), false, JSON.stringify(fu));
  }
});

Deno.test("popstate to an entry that names the page on screen draws nothing", async () => {
  const b = browser();
  // A fragment link: the browser pushes an entry and scrolls. Not ours.
  b.appPush(A + "#sec", null);
  b.appPush(A + "#other", null);
  await b.traverse(-1);
  await b.traverse(-1);
  await b.traverse(+2);
  assertEquals([b.take(), b.requests.length], [[], 0]);

  // An entry the app pushed for the same page, with its own state.
  b.appPush(A, { rmPlayback: 1 });
  await b.traverse(-1);
  await b.traverse(+1);
  assertEquals([b.take(), b.requests.length], [[], 0]);
});

Deno.test("an entry the app pushed under another path is a page like any other", async () => {
  const b = browser();
  b.appPush("http://x/a/play", { rmPlayback: 1 });
  // Back to the page that is on screen: nothing to draw.
  await b.traverse(-1);
  assertEquals(b.take(), []);
  // Forward to the URL the app pushed: the server decides what that page is.
  await b.traverse(+1);
  assertEquals(b.take(), [
    `fu:nav-start ${A} -> http://x/a/play`,
    "fetch http://x/a/play?fu-partial=1&__b=b1",
  ]);
});

Deno.test("an entry the app moved to another path with replaceState is still the page on screen", async () => {
  const b = browser();
  // The app renames the entry it is on (a share URL for the route being
  // edited), then pushes an entry of its own (playback).
  b.appReplace("http://x/share/h1", { rmShareSync: true });
  b.appPush("http://x/share/h1/play", { rmPlayback: 1 });
  // Back out of playback: the entry names what is on screen. Nothing is drawn.
  await b.traverse(-1);
  assertEquals([b.take(), b.requests.length], [[], 0]);
  // Forward into the pushed path is still a page like any other.
  await b.traverse(+1);
  assertEquals(b.take(), [
    "fu:nav-start http://x/share/h1 -> http://x/share/h1/play",
    "fetch http://x/share/h1/play?fu-partial=1&__b=b1",
  ]);
});

Deno.test("a query the app changed with replaceState is the page on screen as well", async () => {
  const b = await atB();
  b.appReplace(B + "?q=2", null);
  b.appPush(B + "?q=2#sec", null);
  await b.traverse(-1);
  assertEquals([b.take(), b.requests.length], [[], 1]);
  // And the page before it is still drawn on Back.
  await b.traverse(-1);
  assertEquals(b.take()[0], `fu:nav-start ${B}?q=2 -> ${A}`);
});

Deno.test("replaceState by the app while a navigation is pending does not move the page on screen", async () => {
  const b = browser();
  await b.click(B);
  b.take();
  // The address bar is on B's entry, A is on screen; the app rewrites the entry.
  b.appReplace(B + "?x=1", { app: 1 });
  await b.requests[0].answer(response({ body: "<b>" }));
  assertEquals(b.take(), ["commit <b>", "scrollTo 0,0", `fu:nav ${A} -> ${B}`]);
  // Back names A, which is no longer on screen: it is drawn.
  await b.traverse(-1);
  assertEquals(b.take(), [`fu:nav-start ${B} -> ${A}`, `fetch ${A}?fu-partial=1&__b=b1`]);

  // The same, abandoned by Back before the page arrived: A never left.
  const c = browser();
  await c.click(B);
  c.appReplace(B + "?x=1", null);
  c.take();
  await c.traverse(-1);
  assertEquals(c.take(), [`fu:nav ${A} -> ${A}`]);
});

Deno.test("only the fragment is ignored when comparing pages: the query counts", async () => {
  const b = browser(A + "?q=1#top");
  b.appPush(A + "?q=2#top", null);
  await b.traverse(-1);
  assertEquals(b.take(), []);
  await b.traverse(+1);
  assertEquals(b.take()[0], `fu:nav-start ${A}?q=1#top -> ${A}?q=2#top`);
});

Deno.test("Back during a pending forward fetch: the fetch is aborted, nothing is drawn, the navigation is ended", async () => {
  const b = browser();
  b.scroll = [0, 200];
  await b.click(B);
  b.take();
  await b.traverse(-1);
  assertEquals(b.requests[0].signal.aborted, true);
  // A never left the screen. No fetch; but whoever heard the start is told
  // it is over, on the page it started from.
  assertEquals(b.take(), [`fu:nav ${A} -> ${A}`]);
  assertEquals(b.requests.length, 1);
  await b.requests[0].answer(response({ body: "<b>" }));
  assertEquals(b.take(), []);
  // And the navigator is not stuck: the next click is a plain navigation.
  await b.click(C);
  assertEquals(b.take()[0], `fu:nav-start ${A} -> ${C}`);
});

Deno.test("Forward during a pending Back, and a click during a pending Back", async () => {
  const b = await atB();
  await b.traverse(-1);
  b.take();
  // Forward before A arrived: B is still on screen, so only A's fetch ends.
  await b.traverse(+1);
  assertEquals(b.requests[1].signal.aborted, true);
  assertEquals(b.take(), [`fu:nav ${B} -> ${B}`]);

  await b.traverse(-1);
  b.take();
  b.scroll = [0, 77];
  // A click while A is on its way: the entry (A) was not drawn, so the scroll
  // of what is on screen (B) is not written onto it.
  await b.click(C);
  assertEquals(b.requests[2].signal.aborted, true);
  assertEquals(b.take(), [
    `fu:nav-start ${B} -> ${C}`,
    `pushState ${C} {"fu":[0,0]}`,
    `fetch ${C}?fu-partial=1&__b=b1`,
  ]);
  assertEquals(b.entries.map((e) => e.url), [A, C]);
});

Deno.test("remember keeps the position on the current entry, but never while the address bar is ahead of the page", async () => {
  const b = browser();
  b.entries[0].state = { app: 1 };
  b.scroll = [0, 10];
  b.nav.remember();
  assertEquals(b.entries[0].state, { app: 1, fu: [0, 10] });
  b.take();

  // A fetch is pending: the entry is B's, the page on screen is A's.
  await b.click(B);
  b.take();
  b.scroll = [0, 999];
  b.nav.remember();
  assertEquals([b.take(), b.entries[1].state], [[], FU()]);

  // Swapped in, islands still loading: the page on screen is B.
  let hydrated = () => {};
  b.commit = () => new Promise<void>((r) => hydrated = r);
  await b.requests[0].answer();
  b.take();
  b.scroll = [0, 40];
  b.nav.remember();
  assertEquals(b.entries[1].state, FU(0, 40));
  hydrated();
  await settle();

  // A state the app owns whole is not written over.
  b.entries[1].state = "theirs";
  b.nav.remember();
  assertEquals(b.entries[1].state, "theirs");
});

Deno.test("remember survives a browser that refuses the history write", () => {
  const b = browser();
  const nav = createNavigator({
    ...b.host,
    replaceState: () => {
      throw new DOMException("too many calls", "SecurityError");
    },
  });
  nav.remember();
});

/** Every way a fetched page can turn out not to be swappable. */
const failures: Record<string, (b: Browser, n: number) => Promise<void>> = {
  "fu: the server asked for a full load": (b, n) =>
    b.requests[n].answer(response({ headers: { "x-fu-reload": "1" } })),
  "fu: the server answered 404": (b, n) =>
    b.requests[n].answer(response({ ok: false, status: 404 })),
  "fu: the server answered 503": (b, n) =>
    b.requests[n].answer(response({ ok: false, status: 503 })),
  "fu: the answer is not HTML": (b, n) =>
    b.requests[n].answer(response({ headers: { "content-type": "application/pdf" } })),
  "fu: the page's regions or build differ": (b, n) => {
    b.commit = () => null;
    return b.requests[n].answer();
  },
  "Failed to fetch": (b, n) => b.requests[n].fail(new TypeError("Failed to fetch")),
  "body cut short": (b, n) =>
    b.requests[n].answer(response({ body: Promise.reject(new Error("body cut short")) })),
  "swap blew up": (b, n) => {
    b.commit = () => {
      throw new Error("swap blew up");
    };
    return b.requests[n].answer();
  },
  "island chunk gone": (b, n) => {
    b.commit = () => Promise.reject(new Error("island chunk gone"));
    return b.requests[n].answer();
  },
};
const loads = (log: string[]) =>
  log.filter((l) => !l.startsWith("commit") && !l.startsWith("scrollTo"));

Deno.test("every failure after a click is announced, then replaces the pushed entry with a full load", async () => {
  for (const [why, fail] of Object.entries(failures)) {
    const b = browser();
    await b.click(B);
    b.take();
    await fail(b, 0);
    assertEquals(
      loads(b.take()),
      [`fu:nav-error ${A} -> ${B} (${why})`, `location.replace ${B}`],
      why,
    );
    // Exactly one entry was pushed, and replace (never assign, never reload)
    // keeps it at one: Back goes to A, not to B a second time.
    assertEquals(b.entries.map((e) => e.url), [A, B], why);
  }
});

Deno.test("every failure after Back or Forward reloads, since no entry was pushed", async () => {
  for (const [why, fail] of Object.entries(failures)) {
    const b = await atB();
    await b.traverse(-1);
    b.take();
    await fail(b, 1);
    assertEquals(
      loads(b.take()),
      [`fu:nav-error ${B} -> ${A} (${why})`, "location.reload"],
      why,
    );
  }
});

Deno.test("a redirect is loaded in full at the URL it ended on, one request instead of two hops", async () => {
  const why = "(fu: the request was redirected)";
  // After a click: the pushed entry is replaced by the final URL.
  const b = browser();
  await b.click("http://x/old#sec");
  b.take();
  await b.requests[0].answer(
    response({ redirected: true, url: "http://x/new?fu-partial=1&__b=b1" }),
  );
  assertEquals(b.take(), [
    `fu:nav-error ${A} -> http://x/old#sec ${why}`,
    "location.replace http://x/new#sec",
  ]);

  // After Back: nothing was pushed, and the entry's URL is the one that
  // redirects; replacing it with the final URL is what a reload would end in.
  const back = await atB();
  await back.traverse(-1);
  back.take();
  await back.requests[1].answer(response({ redirected: true, url: "http://x/moved?fu-partial=1" }));
  assertEquals(back.take(), [
    `fu:nav-error ${B} -> ${A} ${why}`,
    "location.replace http://x/moved",
  ]);
});

Deno.test("a redirect that left the origin, or whose end is unknown, loads the original and lets the browser follow", async () => {
  for (const url of ["http://evil/new?fu-partial=1", "https://x/new", ""]) {
    const b = browser();
    await b.click(B);
    b.take();
    await b.requests[0].answer(response({ redirected: true, url }));
    assertEquals(b.take().at(-1), `location.replace ${B}`, url);

    const back = await atB();
    await back.traverse(-1);
    back.take();
    await back.requests[1].answer(response({ redirected: true, url }));
    assertEquals(back.take().at(-1), "location.reload", url);
  }
});

Deno.test("a refused response is not read: its fetch is aborted before the full load", async () => {
  const b = browser();
  await b.click(B);
  let read = false;
  await b.requests[0].answer({
    ...response({ headers: { "content-type": "application/pdf" } }),
    text: () => (read = true, Promise.resolve("%PDF")),
  });
  assertEquals([read, b.requests[0].signal.aborted], [false, true]);
});

Deno.test("an aborted fetch is not a failure: no error event, no full load", async () => {
  const b = browser();
  await b.click(B);
  await b.click(C);
  b.nav.stop();
  await settle();
  const log = b.take();
  assertEquals(log.filter((l) => l.startsWith("fu:nav-error") || l.startsWith("location.")), []);
});

Deno.test("once a full load is on its way nothing more is intercepted or written", async () => {
  const b = await atB();
  await b.click(C);
  await b.requests[1].answer(response({ ok: false, status: 500 }));
  b.take();
  // The browser gets the click, and navigates in full over the pending replace.
  assertEquals(await b.click(A), false);
  b.nav.remember();
  assertEquals(b.take(), []);
  // Back before the load commits is a same-document popstate. To the page
  // that is on screen (B): nothing to do. To another (A): reload there.
  await b.traverse(-1);
  assertEquals(b.take(), []);
  await b.traverse(-1);
  assertEquals(b.take(), ["location.reload"]);
  assertEquals(b.requests.length, 2);
});

Deno.test("a live page without sound regions is not navigated on the client at all", async () => {
  const b = browser();
  b.ready = false;
  assertEquals(await b.click(B), false);
  assertEquals(b.take(), []);
  assertEquals([b.entries.length, b.requests.length], [1, 0]);
});

Deno.test("a history call that throws is a failure like any other", async () => {
  const b = browser();
  const log: string[] = [];
  const nav = createNavigator({
    ...b.host,
    pushState: () => {
      throw new DOMException("too many calls", "SecurityError");
    },
    replace: (url) => void log.push(`location.replace ${url}`),
    emit: (type, d) => void log.push(`${type} ${(d.error as Error | undefined)?.message ?? ""}`),
    fetch: () => (log.push("fetch"), new Promise(() => {})),
  });
  // Taken all the same: the full load that follows is the navigation.
  assertEquals(nav.click(B), true);
  await settle();
  assertEquals(log, ["fu:nav-start ", "fu:nav-error too many calls", `location.replace ${B}`]);
});

Deno.test("stop abandons the pending navigation: a late answer is not swapped in", async () => {
  const b = browser();
  await b.click(B);
  b.take();
  b.nav.stop();
  assertEquals(b.requests[0].signal.aborted, true);
  await b.requests[0].answer();
  assertEquals(b.take(), []);
});

Deno.test("`from` follows a fragment the browser moved to on its own", async () => {
  const b = browser();
  // A click on #sec is the browser's: a new entry, no state, no event for us.
  b.appPush(A + "#sec", null);
  await b.click(B);
  assertEquals(b.take()[0], `fu:nav-start ${A}#sec -> ${B}`);
});
