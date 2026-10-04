import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { QUERY_CLIENT_DEFAULT_OPTIONS } from "@/lib/pwa/query-client-options";
import { queryKeys } from "@/lib/query-keys";
import {
  __resetRecordScopeForTests,
  setRecordScope,
} from "@/lib/query-keys/record-scope";
import {
  MEDICATIONS_PREFETCH_COVERS_MOUNT_MS,
  forgetMedicationsPrefetch,
  prefetchMedicationsList,
  refetchMedicationsOnMount,
} from "../prefetch-medications";

function envelopeResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  __resetRecordScopeForTests();
  forgetMedicationsPrefetch();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("prefetchMedicationsList", () => {
  it("does not park an aborted shared-record preload in the own-record cache", async () => {
    setRecordScope("shared-record");
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS,
    });

    prefetchMedicationsList(client, controller.signal);
    controller.abort();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    setRecordScope(null);

    expect(client.getQueryData(queryKeys.medications())).toBeUndefined();
    expect(
      client.getQueryData(queryKeys.medicationComplianceSummary()),
    ).toBeUndefined();
  });

  it("passes a lifecycle signal to both record reads", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(envelopeResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS,
    });

    prefetchMedicationsList(client, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      signal: controller.signal,
    });
  });
});

/**
 * The page cells re-verify on every mount (#316), but a prefetch fired by the
 * same navigation already is that fresh read. Before, the hover / route-commit
 * prefetch landed and the mount sent the identical request again, on every
 * visit, for both the list and the compliance summary.
 */
describe("refetchMedicationsOnMount", () => {
  function setup() {
    const fetchMock = vi.fn(async () => envelopeResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS,
    });
    const calls = (path: string) =>
      fetchMock.mock.calls.filter((call) => (call as unknown[])[0] === path)
        .length;
    return { client, calls };
  }

  /** Mount a page observer the way the medications page does. */
  async function mountList(client: QueryClient) {
    const mountFetch = vi.fn(async () => []);
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.medications(),
      queryFn: mountFetch,
      refetchOnMount: refetchMedicationsOnMount("list"),
    });
    const unsubscribe = observer.subscribe(() => {});
    await Promise.resolve();
    return { refetched: mountFetch.mock.calls.length > 0, unsubscribe };
  }

  it("does not repeat a prefetch this navigation just answered", async () => {
    const { client, calls } = setup();
    prefetchMedicationsList(client);
    await vi.waitFor(() => expect(calls("/api/medications")).toBe(1));
    await vi.waitFor(() =>
      expect(client.getQueryState(queryKeys.medications())?.status).toBe(
        "success",
      ),
    );

    const { refetched, unsubscribe } = await mountList(client);
    expect(refetched).toBe(false);
    unsubscribe();
  });

  it("refetches a prefetched read that was invalidated before the mount", async () => {
    // Hover the nav link, then log a dose elsewhere before the page mounts:
    // the dose invalidates the medication reads, and the prefetched answer
    // no longer holds the compliance the user just changed.
    const { client, calls } = setup();
    prefetchMedicationsList(client);
    await vi.waitFor(() => expect(calls("/api/medications")).toBe(1));
    await vi.waitFor(() =>
      expect(client.getQueryState(queryKeys.medications())?.status).toBe(
        "success",
      ),
    );
    await client.invalidateQueries({ queryKey: queryKeys.medications() });
    expect(client.getQueryState(queryKeys.medications())?.isInvalidated).toBe(
      true,
    );

    const { refetched, unsubscribe } = await mountList(client);
    expect(refetched).toBe(true);
    unsubscribe();
  });

  it("still refetches on mount when the cache holds an older read", async () => {
    const { client } = setup();
    const queryFn = vi.fn(async () => []);
    await client.fetchQuery({ queryKey: queryKeys.medications(), queryFn });

    const { refetched, unsubscribe } = await mountList(client);
    // No prefetch answered this visit: the #316 re-verification runs.
    expect(refetched).toBe(true);
    unsubscribe();
  });

  it("refetches once the prefetch is older than the visit window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { client, calls } = setup();
    prefetchMedicationsList(client);
    await vi.waitFor(() =>
      expect(client.getQueryState(queryKeys.medications())?.status).toBe(
        "success",
      ),
    );
    expect(calls("/api/medications")).toBe(1);

    vi.setSystemTime(Date.now() + MEDICATIONS_PREFETCH_COVERS_MOUNT_MS + 1);
    const { refetched, unsubscribe } = await mountList(client);
    expect(refetched).toBe(true);
    unsubscribe();
  });

  it("a prefetch skipped as fresh does not excuse the mount refetch", async () => {
    // The return-visit case: the list was read moments ago by a mount, so
    // the nav-link prefetch does not go to the network, and the remount
    // must still re-verify.
    const { client, calls } = setup();
    await client.fetchQuery({
      queryKey: queryKeys.medications(),
      queryFn: async () => [],
    });
    prefetchMedicationsList(client);
    await Promise.resolve();
    expect(calls("/api/medications")).toBe(0);

    const { refetched, unsubscribe } = await mountList(client);
    expect(refetched).toBe(true);
    unsubscribe();
  });

  it("a prefetch from an earlier visit does not excuse a later mount", async () => {
    // Load the page (route-commit prefetch), leave, come straight back: the
    // nav-link prefetch finds the entry fresh and stays off the network, so
    // only the mount can re-verify, and it must.
    const { client, calls } = setup();
    prefetchMedicationsList(client);
    await vi.waitFor(() =>
      expect(client.getQueryState(queryKeys.medications())?.status).toBe(
        "success",
      ),
    );
    const first = await mountList(client);
    expect(first.refetched).toBe(false);
    first.unsubscribe();

    forgetMedicationsPrefetch(); // the route left /medications
    prefetchMedicationsList(client); // hover on the way back: still fresh
    expect(calls("/api/medications")).toBe(1);

    const second = await mountList(client);
    expect(second.refetched).toBe(true);
    second.unsubscribe();
  });
});
