// @ts-check
// Fresh Urquell HMR client runtime. Rolldown's default runtime registers new module
// factories but never *applies* them; this one does the apply walk:
// swap the module, re-run its factory, then fire its accept callbacks.

/** @type {any} */
var BaseDevRuntime = DevRuntime;

class ModuleHotContext {
  /** @type {{ deps: string[], fn: (mod: any) => void }[]} */
  acceptCallbacks = [];
  constructor(moduleId, devRuntime) {
    this.moduleId = moduleId;
    this.devRuntime = devRuntime;
  }
  accept(...args) {
    if (args.length === 1) {
      this.acceptCallbacks.push({ deps: [this.moduleId], fn: args[0] });
    } else if (args.length !== 0) {
      throw new Error('Invalid arguments for `import.meta.hot.accept`');
    }
  }
  invalidate() {
    socket.send(JSON.stringify({ type: 'hmr:invalidate', moduleId: this.moduleId }));
  }
}

class FuDevRuntime extends BaseDevRuntime {
  /** @type {Map<string, ModuleHotContext>} */
  moduleHotContexts = new Map();
  createModuleHotContext(moduleId) {
    const ctx = new ModuleHotContext(moduleId, this);
    this.moduleHotContexts.set(moduleId, ctx);
    return ctx;
  }
}

const clientId = crypto.randomUUID();
const addr = new URL('ws://$ADDR');
addr.searchParams.set('clientId', clientId);
const socket = new WebSocket(addr);

/** @type {any} */
const runtime = new FuDevRuntime(clientId);
globalThis.__rolldown_runtime__ ??= runtime;

/**
 * Apply one patch: import it (registering new factories), then for every
 * changed module that accepted itself, drop its cache, re-run the factory and
 * hand the fresh exports to its accept callbacks. Anything that did not accept
 * falls back to a full reload.
 */
async function applyPatch(url, allChangedIds) {
  const rt = globalThis.__rolldown_runtime__;
  // Stylesheets are swapped via the <link>, so they never need to accept and
  // must not drag the page into a full reload.
  const changedIds = (allChangedIds || []).filter((id) => !id.endsWith('.css'));
  const selfAccepting = changedIds.filter((id) => {
    const ctx = rt.moduleHotContexts.get(id);
    return ctx && ctx.acceptCallbacks.length > 0;
  });
  try {
    await import(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now());
  } catch (err) {
    console.error('[hmr] failed to load patch', url, err);
    location.reload();
    return;
  }
  if (!changedIds || changedIds.length === 0) return;
  if (selfAccepting.length !== changedIds.length) {
    console.debug('[hmr] some modules did not accept; reloading');
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
  console.debug('[hmr] applied', selfAccepting.join(', '));
}

/**
 * Swap the stylesheet in place. A new <link> is inserted and the old one is
 * only removed once the replacement has loaded, so the page never flashes
 * unstyled.
 */
function swapStylesheet(href) {
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
  const old = links[links.length - 1];
  const next = document.createElement('link');
  next.rel = 'stylesheet';
  next.href = href;
  next.onload = () => { if (old && old !== next) old.remove(); };
  (old ? old.parentNode : document.head).insertBefore(next, old ? old.nextSibling : null);
  console.debug('[hmr] css swapped ->', href);
}

socket.onmessage = function (event) {
  const data = JSON.parse(event.data);
  if (data.type === 'connected') {
    console.debug('[hmr] connected');
  } else if (data.type === 'hmr:update') {
    applyPatch(data.url, data.changedIds);
  } else if (data.type === 'fu:css') {
    swapStylesheet(data.href);
  } else if (data.type === 'hmr:reload') {
    location.reload();
  }
};
