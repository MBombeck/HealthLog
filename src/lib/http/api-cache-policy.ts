/**
 * The cache posture of every API response, set once in `apiHandler`.
 *
 * An API answer is one account's health record, its tokens, its settings or
 * its sessions. Without a `Cache-Control` header the browser's heuristic
 * caching and any caching proxy an operator puts in front of the app decide
 * on their own whether to keep it, and keep it for whoever asks next on that
 * device or behind that proxy. `private` bars shared caches; `no-store` bars
 * the browser's disk cache and the URL cache of the native client too.
 * `Pragma: no-cache` repeats it for HTTP/1.0 intermediaries, as the OAuth
 * token endpoint already does.
 *
 * A route that sets its own `Cache-Control` keeps it. That is the opt-out,
 * and every one of them is listed with its reason in
 * `src/__tests__/api-cache-control-guard.test.ts`: public static payloads, an
 * ETag'ed read that a client revalidates, a versioned avatar URL.
 *
 * The service worker stores no API response at all (`public/sw.js`), and the
 * offline features keep their data in the client's own query store, so
 * `no-store` takes nothing away from them.
 */
export const API_CACHE_CONTROL = "private, no-store";

export function applyApiCachePolicy(headers: Headers): void {
  if (headers.has("Cache-Control")) return;
  headers.set("Cache-Control", API_CACHE_CONTROL);
  headers.set("Pragma", "no-cache");
}

/**
 * For a response a library built (the MCP transport): `no-store` whatever it
 * chose, since its `no-cache` is written for a stream, not for a record. A
 * `no-transform` it asked for stays.
 */
export function enforceApiNoStore(headers: Headers): void {
  const current = headers.get("Cache-Control") ?? "";
  if (/\bno-store\b/i.test(current)) return;
  headers.set(
    "Cache-Control",
    /\bno-transform\b/i.test(current)
      ? `${API_CACHE_CONTROL}, no-transform`
      : API_CACHE_CONTROL,
  );
  headers.set("Pragma", "no-cache");
}
