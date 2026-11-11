/**
 * Nothing of somebody else's record reaches this device's disk, and nothing on
 * it is painted while somebody else's record is open.
 *
 * The full page reload a switch performs clears the in-memory cache. These two
 * layers are the ones it cannot reach: the IndexedDB snapshot, and (through
 * the same wipe helper) the service worker's read-data cache. Between them
 * they are the reason a switched browser can paint the previous record's
 * numbers with nothing in the page's own code being wrong — the answer would
 * not have come from the page.
 *
 * The IndexedDB here is a small fake rather than a mock of the persister's own
 * calls. A test that asserted "idbSet was not called" would prove the code
 * took a branch; this one proves the store is empty, which is the fact
 * somebody's privacy depends on.
 *
 * Mutation checks, both run:
 *   - delete the `isReadingSharedRecord()` guard in `flush` → "writes nothing
 *     to disk while inside another record" goes red, with the snapshot found
 *     in the store.
 *   - delete the guard in `restorePersistedQueryCache` → "restores nothing
 *     while inside another record" goes red on the cache-size line, with one
 *     entry hydrated. The line above it stays GREEN under that mutation, which
 *     is the point of having both: the record-scoped hash already makes the
 *     restored entry unreadable, so an assertion about readability alone would
 *     have reported success about a control that was no longer there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { QUERY_CLIENT_DEFAULT_OPTIONS } from "@/lib/pwa/query-client-options";
import {
  restorePersistedQueryCache,
  startPersistingQueryCache,
} from "@/lib/pwa/query-persister";
import { queryKeys } from "@/lib/query-keys";
import {
  __resetRecordScopeForTests,
  setRecordScope,
} from "@/lib/query-keys/record-scope";

const BUILD = "test-build";

// ── A minimal in-memory IndexedDB ────────────────────────────────────────────
//
// Only the three calls the persister makes: `open`, `get`, `put`/`delete`
// inside a transaction. Small enough to read in one sitting, real enough that
// the assertions below are about stored bytes rather than about call counts.

const store = new Map<string, unknown>();

function fakeRequest<T>(result: T) {
  const req: {
    result: T;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
    onupgradeneeded: (() => void) | null;
  } = { result, onsuccess: null, onerror: null, onupgradeneeded: null };
  queueMicrotask(() => req.onsuccess?.());
  return req;
}

function fakeObjectStore() {
  return {
    get: (key: string) => fakeRequest(store.get(key)),
    put: (value: unknown, key: string) => {
      store.set(key, value);
      return fakeRequest(undefined);
    },
    delete: (key: string) => {
      store.delete(key);
      return fakeRequest(undefined);
    },
  };
}

function installFakeIndexedDb() {
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const req: {
        result: unknown;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = {
        result: {
          createObjectStore: () => {},
          close: () => {},
          transaction: () => {
            const tx: {
              objectStore: () => ReturnType<typeof fakeObjectStore>;
              oncomplete: (() => void) | null;
              onerror: (() => void) | null;
            } = {
              objectStore: fakeObjectStore,
              oncomplete: null,
              onerror: null,
            };
            queueMicrotask(() => tx.oncomplete?.());
            return tx;
          },
        },
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
}

/** Let the persister's microtask chains and its 1 s debounce run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1500);
}

const originalIdb = (globalThis as { indexedDB?: unknown }).indexedDB;

beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
  __resetRecordScopeForTests();
  installFakeIndexedDb();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalIdb === undefined) {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  } else {
    (globalThis as { indexedDB?: unknown }).indexedDB = originalIdb;
  }
});

/** A client signed in as the caller: the persister binds to that account. */
function appClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS,
  });
  client.setQueryData(queryKeys.authMe(), { id: "acct-delegate" });
  return client;
}

describe("persisting while inside another record", () => {
  it("writes the dashboard to disk in the caller's own record", async () => {
    // The positive control, and the reason the refusal below means anything:
    // without it, "the store is empty" and "the persister does nothing at all
    // in this test harness" are the same sentence.
    const client = appClient();
    const stop = startPersistingQueryCache(client, BUILD);
    client.setQueryData(queryKeys.dashboardSnapshot(), { weightKg: 71 });
    await settle();
    stop();

    expect(store.size).toBeGreaterThan(0);
  });

  it("writes nothing to disk while inside another record", async () => {
    setRecordScope("acct-owner");
    const client = appClient();
    const stop = startPersistingQueryCache(client, BUILD);
    client.setQueryData(queryKeys.dashboardSnapshot(), { weightKg: 92 });
    await settle();
    stop();

    // Not "a smaller payload" and not "the wrong key" — nothing. The
    // allowlist decides which families are low-sensitivity enough to keep on
    // this device, and that judgement was made about the account's own data.
    expect(store.size).toBe(0);
  });
});

describe("restoring while inside another record", () => {
  /** Seed the store the way a session in its own record would have left it. */
  async function seedOwnSnapshot(): Promise<void> {
    const writer = appClient();
    const stop = startPersistingQueryCache(writer, BUILD);
    writer.setQueryData(queryKeys.dashboardSnapshot(), { weightKg: 71 });
    await settle();
    stop();
    expect(store.size).toBeGreaterThan(0);
  }

  it("hydrates the persisted dashboard in the caller's own record", async () => {
    await seedOwnSnapshot();

    const reader = appClient();
    await restorePersistedQueryCache(reader, BUILD);
    await vi.advanceTimersByTimeAsync(0);

    expect(reader.getQueryData(queryKeys.dashboardSnapshot())).toEqual({
      weightKg: 71,
    });
  });

  it("restores nothing while inside another record", async () => {
    await seedOwnSnapshot();
    setRecordScope("acct-owner");

    const reader = appClient();
    await restorePersistedQueryCache(reader, BUILD);
    await vi.advanceTimersByTimeAsync(0);

    // The disk holds the DELEGATE's own dashboard. Painting it under a banner
    // saying "you are in her record" is the mis-context failure this feature
    // exists to prevent, in the one place a full reload cannot clear.
    expect(reader.getQueryData(queryKeys.dashboardSnapshot())).toBeUndefined();

    // And the entry is not merely unreachable — it was never hydrated. The
    // line above passes with the guard deleted, because the record-scoped
    // hash already makes a snapshot written in one record unreadable in
    // another; asserting only that would be a check that cannot fail for the
    // control it names. This one counts what landed in the cache, so removing
    // the guard leaves exactly one entry here and turns it red. The only
    // entry is the reader's own `/api/auth/me`.
    expect(
      reader
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey[0]),
    ).toEqual(["auth"]);
  });
});
