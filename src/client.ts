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

/**
 * Hydrate every `[data-island]` marker the server rendered.
 *
 * Every distinct island module is fetched at once, then the markers are
 * hydrated in document order; awaiting each in turn would serialise one
 * network round-trip per island.
 */
export async function hydrateIslands(
  manifest: Record<string, () => Promise<{ default: FunctionComponent<Props> }>>,
): Promise<void> {
  const els = [...document.querySelectorAll<HTMLElement>("[data-island]")];
  const keys = [...new Set(els.map((el) => el.dataset.island!))];
  const loaded = new Map(
    await Promise.all(keys.map(async (key) => {
      const loader = manifest[key];
      if (!loader) console.warn("[fu] no island module for", key);
      return [key, loader ? (await loader()).default : null] as const;
    })),
  );
  for (const el of els) {
    const key = el.dataset.island!;
    const impl = loaded.get(key);
    if (!impl) continue;
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
  (globalThis as Record<string, unknown>).__fu_hmr__ = (
    key: string,
    mod: { default: FunctionComponent<Props> },
  ): void => {
    const list = mounted.get(key);
    if (!list?.length) return;
    const { Component } = proxyFor(key, mod.default);
    const stamp = ++hmrVersion;
    for (const { el, props } of list) render(h(Component, { ...props, __hmr: stamp }), el);
    console.debug(`[fu] hmr: re-rendered ${list.length}x ${key}`);
  };
}
