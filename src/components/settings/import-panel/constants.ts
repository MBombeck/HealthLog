/**
 * Upper bound for the paste textareas, mirroring the 16 MB server-side body
 * ceiling on `/api/import` and `/api/import/csv`. Caps an accidental over-paste
 * before it ever reaches the route and feeds the live character counter.
 */
export const MAX_PASTE_CHARS = 16 * 1024 * 1024;

/**
 * The CSV / JSON import guide on the public docs site.
 *
 * Both import cards used `${INTEGRATION_DOCS_BASE}/data-import`, which is
 * the wrong tree — the guide is not an integration runbook, and that path
 * now only resolves through a redirect. This is the canonical address, so
 * the link goes straight to the page. Kept here rather than in each card
 * because both cards point at the same guide.
 */
export const IMPORT_GUIDE_URL = "https://docs.healthlog.dev/guides/import-csv/";
