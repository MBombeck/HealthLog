/**
 * One reload after a stale-shell chunk failure.
 *
 * After a deploy, a page that was open across it still references the
 * previous build's chunk files; they 404 and the lazy load fails. A client
 * navigation already recovers on its own (Next turns a failed chunk during a
 * route change into a full page load), but a chunk that fails inside a page
 * (a `next/dynamic` panel, a lazily imported sheet) surfaces in an error
 * boundary instead. Both boundaries, the route one (`app/error.tsx`) and the
 * root one (`app/global-error.tsx`), call `reloadOnceForChunkError`, which
 * loads the page once so it arrives with the new build's chunk graph.
 *
 * The guard is keyed on the running shell's version: it suppresses a loop
 * within ONE broken shell, and re-arms after every deploy (the pre-v1.16.8
 * once-per-session key exhausted itself on multi-deploy days and stranded the
 * user on the error page).
 */

const CHUNK_RELOAD_KEY = "healthlog:chunk-reload-attempted";

/**
 * A failed chunk, in the words of each loader and engine: webpack's
 * `ChunkLoadError` / "Loading chunk", its CSS twin, Turbopack's "Failed to
 * load chunk", and a native dynamic import as Chromium, WebKit and Firefox
 * report it.
 */
export function isChunkLoadError(err: { name?: string; message?: string }) {
  if (err.name === "ChunkLoadError") return true;
  const msg = err.message ?? "";
  return (
    msg.includes("Loading chunk") ||
    msg.includes("Loading CSS chunk") ||
    msg.includes("Failed to load chunk") ||
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("error loading dynamically imported module")
  );
}

/**
 * Guard value recorded per auto-reload attempt — the running shell's build
 * version, so the suppression is scoped to ONE shell. After a successful
 * heal the reloaded page carries the NEW version and the guard re-arms by
 * construction; only a shell that reloaded and is STILL broken (the new
 * build is also missing the chunk) stays suppressed. Builds without an
 * injected version degrade to once-per-session via the "unversioned"
 * sentinel.
 */
export function chunkReloadGuardValue(shellVersion: string): string {
  return shellVersion || "unversioned";
}

/**
 * Pure reload decision. `stored` is the sessionStorage value from the last
 * attempt (`null` when none happened); legacy guard values (the pre-v1.16.8
 * timestamp) never match a version string, so a session stuck from before
 * the change heals on its next chunk error.
 */
export function shouldAttemptChunkReload(
  stored: string | null,
  shellVersion: string,
): boolean {
  return stored !== chunkReloadGuardValue(shellVersion);
}

/**
 * Reload once if `error` is a chunk failure and this shell has not tried
 * yet. Returns whether a reload was started.
 */
export function reloadOnceForChunkError(
  error: { name?: string; message?: string },
  shellVersion: string = process.env.NEXT_PUBLIC_APP_VERSION || "",
): boolean {
  if (typeof window === "undefined" || !isChunkLoadError(error)) return false;
  try {
    const stored = window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
    if (!shouldAttemptChunkReload(stored, shellVersion)) return false;
    window.sessionStorage.setItem(
      CHUNK_RELOAD_KEY,
      chunkReloadGuardValue(shellVersion),
    );
  } catch {
    // sessionStorage can throw under strict privacy modes; without a guard
    // a reload could loop, so fall through to the error UI instead.
    return false;
  }
  window.location.reload();
  return true;
}
