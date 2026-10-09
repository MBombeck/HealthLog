/**
 * Minimal IndexedDB-backed TanStack Query persistence (v1.18.6).
 *
 * No external persister dependency: a tiny IDB key/value store plus a manual
 * dehydrate-on-cache-change / hydrate-on-boot bridge. The goal is offline
 * READ value — an installed PWA opened offline hydrates the last cached
 * dashboard/series instantly instead of painting empty skeletons forever.
 *
 * Safety:
 *  - Only successful (`status: "success"`) query results are persisted.
 *  - A strict ALLOWLIST keeps everything except the low-sensitivity
 *    dashboard-offline families off disk. This is the privacy floor: a
 *    denylist would persist every family it didn't name (cycle, mood, illness,
 *    labs, coach, insights, medications, …) in plaintext. Only the dashboard
 *    snapshot, its resolved widget layout, and the measurement daily-series —
 *    the data the dashboard needs to paint last-known values offline — are
 *    eligible. Clinical / narrative families are never written to disk.
 *  - `clearPersistedQueryCache()` is called on every session END (logout AND
 *    the 401 / session-expiry redirect), so a shared device never leaks one
 *    account's cached data to the next once the session is gone.
 *  - The payload is stamped with the current user id; a restore whose stored
 *    marker doesn't match the live account discards + clears the cache rather
 *    than hydrating a foreign account's data.
 *  - Respects the centralised queryKey factory: it reads existing query keys,
 *    it never invents new ones.
 */

import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type QueryClient,
} from "@tanstack/react-query";

import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import { queryKeys } from "@/lib/query-keys";
import { isReadingSharedRecord } from "@/lib/query-keys/record-scope";
// Session-end cleanup removes every current/legacy HealthLog cache family
// while leaving unrelated CacheStorage namespaces on the same origin
// untouched; the name contract is shared with `public/sw.js`.
import { HEALTHLOG_CACHE_NAME_RE } from "@/lib/pwa/sw-cache-policy";

const DB_NAME = "healthlog-query-cache";
const STORE = "kv";
const KEY = "react-query";
const VERSION_KEY = "react-query-version";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // discard anything older than a day

/**
 * Upper bound on the serialized snapshot. The allowlist already caps WHAT is
 * persisted (dashboard snapshot + widget layout + daily series), but a tenant
 * with a long chart history can still grow a single series past what's worth
 * keeping on disk — and an oversized write is the most likely trigger for an
 * IndexedDB `QuotaExceededError`. A snapshot above this ceiling is skipped
 * rather than written: the offline read value of a multi-megabyte blob is
 * marginal, and skipping keeps the last good (smaller) snapshot in place.
 */
const MAX_PERSIST_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Strict allowlist of the only query families written to disk — the
 * low-sensitivity reads the dashboard needs to paint last-known values when
 * opened offline. Everything else (coach, insights, illness, labs, mood,
 * medications, cycle, auth, admin, tokens, …) stays in memory only.
 *
 *  - `["dashboard", …]`  — the unified first-paint snapshot
 *    (`queryKeys.dashboardSnapshot()` → `["dashboard","snapshot"]`).
 *  - `["chart-data", …]` — the per-chart daily series + the batched dashboard
 *    series (`queryKeys.chartData(…)` / `queryKeys.chartSeriesBatch(…)`), the
 *    aggregated values the dashboard charts render.
 *  - `["user","dashboardWidgets"]` — the resolved widget layout the snapshot
 *    seeds, matched as an exact tuple so the rest of the overloaded `["user", …]`
 *    head (profile, AI provider, insights layout, thresholds) stays off disk.
 *
 * INVARIANT (bound to the dashboard hero): `["daily", …]` — the Today digest —
 * is deliberately NOT here. The hero's data-first render gate in
 * `src/app/page-client.tsx` is hydration-safe only while the digest's first-
 * render data source is the server dehydration boundary alone, never a client-
 * only IndexedDB restore. Adding a `daily` head here would let a restored
 * digest paint the hero on the client while the server rendered a skeleton — a
 * React #418 text mismatch. Do not add it without revisiting that gate.
 */
const PERSIST_ALLOWLIST_HEADS = ["dashboard", "chart-data"] as const;

export function isPersistableKey(queryKey: readonly unknown[]): boolean {
  const head = queryKey[0];
  if (typeof head !== "string") return false;
  if ((PERSIST_ALLOWLIST_HEADS as readonly string[]).includes(head)) {
    return true;
  }
  // Only the dashboard widget layout under the overloaded `["user", …]` head.
  return head === "user" && queryKey[1] === "dashboardWidgets";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** True for the storage-quota error class across browsers. */
function isQuotaError(err: unknown): boolean {
  if (err instanceof DOMException) {
    // Chromium/WebKit throw `QuotaExceededError`; Firefox historically
    // throws `NS_ERROR_DOM_QUOTA_REACHED` (code 22).
    return (
      err.name === "QuotaExceededError" ||
      err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      err.code === 22
    );
  }
  return false;
}

async function idbGet<T>(): Promise<T | undefined> {
  const db = await openDb();
  const result = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

interface PersistedPayload {
  buildVersion: string;
  savedAt: number;
  /**
   * Per-account binding. The id of the account whose reads produced this
   * snapshot, read from the live `["auth","me"]` cache entry at flush time
   * (`null` when unknown). A restore whose live account differs discards the
   * snapshot rather than hydrating a foreign account's dashboard data — a
   * belt-and-suspenders guard alongside the session-end wipe.
   */
  userId: string | null;
  state: DehydratedState;
}

/** Read the current account id from the live `["auth","me"]` cache entry. */
function currentUserId(queryClient: QueryClient): string | null {
  const me = queryClient.getQueryData<{ id?: string } | null>(
    queryKeys.authMe(),
  );
  return me?.id ?? null;
}

/**
 * Restore persisted query data into the client (called once before the first
 * paint of the authenticated shell). A build-version or age mismatch discards
 * the snapshot rather than hydrating a stale/foreign-schema cache.
 */
export async function restorePersistedQueryCache(
  queryClient: QueryClient,
  buildVersion: string,
  canHydrate: () => boolean = () => true,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  // v1.36.0 — a browser inside somebody else's record restores nothing. The
  // store holds the caller's OWN dashboard (it is the only thing that was ever
  // written to it, see the flush below), and painting that under a banner
  // saying "viewing her record" is the mis-context failure this feature is
  // built to prevent, in the one place a full reload cannot clear.
  if (isReadingSharedRecord()) return;
  try {
    const payload = await idbGet<PersistedPayload>();
    if (!payload) return;
    if (payload.buildVersion !== buildVersion) {
      await clearPersistedQueryCache();
      return;
    }
    if (Date.now() - payload.savedAt > MAX_AGE_MS) {
      await clearPersistedQueryCache();
      return;
    }
    // Per-account binding: if the live account is known and differs from the
    // snapshot's stored owner, this is a different user on the same browser
    // profile — discard + clear rather than hydrate a foreign account's data.
    // When the live id is not yet known (auth/me not resolved at restore time)
    // we don't gate on it; the session-end wipe is the primary guarantee and
    // the build-version + 24 h age gates still apply.
    const liveUserId = currentUserId(queryClient);
    if (liveUserId !== null && payload.userId !== liveUserId) {
      await clearPersistedQueryCache();
      return;
    }

    // Never clobber a query the live client already holds. `hydrate` calls
    // `setData` per dehydrated query unconditionally, so a snapshot restored
    // in an effect AFTER the first paint would overwrite a query the page
    // already fetched/prefetched — replacing the fresh (post-mutation) list
    // with the stale persisted (often empty) copy. That was the read-after-
    // write break across dashboard/measurements/medications: the restore won
    // the race against the in-flight fetch. Drop every dehydrated query whose
    // key the cache already carries so restore only ever FILLS gaps, never
    // overwrites; a query already present is by definition fresher than disk.
    const cache = queryClient.getQueryCache();
    const filtered: DehydratedState = {
      ...payload.state,
      queries: payload.state.queries.filter(
        (q) => cache.get(q.queryHash) === undefined,
      ),
    };
    if (filtered.queries.length === 0 || !canHydrate()) return;

    hydrate(queryClient, filtered);
    // Restored queries carry their original `dataUpdatedAt`, so with the
    // client's 5-minute `staleTime` a snapshot saved minutes ago hydrates as
    // *fresh* and the first observer never refetches — a list opened straight
    // after a create/update then serves the stale pre-mutation copy. Marking
    // every restored query invalidated makes it stale-but-shown: the persisted
    // data still paints instantly, and the first mount triggers a background
    // refetch. Online that lands fresh data within ms; offline the refetch
    // fails and the hydrated copy stays on screen — the offline value holds.
    // Scoped to the keys we just hydrated so we never disturb a live query.
    for (const dq of filtered.queries) {
      cache.get(dq.queryHash)?.invalidate();
    }
  } catch {
    // Persistence is best-effort; never block boot on a cache restore.
  }
}

/**
 * Subscribe to cache changes and debounce-persist successful, persistable
 * queries to IndexedDB. Returns an unsubscribe function.
 */
export function startPersistingQueryCache(
  queryClient: QueryClient,
  buildVersion: string,
): () => void {
  if (typeof indexedDB === "undefined") return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    // v1.36.0 — never write another person's record to this device. The
    // allowlist below decides WHICH families are low-sensitivity enough to
    // persist; that judgement was made about the account's own data and does
    // not carry over to a record they were merely given to read. Refusing at
    // the flush (rather than filtering keys) also means the last good snapshot
    // of the caller's own dashboard survives a switch untouched.
    if (isReadingSharedRecord()) return;
    const state = dehydrate(queryClient, {
      shouldDehydrateQuery: (query) =>
        query.state.status === "success" && isPersistableKey(query.queryKey),
    });
    const payload: PersistedPayload = {
      buildVersion,
      savedAt: Date.now(),
      userId: currentUserId(queryClient),
      state,
    };

    // Size-cap before touching disk: a snapshot past the ceiling is the
    // likeliest quota trigger and its marginal offline value isn't worth
    // evicting the last good (smaller) snapshot. Skip the write, keep what's
    // there.
    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_PERSIST_BYTES) {
      console.warn(
        `[query-persister] skipping persist: snapshot ${serialized.length}B exceeds ${MAX_PERSIST_BYTES}B cap`,
      );
      return;
    }

    // Registered so the test suite can await it: the warns below are console
    // writes on a detached handle, and one that lands while a vitest worker is
    // closing its RPC channel fails the whole run. No-op outside test.
    trackBackgroundTask(
      idbSet(payload).catch((err) => {
        // Don't silently swallow a full-disk failure: a quota error means the
        // offline cache stopped updating, and a clear signal beats a stale
        // snapshot the user can't explain. Drop the persisted blob so the next
        // flush has room rather than failing again against a full store.
        if (isQuotaError(err)) {
          console.warn(
            "[query-persister] IndexedDB quota exceeded; dropping persisted cache",
          );
          void clearPersistedQueryCache();
          return;
        }
        console.warn("[query-persister] persist failed", err);
      }),
    );
  };

  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 1000);
  });

  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

/**
 * Wipe the persisted query cache. Call on every session END — logout AND the
 * 401 / session-expiry redirect — so a shared device never leaks one account's
 * cached data to the next.
 */
export async function clearPersistedQueryCache(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.objectStore(STORE).delete(VERSION_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* best effort */
  }
}

/**
 * Wipe every client-side cache that can hold one account's health data: the
 * IndexedDB query snapshot, the SW offline read-data cache, and the SW page
 * cache (cached navigation HTML). The single call for a session END (logout or
 * 401 / expiry redirect). Best-effort across the board.
 */
export async function clearOfflineCachesForSessionEnd(): Promise<void> {
  await clearPersistedQueryCache();
  if (typeof caches !== "undefined") {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => HEALTHLOG_CACHE_NAME_RE.test(k))
          .map((k) => caches.delete(k)),
      );
    } catch {
      /* best effort */
    }
  }
}

/**
 * v1.36.0 — the same wipe, before a record switch in either direction.
 *
 * Deliberately the same bytes as the session-end wipe rather than a narrower
 * one, and deliberately named for the act that calls it.
 *
 * The full page reload the switch performs clears the in-memory cache; these
 * two layers are the ones that survive it. The IndexedDB snapshot holds the
 * dashboard the browser was last looking at, and the service worker's
 * `healthlog-data-*` cache answers `/api/…` reads from disk on a
 * stale-while-revalidate branch — so without this call, the first paint after
 * switching into a record can be the previous record's numbers, served by the
 * worker, under a banner naming the new one. Nothing about the page's own code
 * would be wrong; the answer would just come from somewhere the page does not
 * control.
 *
 * Run it BEFORE the reload and await it. A wipe racing the navigation is a
 * wipe that sometimes does not happen, and "sometimes" is the whole failure.
 */
export async function clearOfflineCachesForRecordSwitch(): Promise<void> {
  await clearOfflineCachesForSessionEnd();
}
