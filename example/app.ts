import { App } from "@janit/fu";
import type { State } from "./state.ts";
import { noCacheErrors, securityHeaders } from "./middleware/security-headers.ts";
import { redirects, trailingSlash } from "./middleware/redirects.ts";
import { healthz, logErrors, resolveTenant, robotsTxt } from "./middleware/tenant.ts";

const app = new App<State>();

// Order is outermost first: the first registered unwinds last, so it has the
// final say on response headers.
app.use(securityHeaders);
app.use(noCacheErrors);
app.use(logErrors);

// Cheap short-circuits before any per-request work.
app.use(healthz);
app.use(trailingSlash);

// Everything below can rely on ctx.state.tenant.
app.use(resolveTenant);
app.use(robotsTxt);
app.use(redirects);

export default app;
