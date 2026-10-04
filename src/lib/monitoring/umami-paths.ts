// Client-safe: imported by the tracker tag, so it carries no server code.

/**
 * Where the browser's Umami tracker sends its events, relative to the app.
 *
 * The tracker posts to `${data-host-url}${collectPath}`, and the collect
 * path is compiled into the operator's tracker build: `/api/send` by
 * default, anything at all when the Umami instance sets
 * `COLLECT_API_ENDPOINT` (a common ad-blocker workaround). Pointing
 * `data-host-url` at the app origin therefore only worked for default
 * builds; a renamed endpoint posted every page view to an app path that did
 * not exist. Every path under this prefix is answered by the one proxy route
 * (`src/app/api/monitoring/umami/[...path]/route.ts`), so whatever the build
 * calls its endpoint, the request lands somewhere that forwards it.
 */
export const UMAMI_PROXY_PREFIX = "/api/monitoring/umami";

/** Umami's own default collect endpoint. */
export const UMAMI_DEFAULT_COLLECT_PATH = "/api/send";
