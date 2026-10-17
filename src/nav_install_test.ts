// The one part of `installNav` that can be checked without a DOM: how it sits
// on `history`. Stand-ins for the globals it reads; the rest of the host runs
// in a real browser.
import { assertEquals, assertNotStrictEquals, assertStrictEquals } from "@std/assert";
import { installNav } from "./nav.ts";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Put stand-ins on globalThis for one test; the returned function takes them off again. */
function globals(values: Record<string, unknown>): () => void {
  const saved = Object.keys(values).map((k) =>
    [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const
  );
  for (const [k, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
}

function fakeBrowser() {
  const location = { href: "http://x/a" };
  const fetched: string[] = [];
  const history = {
    state: null as unknown,
    replaceState(state: unknown, _unused: string, url?: string | null): void {
      history.state = state;
      if (url != null) location.href = new URL(url, location.href).href;
    },
    pushState(state: unknown, _unused: string, url?: string | null): void {
      history.state = state;
      if (url != null) location.href = new URL(url, location.href).href;
    },
  };
  const restore = globals({
    location,
    history,
    scrollX: 0,
    scrollY: 120,
    document: {
      documentElement: { getAttribute: () => null },
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: (url: string) => {
      fetched.push(String(url));
      return new Promise(() => {});
    },
  });
  /** Back or Forward to an entry. */
  const traverse = async (href: string, state: unknown): Promise<void> => {
    location.href = href;
    history.state = state;
    dispatchEvent(new Event("popstate"));
    await wait(0);
  };
  return { location, history, fetched, restore, traverse };
}

Deno.test("installNav follows the app's replaceState, but neither pushState nor its own scroll stamp", async () => {
  const b = fakeBrowser();
  const native = b.history.replaceState;
  const uninstall = installNav({});
  try {
    assertNotStrictEquals(b.history.replaceState, native);
    // The app renames the entry it is on, then pushes one of its own.
    b.history.replaceState({ rmShareSync: true }, "", "/share/h1");
    assertEquals(b.location.href, "http://x/share/h1");
    b.history.pushState({ play: 1 }, "", "/share/h1/play");
    // The user scrolls there: fu stamps the position on the entry. That write
    // must not make the pushed URL the page on screen.
    dispatchEvent(new Event("scroll"));
    await wait(200);
    assertEquals(b.history.state, { play: 1, fu: [0, 120] });
    // Back out of the pushed entry: what is on screen is what the entry names.
    await b.traverse("http://x/share/h1", { rmShareSync: true });
    assertEquals(b.fetched, []);
    // Forward into it: another path, so the server is asked.
    await b.traverse("http://x/share/h1/play", { play: 1 });
    assertEquals(b.fetched, ["http://x/share/h1/play?fu-partial=1"]);
  } finally {
    uninstall();
    assertStrictEquals(b.history.replaceState, native);
    b.restore();
  }
});

Deno.test("uninstalling leaves a wrapper the app put on top of fu's in place, and working", () => {
  const b = fakeBrowser();
  const native = b.history.replaceState;
  const uninstall = installNav({});
  try {
    const fus = b.history.replaceState;
    let seen = 0;
    const apps = function (this: unknown, ...args: Parameters<typeof native>): void {
      seen++;
      return fus.apply(this, args);
    };
    b.history.replaceState = apps;
    uninstall();
    assertStrictEquals(b.history.replaceState, apps);
    b.history.replaceState({ x: 1 }, "", "/other");
    assertEquals([seen, b.location.href, b.history.state], [1, "http://x/other", { x: 1 }]);
  } finally {
    b.restore();
  }
});
