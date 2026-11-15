// @ts-check
// Fresh Urquell HMR client runtime. Rolldown's default runtime registers new module
// factories but never *applies* them; this one does the apply walk:
// swap the module, re-run its factory, then fire its accept callbacks.
//
// `DevRuntime` is injected by rolldown when this source is inlined via
// `devMode.implement`, so it does not exist as a module and is typed loosely.

/** @type {any} */
// @ts-ignore: injected by rolldown, see above.
const BaseDevRuntime = DevRuntime;

/** The slice of rolldown's dev runtime this file drives. @type {any} */
const g = globalThis;

class ModuleHotContext {
  /** @type {{ deps: string[], fn: (mod: any) => void }[]} */
  acceptCallbacks = [];
  /** @param {string} moduleId @param {unknown} devRuntime */
  constructor(moduleId, devRuntime) {
    this.moduleId = moduleId;
    this.devRuntime = devRuntime;
  }
  /** @param {...(mod: any) => void} args */
  accept(...args) {
    if (args.length === 1) {
      this.acceptCallbacks.push({ deps: [this.moduleId], fn: args[0] });
    } else if (args.length !== 0) {
      throw new Error("Invalid arguments for `import.meta.hot.accept`");
    }
  }
  /** This module cannot take the update after all. Nothing above it accepts, so reload. */
  invalidate() {
    location.reload();
  }
}

class FuDevRuntime extends BaseDevRuntime {
  /** @type {Map<string, ModuleHotContext>} */
  moduleHotContexts = new Map();
  /** @param {string} moduleId */
  createModuleHotContext(moduleId) {
    const ctx = new ModuleHotContext(moduleId, this);
    this.moduleHotContexts.set(moduleId, ctx);
    return ctx;
  }
}

/**
 * A random v4 UUID naming this page to the HMR socket. crypto.randomUUID
 * exists only in a secure context (https, localhost); a dev server opened over
 * plain http by IP or host name has none, and a throw here, before any
 * island, leaves the whole page dead. getRandomValues exists everywhere.
 * @returns {string}
 */
function newClientId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const clientId = newClientId();
// The host the page came from (localhost, or the address a LAN or Tailscale
// browser used), on the HMR port. wss on an https page, which would refuse a
// plain ws: socket as mixed content.
const addr = new URL(
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:__FU_HMR_PORT__`,
);
addr.searchParams.set("clientId", clientId);
const socket = new WebSocket(addr);

/** @type {any} */
const runtime = new /** @type {any} */ (FuDevRuntime)(clientId);
g.__rolldown_runtime__ ??= runtime;

/**
 * Apply one patch: import it (registering new factories), then for every
 * changed module that accepted itself, drop its cache, re-run the factory and
 * hand the fresh exports to its accept callbacks. Anything that did not accept
 * falls back to a full reload.
 *
 * @param {string} url
 * @param {string[] | undefined} allChangedIds
 */
async function applyPatch(url, allChangedIds) {
  const rt = g.__rolldown_runtime__;
  // Stylesheets are swapped via the <link>, so they never need to accept and
  // must not drag the page into a full reload.
  const changedIds = (allChangedIds || []).filter((id) => !id.endsWith(".css"));
  const selfAccepting = changedIds.filter((id) => {
    const ctx = rt.moduleHotContexts.get(id);
    return ctx && ctx.acceptCallbacks.length > 0;
  });
  try {
    await import(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now());
  } catch (err) {
    console.error("[hmr] failed to load patch", url, err);
    location.reload();
    return;
  }
  // A CSS module's exports are its class names. Run the new factory before
  // the islands that import it, or a class added in this save reads as
  // undefined until the page is reloaded.
  for (const id of allChangedIds || []) {
    if (!id.endsWith(".module.css")) continue;
    rt.removeModuleCache(id);
    rt.initModule(id);
  }
  if (!changedIds || changedIds.length === 0) return;
  if (selfAccepting.length !== changedIds.length) {
    console.debug("[hmr] some modules did not accept; reloading");
    location.reload();
    return;
  }
  for (const id of selfAccepting) {
    rt.removeModuleCache(id);
    rt.initModule(id);
    const exports = rt.loadExports(id);
    const ctx = rt.moduleHotContexts.get(id);
    for (const { fn } of ctx ? ctx.acceptCallbacks : []) fn(exports);
  }
  console.debug("[hmr] applied", selfAccepting.join(", "));
}

/** The newest stylesheet link inserted, so only it survives a burst of saves. */
/** @type {HTMLLinkElement | null} */
let latestSheet = null;

/**
 * Swap the stylesheet in place. A new <link> is inserted and the others are
 * only removed once it has loaded, so the page never flashes unstyled. Two
 * quick saves can load out of order, so whichever loads removes every sheet
 * but the newest, and a stale one that loads late removes itself.
 *
 * @param {string} href
 */
function swapStylesheet(href) {
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
  const old = links[links.length - 1];
  const next = document.createElement("link");
  next.rel = "stylesheet";
  next.href = href;
  latestSheet = next;
  const path = new URL(href, location.href).pathname;
  next.onload = () => {
    if (next !== latestSheet) return next.remove();
    for (
      const l of /** @type {NodeListOf<HTMLLinkElement>} */ (document.querySelectorAll(
        'link[rel="stylesheet"]',
      ))
    ) {
      if (l !== next && new URL(l.href, location.href).pathname === path) l.remove();
    }
  };
  (old?.parentNode ?? document.head).insertBefore(next, old ? old.nextSibling : null);
  console.debug("[hmr] css swapped ->", href);
}

socket.onmessage = function (/** @type {MessageEvent<string>} */ event) {
  const data = JSON.parse(event.data);
  if (data.type === "connected") {
    console.debug("[hmr] connected");
  } else if (data.type === "hmr:update") {
    applyPatch(data.url, data.changedIds);
  } else if (data.type === "fu:css") {
    swapStylesheet(data.href);
  } else if (data.type === "hmr:reload") {
    location.reload();
  }
};
