/**
 * `invalidateKeys` against a query that is still on its first fetch.
 *
 * TanStack only restarts an in-flight fetch on invalidation when the query
 * already holds data (`cancelRefetch` is ignored otherwise); a query with no
 * data yet gets the in-flight promise back, and its success then clears the
 * invalidated flag. So a write that lands while a freshly keyed list is
 * loading — the vault's upload settling just as a typed search switches the
 * list key — left the list on an answer read before the write, with nothing
 * scheduled to correct it.
 */
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import { invalidateKeys } from "@/lib/query-keys";

const KEY = ["documents", "inbound", "list", { q: "probe" }] as const;

describe("invalidateKeys", () => {
  let client: QueryClient;
  let unsubscribe: () => void = () => {};

  afterEach(() => {
    unsubscribe();
    client.clear();
  });

  it("refetches a query whose first fetch was in flight when the write landed", async () => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    // Server state: empty until the write commits.
    let stored: string[] = [];
    let release: () => void = () => {};
    let calls = 0;
    const queryFn = () => {
      calls += 1;
      // The first read is taken before the write commits and answers after.
      const snapshot = [...stored];
      if (calls === 1) {
        return new Promise<string[]>((resolve) => {
          release = () => resolve(snapshot);
        });
      }
      return Promise.resolve(snapshot);
    };

    const observer = new QueryObserver(client, { queryKey: KEY, queryFn });
    unsubscribe = observer.subscribe(() => {});
    expect(client.getQueryState(KEY)?.fetchStatus).toBe("fetching");

    // The write commits, then the client invalidates — while the first
    // read is still in flight.
    stored = ["probe.pdf"];
    const settled = invalidateKeys(client, [["documents"]]);
    release();
    await settled;

    expect(client.getQueryData(KEY)).toEqual(["probe.pdf"]);
    expect(calls).toBe(2);
  });

  it("does not refetch a query that already holds data more than once", async () => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    let calls = 0;
    const observer = new QueryObserver(client, {
      queryKey: KEY,
      queryFn: () => {
        calls += 1;
        return Promise.resolve([`v${calls}`]);
      },
    });
    unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    const before = calls;

    await invalidateKeys(client, [["documents"]]);

    expect(calls).toBe(before + 1);
    expect(client.getQueryData(KEY)).toEqual([`v${before + 1}`]);
  });
});
