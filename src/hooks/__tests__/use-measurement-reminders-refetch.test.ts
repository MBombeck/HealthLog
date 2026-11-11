import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { invalidateReminderReads } from "@/hooks/use-measurement-reminders";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.32.19 — a Vorsorge reminder marked done (or created / edited / deleted)
 * is the exact Hero-dose analog on the Today rail. Its mutations run
 * `invalidateReminderReads`, which must NOT only invalidate the reminders root
 * (that leaves the digest + dashboard snapshot stale-but-unrefetched while the
 * user is on the Vorsorge section) but ALSO force those two inactive daily
 * reads to refetch — otherwise the reminder lingers on the Today rail until
 * the 120 s poll. This pins the actual refetch behaviour, not just an
 * invalidation.
 */
function fakeQueryClient(): QueryClient {
  return {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
    getQueryCache: () => ({ findAll: () => [] }),
  } as unknown as QueryClient;
}

describe("invalidateReminderReads — the Vorsorge daily-rail freshness contract", () => {
  it("invalidates the reminders root AND forces the inactive daily reads to refetch", async () => {
    const qc = fakeQueryClient();

    await invalidateReminderReads(qc);

    const calls = vi.mocked(qc.invalidateQueries).mock.calls;

    // The reminders root (drives the section list + the dashboard tile).
    const reminderKeys = calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey?: unknown }).queryKey),
    );
    expect(reminderKeys).toContain(JSON.stringify(["measurement-reminders"]));

    // The two daily reads must be invalidated with `refetchType: "inactive"` —
    // the ONLY variant that refetches them while unmounted on the Vorsorge
    // surface. A plain (active) invalidation would repeat the stale-hero bug.
    const inactive = calls.filter(
      ([arg]) =>
        (arg as { refetchType?: string } | undefined)?.refetchType ===
        "inactive",
    );
    const inactiveKeys = inactive.map(([arg]) =>
      JSON.stringify((arg as { queryKey?: unknown }).queryKey),
    );
    expect(inactiveKeys).toContain(JSON.stringify(["dashboard", "snapshot"]));
    expect(inactiveKeys).toContain(JSON.stringify(["daily", "digest"]));
  });

  it("refetches the Today rail while it is on screen", async () => {
    // The dashboard: the check-up tile and the Today rail are both mounted,
    // where the inactive pass alone fetches nothing.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.dailyDigest(),
      queryFn: async () => ++reads,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(reads).toBe(1));

    await invalidateReminderReads(client);

    expect(reads).toBe(2);
    unsubscribe();
    client.clear();
  });
});
