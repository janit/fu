import { assertEquals } from "@std/assert";
import {
  type ElementLike,
  findRegions,
  interceptTarget,
  isExecutableScript,
  matchRegions,
  type NavResponse,
  type NodeLike,
  partialUrl,
  planSwap,
  redirectTarget,
  refusal,
  scriptAction,
  soundRegions,
} from "./nav.ts";

Deno.test("only classic and module scripts are re-executed after a swap; data scripts are not", () => {
  for (const t of [null, "", "text/javascript", "TEXT/JAVASCRIPT", "module", " module "]) {
    assertEquals(isExecutableScript(t), true, String(t));
  }
  for (const t of ["application/ld+json", "importmap", "text/template", "speculationrules"]) {
    assertEquals(isExecutableScript(t), false, t);
  }
});

Deno.test("partialUrl adds the partial and build params and keeps the rest", () => {
  assertEquals(
    partialUrl("http://x/a/b?q=1#top", "v26"),
    "http://x/a/b?q=1&fu-partial=1&__b=v26#top",
  );
  assertEquals(partialUrl("http://x/", ""), "http://x/?fu-partial=1");
});

function anchor(
  href: string,
  nav: string | null,
  extra: Partial<{ target: string; download: boolean; rel: string }> = {},
) {
  return {
    href,
    target: extra.target ?? "",
    rel: extra.rel,
    hasAttribute: (n: string) => n === "download" && !!extra.download,
    closest: (_sel: string) => nav === null ? null : { getAttribute: () => nav },
  };
}
const click = (over: Partial<Parameters<typeof interceptTarget>[1]> = {}) => ({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  ...over,
});
const HERE = "http://x/from?a=1";

Deno.test("a plain same-origin left click inside an enabled region is intercepted", () => {
  assertEquals(interceptTarget(anchor("http://x/to", "on"), click(), HERE), "http://x/to");
  assertEquals(interceptTarget(anchor("/rel", "anything"), click(), HERE), "http://x/rel");
});

Deno.test("the nearest data-fu-nav decides: off wins inside an on body, and no attribute means no", () => {
  assertEquals(interceptTarget(anchor("http://x/to", "off"), click(), HERE), null);
  assertEquals(interceptTarget(anchor("http://x/to", null), click(), HERE), null);
});

Deno.test("modifier keys, other buttons, targets, downloads, cross-origin and hash-only clicks are left alone", () => {
  const a = anchor("http://x/to", "on");
  assertEquals(interceptTarget(a, click({ button: 1 }), HERE), null);
  assertEquals(interceptTarget(a, click({ metaKey: true }), HERE), null);
  assertEquals(interceptTarget(a, click({ ctrlKey: true }), HERE), null);
  assertEquals(interceptTarget(a, click({ shiftKey: true }), HERE), null);
  assertEquals(interceptTarget(a, click({ altKey: true }), HERE), null);
  assertEquals(interceptTarget(a, click({ defaultPrevented: true }), HERE), null);
  assertEquals(
    interceptTarget(anchor("http://x/to", "on", { target: "_blank" }), click(), HERE),
    null,
  );
  assertEquals(
    interceptTarget(anchor("http://x/to", "on", { download: true }), click(), HERE),
    null,
  );
  assertEquals(interceptTarget(anchor("http://evil/to", "on"), click(), HERE), null);
  assertEquals(interceptTarget(anchor("http://x/from?a=1#sec", "on"), click(), HERE), null);
  assertEquals(interceptTarget(null, click(), HERE), null);
  // A different page with a hash is a navigation.
  assertEquals(interceptTarget(anchor("http://x/to#sec", "on"), click(), HERE), "http://x/to#sec");
});

Deno.test("a link to the page itself is a refresh, but any fragment on it is the browser's", () => {
  // No fragment at all: the browser would reload; fetch and swap instead.
  assertEquals(interceptTarget(anchor(HERE, "on"), click(), HERE), HERE);
  assertEquals(interceptTarget(anchor("", "on"), click(), HERE), HERE);
  // From a fragment back to the bare page is a load too, not a scroll.
  assertEquals(interceptTarget(anchor(HERE, "on"), click(), HERE + "#sec"), HERE);
  // `href="#"` has an empty fragment, which URL.hash reports as "": still a
  // fragment navigation (scroll to top), and never a refetch of the page.
  assertEquals(interceptTarget(anchor(HERE + "#", "on"), click(), HERE), null);
  assertEquals(interceptTarget(anchor("#", "on"), click(), HERE), null);
  assertEquals(interceptTarget(anchor("#", "on"), click(), HERE + "#sec"), null);
  assertEquals(interceptTarget(anchor(HERE + "#other", "on"), click(), HERE + "#sec"), null);
});

Deno.test("only _self among targets, and never rel=external", () => {
  const to = "http://x/to";
  assertEquals(interceptTarget(anchor(to, "on", { target: "_self" }), click(), HERE), to);
  for (const target of ["_blank", "_top", "_parent", "frame"]) {
    assertEquals(interceptTarget(anchor(to, "on", { target }), click(), HERE), null, target);
  }
  for (const rel of ["external", "noopener EXTERNAL", "nofollow\texternal\n"]) {
    assertEquals(interceptTarget(anchor(to, "on", { rel }), click(), HERE), null, rel);
  }
  for (const rel of ["", "nofollow noopener", "externals"]) {
    assertEquals(interceptTarget(anchor(to, "on", { rel }), click(), HERE), to, rel);
  }
});

Deno.test("only http(s) URLs of this exact origin are navigations", () => {
  for (
    const href of [
      "https://x/to", // other scheme
      "http://x:8080/to", // other port
      "http://sub.x/to",
      "mailto:a@x",
      "tel:+358401234567",
      "javascript:void(0)",
      // A blob URL has the origin of the page that made it, and is not a page.
      "blob:http://x/0f0e3b7c-5a0b-4b6e-9b1f-3c1c5f1d2a11",
      "data:text/html,hi",
      "http://[",
    ]
  ) {
    assertEquals(interceptTarget(anchor(href, "on"), click(), HERE), null, href);
  }
});

Deno.test("an SVG link, whose href is not a string, is left to the browser", () => {
  const svg = { ...anchor("", "on"), href: { baseVal: "/to", animVal: "/to" }, target: {} };
  assertEquals(interceptTarget(svg as never, click(), HERE), null);
  // Even one whose target would not have stopped it.
  const bare = { ...anchor("", "on"), href: { baseVal: "/to", animVal: "/to" } };
  assertEquals(interceptTarget(bare as never, click(), HERE), null);
});

Deno.test("data-fu-nav enables with any value but off, the bare attribute included", () => {
  for (const value of ["", "on", "true", "1", "OFF"]) {
    assertEquals(
      interceptTarget(anchor("http://x/to", value), click(), HERE),
      "http://x/to",
      value,
    );
  }
});

Deno.test("every JavaScript MIME type a full load would run is re-executed", () => {
  for (
    const t of [
      "application/javascript",
      "application/x-javascript",
      "text/ecmascript",
      "application/ecmascript",
      "text/x-javascript",
      "Text/JavaScript",
    ]
  ) assertEquals(isExecutableScript(t), true, t);
  for (
    const t of [
      "application/json",
      "text/plain",
      "text/babel",
      "text/partytown",
      "module-shim",
      "javascript",
      "text/javascript; charset=utf-8",
    ]
  ) assertEquals(isExecutableScript(t), false, t);
});

/** A flat node list: comments (8), elements (1) and text (3), linked as siblings. */
function list(items: Array<[number, string]>): NodeLike {
  const root: NodeLike = { nodeType: 9, nextSibling: null, firstChild: null, parentNode: null };
  let prev: NodeLike | null = null;
  for (const [nodeType, data] of items) {
    const n: NodeLike = { nodeType, data, nextSibling: null, firstChild: null, parentNode: root };
    if (prev) prev.nextSibling = n;
    else root.firstChild = n;
    prev = n;
  }
  return root;
}

Deno.test("findRegions pairs each opening comment with its closing one, nesting respected", () => {
  const root = list([
    [1, "title"],
    [8, "fu:p:head-dynamic"],
    [1, "meta"],
    [8, "/fu:p"],
    [3, "text"],
    [8, "fu:p:content"],
    [8, "fu:p:inner"],
    [8, "/fu:p"],
    [1, "p"],
    [8, "/fu:p"],
    [8, "fu:p:unclosed"],
    [1, "b"],
  ]);
  const regions = findRegions(root);
  assertEquals([...regions.keys()], ["head-dynamic", "content"]);
  const head = regions.get("head-dynamic")!;
  assertEquals(head.start.data, "fu:p:head-dynamic");
  assertEquals(head.end.data, "/fu:p");
  assertEquals(head.start.nextSibling?.data, "meta");
  const content = regions.get("content")!;
  // The inner region belongs to the outer one and is not listed on its own.
  assertEquals(content.end.nextSibling?.data, "fu:p:unclosed");
});

Deno.test("findRegions descends into children and ignores comments that are not markers", () => {
  const html: NodeLike = {
    nodeType: 1,
    data: "html",
    nextSibling: null,
    firstChild: null,
    parentNode: null,
  };
  const head = list([[8, "a comment"], [8, "fu:p:head-dynamic"], [1, "title"], [8, "/fu:p"]]);
  head.nodeType = 1;
  head.parentNode = html;
  html.firstChild = head;
  const body = list([[8, "fu:p:content"], [1, "main"], [8, "/fu:p"]]);
  body.nodeType = 1;
  body.parentNode = html;
  head.nextSibling = body;
  const doc: NodeLike = { nodeType: 9, nextSibling: null, firstChild: html, parentNode: null };
  assertEquals([...findRegions(doc).keys()], ["head-dynamic", "content"]);
});

Deno.test("comments that only resemble markers are not markers", () => {
  // Each followed by a real closing marker, so only the opening one decides.
  const openers: Array<[number, string]> = [
    [8, "fu:p:"],
    [8, "fu:p:Content"],
    [8, " fu:p:content "],
    [8, "fu:p:content "],
    [8, "fu:p:content\n"],
    [8, "fu:p:9lives"],
    [8, "fu:p:a b"],
    // The server's name grammar exactly: no trailing or doubled hyphen.
    [8, "fu:p:a-"],
    [8, "fu:p:a--b"],
    [8, "fu:p:-a"],
    [3, "fu:p:content"],
    [1, "fu:p:content"],
  ];
  for (const opener of openers) {
    const root = list([opener, [1, "p"], [8, "/fu:p"]]);
    assertEquals(findRegions(root).size, 0, JSON.stringify(opener));
  }
  // And a closing marker must be exact too.
  for (const closer of ["/fu:p ", " /fu:p", "/fu:p\n", "/FU:P", "/fu:p:content"]) {
    const root = list([[8, "fu:p:content"], [1, "p"], [8, closer]]);
    assertEquals(findRegions(root).size, 0, JSON.stringify(closer));
  }
  assertEquals(findRegions(list([[8, "fu:p:a1-b2"], [8, "/fu:p"]])).size, 1);
});

/** A document: <html> holding a <head> and a <body>, each a flat node list. */
function page(head: Array<[number, string]>, body: Array<[number, string]>): NodeLike {
  const html: NodeLike = {
    nodeType: 1,
    data: "html",
    nextSibling: null,
    firstChild: null,
    parentNode: null,
  };
  const h = Object.assign(list(head), { nodeType: 1, data: "head", parentNode: html });
  const b = Object.assign(list(body), { nodeType: 1, data: "body", parentNode: html });
  html.firstChild = h;
  h.nextSibling = b;
  const doc: NodeLike = { nodeType: 9, nextSibling: null, firstChild: html, parentNode: null };
  html.parentNode = doc;
  return doc;
}
const HEAD: Array<[number, string]> = [[8, "fu:p:head-dynamic"], [1, "title"], [8, "/fu:p"]];
const BODY: Array<[number, string]> = [[1, "nav"], [8, "fu:p:content"], [1, "main"], [8, "/fu:p"]];

Deno.test("matchRegions pairs the regions by name, a region in <head> like one in <body>", () => {
  const live = page(HEAD, BODY);
  // The same names in another order and with other content between them.
  const next = page(
    [[1, "meta"], [8, "fu:p:head-dynamic"], [1, "title"], [1, "link"], [8, "/fu:p"]],
    [[8, "fu:p:content"], [8, "/fu:p"], [1, "footer"]],
  );
  const pairs = matchRegions(live, next)!;
  assertEquals(pairs.map(([a, b]) => [a.name, b.name]), [
    ["head-dynamic", "head-dynamic"],
    ["content", "content"],
  ]);
  const [headPair, bodyPair] = pairs;
  assertEquals(headPair[0].start.parentNode?.data, "head");
  assertEquals(headPair[1].start.parentNode?.data, "head");
  assertEquals(headPair[1].start.nextSibling?.data, "title");
  assertEquals(bodyPair[0].start.parentNode?.data, "body");
  // An empty region is still a region: the swap empties the live one.
  assertEquals(bodyPair[1].start.nextSibling, bodyPair[1].end);
});

Deno.test("matchRegions refuses two pages whose regions differ", () => {
  const live = () => page(HEAD, BODY);
  const cases: Record<string, [NodeLike, NodeLike]> = {
    "the live page has no region": [page([], [[1, "main"]]), live()],
    "the arrived page has none": [live(), page([], [[1, "main"]])],
    "a region is missing from the arrived page": [live(), page([], BODY)],
    "the arrived page has one more": [page([], BODY), live()],
    "same count, another name": [
      live(),
      page(HEAD, [[8, "fu:p:sidebar"], [1, "aside"], [8, "/fu:p"]]),
    ],
  };
  for (const [name, [a, b]] of Object.entries(cases)) assertEquals(matchRegions(a, b), null, name);
});

Deno.test("matchRegions refuses unsound markers on either side rather than swap half a page", () => {
  const sound = () => page(HEAD, BODY);
  const broken: Record<string, NodeLike> = {
    // What an element that is not allowed in <head> does: the parser moves the
    // rest of the region, closing marker included, into <body>.
    "a region opened in head and closed in body": page(
      [[8, "fu:p:head-dynamic"], [1, "title"]],
      [[1, "div"], [8, "/fu:p"], ...BODY],
    ),
    "an unclosed region": page(HEAD, [...BODY, [8, "fu:p:tail"], [1, "p"]]),
    "a closing marker on its own": page(HEAD, [[8, "/fu:p"], ...BODY]),
    "one name twice": page(HEAD, [...BODY, ...BODY]),
  };
  for (const [name, doc] of Object.entries(broken)) {
    assertEquals(matchRegions(doc, sound()), null, name + " (live)");
    assertEquals(matchRegions(sound(), doc), null, name + " (arrived)");
    // Even against itself: the two pages agree, and are both wrong.
    assertEquals(matchRegions(doc, doc), null, name + " (both)");
  }
});

/** A body with one element child that holds `inner`, between `before` and `after`. */
function deep(
  before: Array<[number, string]>,
  inner: Array<[number, string]>,
  after: Array<[number, string]>,
): NodeLike {
  const doc = page([], [...before, [1, "div"], ...after]);
  let div = doc.firstChild!.firstChild!.nextSibling!.firstChild!;
  while (div.data !== "div") div = div.nextSibling!;
  const kids = list(inner);
  div.firstChild = kids.firstChild;
  for (let k = kids.firstChild; k; k = k.nextSibling) k.parentNode = div;
  return doc;
}

Deno.test("soundRegions: a page is navigable only when its markers are beyond doubt", () => {
  // Region comments are the only thing that tells the client where a region
  // is, and raw HTML the app renders can contain them. Each of these is what
  // a forged or misplaced comment produces; each must mean a full page load.
  const open: [number, string] = [8, "fu:p:content"];
  const close: [number, string] = [8, "/fu:p"];
  const p: [number, string] = [1, "p"];
  const unsound: Record<string, NodeLike> = {
    "no region at all": page([], [p]),
    "a duplicate name": page([], [open, p, close, open, p, close]),
    "a duplicate name, one in head and one in body": page([open, close], [open, p, close]),
    "a region nested in a region": page([], [open, [8, "fu:p:inner"], p, close, close]),
    "a region nested under its own name": page([], [open, open, close, close]),
    "an opening marker never closed": page([], [open, p]),
    "an opening marker never closed, after a sound region": page(
      [],
      [open, p, close, [8, "fu:p:tail"], p],
    ),
    "a closing marker before any opening one": page([], [close, open, p, close]),
    "a closing marker too many": page([], [open, p, close, close]),
    // A forged pair inside a region's markup: the region would swap fine, but
    // nothing inside a region may look like a boundary.
    "a whole region deep inside a region": deep([open], [[8, "fu:p:x"], p, close], [close]),
    // A forged closing comment deep inside: harmless to the sibling scan, and
    // exactly what content that tries to end the region early looks like.
    "a closing marker deep inside a region": deep([open], [p, close], [close]),
    "an opening marker deep inside a region": deep([open], [[8, "fu:p:x"]], [close]),
    "a closing marker deep inside an element outside any region": deep([], [close], [
      open,
      p,
      close,
    ]),
    "an opening marker closed only by a deeper comment": deep([open], [close], []),
  };
  for (const [name, doc] of Object.entries(unsound)) {
    assertEquals(soundRegions(doc) === null, true, name);
  }

  const sound: Record<string, [NodeLike, string[]]> = {
    "one region": [page([], [open, p, close]), ["content"]],
    "an empty region": [page([], [open, close]), ["content"]],
    "head and body": [page(HEAD, BODY), ["head-dynamic", "content"]],
    "a region inside an element": [deep([], [open, p, close], []), ["content"]],
    "comments that are not markers, anywhere": [
      deep([[8, "x"], open, [8, " fu:p:content "]], [[8, "/fu:p "], [8, "fu:p:"]], [close]),
      ["content"],
    ],
  };
  for (const [name, [doc, names]] of Object.entries(sound)) {
    assertEquals([...(soundRegions(doc)?.keys() ?? [])], names, name);
  }
});

Deno.test("matchRegions refuses a page with nested regions, live or arrived", () => {
  const nested = page(HEAD, [
    [8, "fu:p:content"],
    [8, "fu:p:inner"],
    [8, "/fu:p"],
    [8, "/fu:p"],
  ]);
  const sound = page(HEAD, BODY);
  assertEquals(matchRegions(nested, sound), null);
  assertEquals(matchRegions(sound, nested), null);
  assertEquals(matchRegions(nested, nested), null);
  // findRegions still lists what it finds; it is not the judge.
  assertEquals([...findRegions(nested).keys()], ["head-dynamic", "content"]);
});

Deno.test("a redirected fetch is loaded in full at its final URL, protocol params removed", () => {
  const to = "http://x/old?q=1";
  assertEquals(
    redirectTarget("http://x/new?q=1&fu-partial=1&__b=v26", to),
    "http://x/new?q=1",
  );
  assertEquals(redirectTarget("http://x/new?fu-partial=1", to), "http://x/new");
  assertEquals(redirectTarget("http://x/new", to), "http://x/new");
  // The rest of the query is kept byte for byte, not re-encoded.
  assertEquals(
    redirectTarget("http://x/new?a=b%20c&flag&__b=v&d=%2F&fu-partial=1&e=", to),
    "http://x/new?a=b%20c&flag&d=%2F&e=",
  );
  // Only the exact names: a param that merely starts like one stays.
  assertEquals(
    redirectTarget("http://x/new?fu-partial-x=1&__bb=2&fu-partial=1", to),
    "http://x/new?fu-partial-x=1&__bb=2",
  );
  // The fragment that was asked for carries over, as it does in a browser.
  assertEquals(redirectTarget("http://x/new?fu-partial=1", "http://x/old#sec"), "http://x/new#sec");
  // Another origin, or nothing usable: the caller loads the original instead.
  for (const final of ["http://evil/new", "https://x/new", "http://x:81/new", "", "not a url"]) {
    assertEquals(redirectTarget(final, to), null, final);
  }
});

// ---- the swap plan, against a stand-in tree ----

interface Tree extends ElementLike {
  attrs: Record<string, string>;
  kids: NodeLike[];
}

function link<T extends NodeLike>(parent: T, kids: NodeLike[]): T {
  parent.firstChild = kids[0] ?? null;
  kids.forEach((k, i) => {
    k.parentNode = parent;
    k.nextSibling = kids[i + 1] ?? null;
  });
  return parent;
}
const blank = { nextSibling: null, firstChild: null, parentNode: null };
const comment = (data: string): NodeLike => ({ nodeType: 8, data, ...blank });
const text = (data: string): NodeLike => ({ nodeType: 3, data, ...blank });

/** An element. `id` names it in assertions; `data-island` and script attributes are read. */
function el(tag: string, attrs: Record<string, string> = {}, ...kids: NodeLike[]): Tree {
  const [localName, id] = tag.split("#");
  const node: Tree = {
    nodeType: 1,
    data: id ?? localName,
    ...blank,
    localName,
    attrs,
    kids,
    getAttribute: (n) => attrs[n] ?? null,
    hasAttribute: (n) => n in attrs,
    querySelectorAll(selector) {
      const hit = (t: Tree) =>
        selector === "script" ? t.localName === "script" : selector.slice(1, -1) in t.attrs;
      const out: Tree[] = [];
      const walk = (list: NodeLike[]) => {
        for (const k of list) {
          if (k.nodeType !== 1) continue;
          if (hit(k as Tree)) out.push(k as Tree);
          walk((k as Tree).kids);
        }
      };
      walk(kids);
      return out;
    },
  };
  return link(node, kids);
}
const island = (id: string, ...kids: NodeLike[]) =>
  el("div#" + id, { "data-island": "/islands/I.tsx" }, ...kids);
const doc = (...kids: NodeLike[]): NodeLike => link({ nodeType: 9, ...blank }, kids);
const names = (nodes: NodeLike[]) => nodes.map((n) => n.data);

Deno.test("planSwap: what leaves, what arrives, which islands unmount and hydrate, which scripts run", () => {
  const live = doc(el(
    "body",
    {},
    el("nav", {}, island("in-nav")),
    comment("fu:p:content"),
    el("div#old", {}, island("old-a"), el("span", {}, island("old-b"))),
    text("loose text"),
    comment("just a comment"),
    island("old-top"),
    comment("/fu:p"),
    el("footer", {}, island("in-footer")),
  ));
  const next = doc(el(
    "body",
    {},
    el("nav", {}, island("their-nav")),
    comment("fu:p:content"),
    el(
      "section#new",
      {},
      island("new-a", el("script#in-island", {})),
      el("script#inline", {}),
      el("script#external", { src: "/sdk.js" }),
      el("script#data", { type: "application/ld+json" }),
      el("p", {}, el("script#deferred", { src: "/d.js", defer: "" })),
    ),
    island("new-top"),
    el("script#top", { type: "module" }),
    el("script#legacy", { nomodule: "" }),
    comment("/fu:p"),
  ));
  const plan = planSwap(matchRegions(live, next)!);

  assertEquals(plan.regions.length, 1);
  const [region] = plan.regions;
  // Everything between the live markers leaves: elements, text and comments.
  assertEquals(names(region.remove), ["old", "loose text", "just a comment", "old-top"]);
  assertEquals(names(region.insert), ["new", "new-top", "top", "legacy"]);
  // In front of the live closing marker, which stays, as the opening one does.
  assertEquals(region.before.data, "/fu:p");
  assertEquals(region.before.parentNode?.data, "body");
  assertEquals(region.before.nextSibling?.data, "footer");

  // Every island that leaves, at any depth and at the top level; none that stays.
  assertEquals(names(plan.unmount), ["old-a", "old-b", "old-top"]);
  // Every island that arrives, once; nothing of the arrived page outside the region.
  assertEquals(names(plan.hydrate), ["new-a", "new-top"]);
  // Executable scripts in document order, the blocking one marked; data and
  // nomodule scripts are not touched.
  assertEquals(
    plan.scripts.map((s) => [s.script.data, s.wait]),
    [["in-island", false], ["inline", false], ["external", true], ["deferred", false], [
      "top",
      false,
    ]],
  );
});

Deno.test("planSwap: several regions in live order, head included; an empty one empties", () => {
  const live = doc(el(
    "html",
    {},
    el("head", {}, comment("fu:p:head-dynamic"), el("title#old-title"), comment("/fu:p")),
    el(
      "body",
      {},
      comment("fu:p:content"),
      island("old"),
      comment("/fu:p"),
      comment("fu:p:aside"),
      comment("/fu:p"),
    ),
  ));
  // The arrived page lists its regions in another order.
  const next = doc(el(
    "html",
    {},
    el(
      "head",
      {},
      el("meta"),
      comment("fu:p:head-dynamic"),
      el("title#new-title"),
      el("script#ld", { type: "application/ld+json" }),
      comment("/fu:p"),
    ),
    el(
      "body",
      {},
      comment("fu:p:aside"),
      island("new-aside"),
      comment("/fu:p"),
      comment("fu:p:content"),
      comment("/fu:p"),
    ),
  ));
  const plan = planSwap(matchRegions(live, next)!);
  assertEquals(
    plan.regions.map((r) => [r.before.parentNode?.data, names(r.remove), names(r.insert)]),
    [
      ["head", ["old-title"], ["new-title", "ld"]],
      ["body", ["old"], []],
      ["body", [], ["new-aside"]],
    ],
  );
  assertEquals([names(plan.unmount), names(plan.hydrate)], [["old"], ["new-aside"]]);
  assertEquals(plan.scripts, []);
  // The sets are disjoint: nothing that leaves is hydrated, nothing that arrives unmounted.
  const leaving = new Set(plan.unmount);
  assertEquals(plan.hydrate.some((h) => leaving.has(h)), false);
});

const script = (attrs: Record<string, string>) => ({
  getAttribute: (n: string) => attrs[n] ?? null,
  hasAttribute: (n: string) => n in attrs,
});

Deno.test("a swapped-in script is left, run, or run and waited for, as a full load would", () => {
  const cases: Array<[Record<string, string>, "leave" | "run" | "wait"]> = [
    // Inline scripts run at once.
    [{}, "run"],
    [{ type: "" }, "run"],
    [{ type: "text/javascript" }, "run"],
    [{ type: "module" }, "run"],
    // A classic external script blocks the scripts after it until it has run.
    [{ src: "/sdk.js" }, "wait"],
    [{ src: "/sdk.js", type: "application/javascript" }, "wait"],
    [{ src: "" }, "wait"],
    // Unless it says it need not.
    [{ src: "/sdk.js", async: "" }, "run"],
    [{ src: "/sdk.js", defer: "" }, "run"],
    [{ src: "/m.js", type: "module" }, "run"],
    [{ src: "/m.js", type: " Module " }, "run"],
    // Data stays data.
    [{ type: "application/ld+json" }, "leave"],
    [{ type: "importmap" }, "leave"],
    [{ type: "text/template", src: "/t.html" }, "leave"],
    // nomodule: never run by a browser with modules, and it fires no load
    // event, so waiting for it would hold every later script for ever.
    [{ nomodule: "" }, "leave"],
    [{ nomodule: "", src: "/legacy.js" }, "leave"],
    // On a module script the attribute means nothing.
    [{ nomodule: "", type: "module" }, "run"],
  ];
  for (const [attrs, want] of cases) {
    assertEquals(scriptAction(script(attrs)), want, JSON.stringify(attrs));
  }
});

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
    url: over.url ?? "http://x/",
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    text: () => Promise.resolve(over.body ?? "<html>"),
  };
}

Deno.test("only a direct, successful HTML answer without a reload directive is swapped in", () => {
  assertEquals(refusal(response()), null);
  assertEquals(refusal(response({ headers: { "content-type": "TEXT/HTML" } })), null);
  assertEquals(refusal(response({ headers: { "content-type": " text/html ;charset=x" } })), null);
  const refused: Record<string, NavResponse> = {
    "the server asked for a full load": response({ headers: { "x-fu-reload": "1" } }),
    "the request was redirected": response({ redirected: true }),
    "the server answered 404": response({ ok: false, status: 404 }),
    "the server answered 500": response({ ok: false, status: 500 }),
    "the answer is not HTML": response({ headers: { "content-type": "application/json" } }),
  };
  for (const [why, res] of Object.entries(refused)) assertEquals(refusal(res), why);
  for (const type of ["", "text/htmlx", "application/xhtml+xml", "application/pdf", "text/plain"]) {
    assertEquals(
      refusal(response({ headers: { "content-type": type } })),
      "the answer is not HTML",
    );
  }
  // The reload directive wins over everything: it is the build guard speaking.
  assertEquals(
    refusal(response({ ok: false, status: 409, headers: { "x-fu-reload": "1" } })),
    "the server asked for a full load",
  );
});
