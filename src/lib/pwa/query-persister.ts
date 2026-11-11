/**
 * Minimal IndexedDB-backed TanStack Query persistence.
 *
 * No external persister dependency: a tiny IDB key/value store plus a manual
 * dehydrate-on-cache-change / hydrate-after-sign-in bridge. It is a warm
 * start for the dashboard reads, not an offline mode: signed-in pages are
 * never cached, so the app cannot boot without a connection.
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
 *  - The payload is stamped with the current user id. A restore runs only
 *    once `["auth","me"]` names the live account, and a stored owner that is
 *    not that account discards + clears the cache rather than hydrating a
 *    foreign account's data.
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
import { ACCOUNT_CACHE_NAME_RE } from "@/lib/pwa/sw-cache-policy";

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
 * Restore persisted query data into the client once the signed-in account is
 * known. A build-version, age or owner mismatch discards the snapshot rather
 * than hydrating a stale, foreign-schema or foreign-account cache.
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
  // Without a live account there is nothing to compare the owner with.
  const liveUserId = currentUserId(queryClient);
  if (liveUserId === null) return;
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
    // Per-account binding: a snapshot written by anyone but the live account
    // (or before any account was known) is another user's on the same
    // browser profile. Discard and clear it.
    if (payload.userId !== liveUserId) {
      await clearPersistedQueryCache();
      return;
    }

    // Only fill gaps, never overwrite data the live client holds: the
    // restore lands after the shell has mounted the page, so a query may
    // already carry a fresh (post-mutation) answer, and that is fresher than
    // disk. A query the page has started but not answered yet has no data
    // and is filled; its own fetch replaces the copy when it lands.
    const cache = queryClient.getQueryCache();
    const filtered: DehydratedState = {
      ...payload.state,
      queries: payload.state.queries.filter(
        (q) => cache.get(q.queryHash)?.state.data === undefined,
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
    // refetch that lands fresh data within ms. Scoped to the keys just
    // hydrated so a live query is never disturbed.
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
 * Wipe every client-side cache that can hold one account's data: the
 * IndexedDB query snapshot, the worker's page cache and the API caches older
 * releases left behind, current and legacy versions alike. The static cache
 * (catalogs, icons) holds nothing of an account and stays, so a sign-in does
 * not download the locale catalog again. The single call for a session END
 * (logout or 401 / expiry redirect) and at sign-in. Best-effort.
 */
export async function clearOfflineCachesForSessionEnd(): Promise<void> {
  await clearPersistedQueryCache();
  if (typeof caches !== "undefined") {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => ACCOUNT_CACHE_NAME_RE.test(k))
          .map((k) => caches.delete(k)),
      );
    } catch {
      /* best effort */
    }
  }
}

/**
 * The same wipe, before a record switch in either direction.
 *
 * The full page reload the switch performs clears the in-memory cache; the
 * IndexedDB snapshot survives it and holds the dashboard the browser was last
 * looking at. Without this call the first paint after the switch could show
 * the previous record's numbers under a banner naming the new one.
 *
 * Run it BEFORE the reload and await it: a wipe racing the navigation
 * sometimes does not happen.
 */
export async function clearOfflineCachesForRecordSwitch(): Promise<void> {
  await clearOfflineCachesForSessionEnd();
}
