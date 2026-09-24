import { type FunctionComponent, h, hydrate, render } from "preact";

type Props = Record<string, unknown>;

interface Mounted {
  el: HTMLElement;
  props: Props;
}

interface IslandProxy {
  /** Stable component identity, preserved across hot swaps. */
  Component: FunctionComponent<Props>;
  impl: { current: FunctionComponent<Props> };
}

const mounted = new Map<string, Mounted[]>();
const proxies = new Map<string, IslandProxy>();
let hmrVersion = 0;

/**
 * Wrap an island in a component whose *identity* never changes. Preact keys
 * hook state to the component type, so swapping the implementation behind a
 * stable wrapper lets the instance — and therefore its signals — survive HMR
 * without a Babel-based fast-refresh transform.
 *
 * Adding or removing a hook still changes hook order; that case needs a reload.
 */
function proxyFor(key: string, impl: FunctionComponent<Props>): IslandProxy {
  const existing = proxies.get(key);
  if (existing) {
    existing.impl.current = impl;
    return existing;
  }
  const holder = { current: impl };
  // `__hmr` is a cache-buster: bumping it makes Preact re-render this instance
  // (same type, so hooks survive) and pick up the swapped implementation. It is
  // stripped before reaching the island.
  const Component = ({ __hmr: _ignored, ...props }: Props) => holder.current(props);
  const entry: IslandProxy = { Component, impl: holder };
  proxies.set(key, entry);
  return entry;
}

type IslandModule = Record<string, unknown>;

/** `/islands/W.tsx#Toggle` -> ["/islands/W.tsx", "Toggle"]; no `#` means the default export. */
function splitKey(key: string): [file: string, name: string] {
  const i = key.indexOf("#");
  return i === -1 ? [key, "default"] : [key.slice(0, i), key.slice(i + 1)];
}

function componentOf(mod: IslandModule, name: string): FunctionComponent<Props> | null {
  const c = mod[name];
  return typeof c === "function" ? c as FunctionComponent<Props> : null;
}

/**
 * Hydrate every `[data-island]` marker the server rendered.
 *
 * Every distinct island module is fetched at once, then the markers are
 * hydrated in document order; awaiting each in turn would serialise one
 * network round-trip per island.
 */
export async function hydrateIslands(
  manifest: Record<string, () => Promise<IslandModule>>,
): Promise<void> {
  const els = [...document.querySelectorAll<HTMLElement>("[data-island]")];
  const files = [...new Set(els.map((el) => splitKey(el.dataset.island!)[0]))];
  const modules = new Map(
    await Promise.all(files.map(async (file) => {
      const loader = manifest[file];
      if (!loader) console.warn("[fu] no island module for", file);
      return [file, loader ? await loader() : null] as const;
    })),
  );
  for (const el of els) {
    const key = el.dataset.island!;
    const [file, name] = splitKey(key);
    const mod = modules.get(file);
    const impl = mod && componentOf(mod, name);
    if (!impl) {
      if (mod) console.warn(`[fu] ${file} has no component exported as ${name}`);
      continue;
    }
    const props = JSON.parse(el.dataset.props || "{}") as Props;
    hydrate(h(proxyFor(key, impl).Component, props), el);
    const list = mounted.get(key) ?? [];
    list.push({ el, props });
    mounted.set(key, list);
  }
  installHmrHook();
}

/** Exposed for the HMR runtime to call after a module is hot-swapped. */
function installHmrHook(): void {
  (globalThis as Record<string, unknown>).__fu_hmr__ = (file: string, mod: IslandModule): void => {
    const stamp = ++hmrVersion;
    for (const [key, list] of mounted) {
      const [keyFile, name] = splitKey(key);
      if (keyFile !== file || !list.length) continue;
      // A save that truncates or renames the file first can be picked up
      // half-written, with the export missing. Swapping that in would make the
      // proxy call undefined; keep the old implementation until a whole one lands.
      const impl = componentOf(mod, name);
      if (!impl) {
        console.warn(`[fu] hmr: ${file} has no ${name} export right now; keeping the old one`);
        continue;
      }
      const { Component } = proxyFor(key, impl);
      for (const { el, props } of list) render(h(Component, { ...props, __hmr: stamp }), el);
      console.debug(`[fu] hmr: re-rendered ${list.length}x ${key}`);
    }
  };
}
