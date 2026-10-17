import { assertEquals } from "@std/assert";
import { Component, render } from "preact";
import {
  componentOf,
  HYDRATED_ATTR,
  HYDRATED_EVENT,
  hydrateIslands,
  markHydrated,
  splitKey,
} from "./client.ts";

// Hydration itself needs a DOM and is checked in a real browser by
// scripts/check-browser.mjs; these are the parts that are plain functions,
// and which elements get hydrated, against stand-in elements just real enough
// for Preact to hydrate a component that renders nothing.

Deno.test("an island key names a file and, after #, the export", () => {
  assertEquals(splitKey("/islands/Counter.tsx"), ["/islands/Counter.tsx", "default"]);
  assertEquals(splitKey("/islands/W.tsx#Toggle"), ["/islands/W.tsx", "Toggle"]);
  // The server stamps exactly one #, but a file name may hold one too.
  assertEquals(splitKey("/islands/a/b.tsx#X#Y"), ["/islands/a/b.tsx", "X#Y"]);
});

Deno.test("only a function export counts as a component", () => {
  const Named = () => null;
  const mod = { default: () => null, Named, count: 3, nothing: undefined };
  assertEquals(componentOf(mod, "Named"), Named);
  assertEquals(typeof componentOf(mod, "default"), "function");
  // A half-written save can leave the export missing or not yet a function;
  // the hot swap keeps the old implementation when this says null.
  assertEquals(componentOf(mod, "count"), null);
  assertEquals(componentOf(mod, "nothing"), null);
  assertEquals(componentOf(mod, "missing"), null);
});

const globals = globalThis as Record<string, unknown>;
globals.__FU_HMR__ = false;

/** An element as far as client.ts and a null-rendering hydrate need one. */
class FakeEl {
  dataset: Record<string, string> = {};
  nodeType = 1;
  firstChild = null;
  childNodes: unknown[] = [];
  namespaceURI = "http://www.w3.org/1999/xhtml";
  isConnected = true;
  constructor(island: string, id: string) {
    this.dataset.island = island;
    this.dataset.props = JSON.stringify({ id });
  }
}
const els = (...list: FakeEl[]) => list as unknown as HTMLElement[];

/** An island module whose component logs its mount and unmount, and a log to read. */
function tracker(): { log: string[]; mod: Record<string, unknown> } {
  const log: string[] = [];
  class Tracked extends Component<{ id: string }> {
    override componentDidMount() {
      log.push("mount " + this.props.id);
    }
    override componentWillUnmount() {
      log.push("unmount " + this.props.id);
    }
    render() {
      return null;
    }
  }
  return { log, mod: { default: Tracked } };
}

Deno.test("hydrateIslands hydrates exactly the elements it is given, in order", async () => {
  const { log, mod } = tracker();
  const manifest = { "/islands/T.tsx": () => Promise.resolve(mod) };
  const a = new FakeEl("/islands/T.tsx", "a");
  const b = new FakeEl("/islands/T.tsx", "b");
  const c = new FakeEl("/islands/T.tsx", "c");
  await hydrateIslands(manifest, els(b, a));
  assertEquals(log, ["mount b", "mount a"]);
  // What a navigation does with the islands that arrived: only those.
  await hydrateIslands(manifest, els(c));
  assertEquals(log, ["mount b", "mount a", "mount c"]);
  await hydrateIslands(manifest, els());
  assertEquals(log.length, 3);
});

Deno.test("the default is every marker in the document", async () => {
  const { log, mod } = tracker();
  const a = new FakeEl("/islands/T.tsx", "a");
  const asked: string[] = [];
  globals.document = {
    querySelectorAll: (selector: string) => (asked.push(selector), [a]),
  };
  try {
    await hydrateIslands({ "/islands/T.tsx": () => Promise.resolve(mod) });
  } finally {
    delete globals.document;
  }
  assertEquals([asked, log], [["[data-island]"], ["mount a"]]);
});

Deno.test("an element removed while its island module was loading is not hydrated", async () => {
  // A navigation superseded mid-hydration: the nodes it brought are gone
  // before their chunk arrives. Mounting into them would start effects on a
  // node that left the document, which nothing would ever unmount.
  const { log, mod } = tracker();
  let release = (_: Record<string, unknown>) => {};
  const loading = new Promise<Record<string, unknown>>((r) => release = r);
  const gone = new FakeEl("/islands/T.tsx", "gone");
  const kept = new FakeEl("/islands/T.tsx", "kept");
  const pending = hydrateIslands({ "/islands/T.tsx": () => loading }, els(gone, kept));
  gone.isConnected = false;
  release(mod);
  await pending;
  assertEquals(log, ["mount kept"]);
});

Deno.test("render(null) on its element is all it takes to unmount a hydrated island", async () => {
  // The navigation runtime relies on this, and on it being harmless for an
  // element that never held an island: it keeps no list of what was hydrated.
  const { log, mod } = tracker();
  const a = new FakeEl("/islands/T.tsx", "a");
  const never = new FakeEl("/islands/T.tsx", "never");
  await hydrateIslands({ "/islands/T.tsx": () => Promise.resolve(mod) }, els(a));
  render(null, a as unknown as HTMLElement);
  render(null, never as unknown as HTMLElement);
  assertEquals(log, ["mount a", "unmount a"]);
});

Deno.test("in dev, a hot swap does not render into an element that left the document", async () => {
  globals.__FU_HMR__ = true;
  try {
    const renders: string[] = [];
    const v1 = ({ id }: { id: string }) => (renders.push("v1 " + id), null);
    const v2 = ({ id }: { id: string }) => (renders.push("v2 " + id), null);
    const manifest = { "/islands/H.tsx": () => Promise.resolve({ default: v1 }) };
    const gone = new FakeEl("/islands/H.tsx", "gone");
    const kept = new FakeEl("/islands/H.tsx", "kept");
    await hydrateIslands(manifest, els(gone, kept));
    assertEquals(renders, ["v1 gone", "v1 kept"]);
    // A navigation swapped it out.
    gone.isConnected = false;
    renders.length = 0;
    const debug = console.debug;
    console.debug = () => {};
    const swap = globals.__fu_hmr__ as (file: string, mod: unknown) => void;
    try {
      swap("/islands/H.tsx", { default: v2 });
      // And it is forgotten, not merely skipped: no growth over a session.
      gone.isConnected = true;
      swap("/islands/H.tsx", { default: v1 });
    } finally {
      console.debug = debug;
    }
    assertEquals(renders, ["v2 kept", "v1 kept"]);
  } finally {
    globals.__FU_HMR__ = false;
    delete globals.__fu_hmr__;
  }
});

/** A document and a window event log, just real enough for markHydrated. */
function watchHydrated(): { seen: string[]; restore: () => void } {
  const seen: string[] = [];
  globals.document = {
    documentElement: {
      setAttribute: (k: string, v: string) => seen.push(`attr ${k}="${v}"`),
    },
  };
  const on = () => seen.push("event");
  addEventListener(HYDRATED_EVENT, on);
  return {
    seen,
    restore: () => {
      removeEventListener(HYDRATED_EVENT, on);
      delete globals.document;
    },
  };
}

Deno.test("the hydration signal is an empty data attribute and a plain window event", () => {
  assertEquals([HYDRATED_ATTR, HYDRATED_EVENT], ["data-fu-hydrated", "fu:hydrated"]);
  const w = watchHydrated();
  let event: Event | undefined;
  const grab = (e: Event) => event = e;
  addEventListener(HYDRATED_EVENT, grab);
  try {
    markHydrated();
  } finally {
    removeEventListener(HYDRATED_EVENT, grab);
    w.restore();
  }
  assertEquals(w.seen, ['attr data-fu-hydrated=""', "event"]);
  assertEquals([event?.type, event?.constructor === Event], ["fu:hydrated", true]);
});

Deno.test("the signal comes after the islands are hydrated, and also when there are none", async () => {
  const { log, mod } = tracker();
  const manifest = { "/islands/T.tsx": () => Promise.resolve(mod) };
  const w = watchHydrated();
  try {
    await hydrateIslands(manifest, els(new FakeEl("/islands/T.tsx", "a"))).then(markHydrated);
    assertEquals(log, ["mount a"]);
    assertEquals(w.seen.length, 2);
    await hydrateIslands(manifest, els()).then(markHydrated);
    assertEquals(w.seen.length, 4);
  } finally {
    w.restore();
  }
});

Deno.test("a failing island does not hold the signal back, nor the other islands", async () => {
  const { log, mod } = tracker();
  const manifest = {
    "/islands/T.tsx": () => Promise.resolve(mod),
    "/islands/Gone.tsx": () => Promise.reject(new Error("chunk 404")),
    "/islands/Bad.tsx": () => Promise.resolve({ default: () => null }),
  };
  const bad = new FakeEl("/islands/Bad.tsx", "bad");
  bad.dataset.props = "{not json";
  const w = watchHydrated();
  const error = console.error;
  const warn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    await hydrateIslands(
      manifest,
      els(new FakeEl("/islands/Gone.tsx", "g"), bad, new FakeEl("/islands/T.tsx", "ok")),
    ).then(markHydrated);
  } finally {
    console.error = error;
    console.warn = warn;
    w.restore();
  }
  assertEquals(log, ["mount ok"]);
  assertEquals(w.seen, ['attr data-fu-hydrated=""', "event"]);
});
