import type { PageContext } from "@janit/fu";
import type { State } from "../../state.ts";

export const handlers = {
  GET: (ctx: PageContext<State>) => {
    ctx.head.title = `${ctx.params.slug} — Fresh Urquell`;
    // `ctx.url.origin` comes from the request's Host header, which the client
    // chooses. Fine for a demo; a real site names its origin in configuration,
    // or a cache in front could store a page pointing at someone else's domain.
    ctx.head.canonical = `${ctx.url.origin}/blog/${ctx.params.slug}`;
    ctx.head.jsonLd = {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: ctx.params.slug,
    };
    return null;
  },
};

export default function Post(ctx: PageContext<State>) {
  return <h1 id="slug">{ctx.params.slug}</h1>;
}
