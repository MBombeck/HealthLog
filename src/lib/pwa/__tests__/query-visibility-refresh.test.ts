import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MEANINGFUL_HIDDEN_INTERVAL_MS,
  subscribeToMeaningfulVisibilityRefresh,
} from "../query-client-options";

class FakeVisibilityDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";

  dispatchVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

function observeQuery(
  client: QueryClient,
  options: ConstructorParameters<typeof QueryObserver>[1],
) {
  const observer = new QueryObserver(client, options);
  return observer.subscribe(() => {});
}

describe("meaningful visibility refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores the initial visible event and a below-threshold tab switch", () => {
    const document = new FakeVisibilityDocument();
    const client = new QueryClient();
    const refetch = vi.spyOn(client, "refetchQueries");
    const unsubscribe = subscribeToMeaningfulVisibilityRefresh(
      client,
      document,
    );

    document.dispatchVisibility("visible");
    document.dispatchVisibility("hidden");
    vi.advanceTimersByTime(MEANINGFUL_HIDDEN_INTERVAL_MS - 1);
    document.dispatchVisibility("visible");

    expect(refetch).not.toHaveBeenCalled();

    unsubscribe();
    client.clear();
  });

  it("refreshes exactly once at the threshold despite repeated visibility events", () => {
    const document = new FakeVisibilityDocument();
    const client = new QueryClient();
    const refetch = vi.spyOn(client, "refetchQueries");
    const unsubscribe = subscribeToMeaningfulVisibilityRefresh(
      client,
      document,
    );

    document.dispatchVisibility("hidden");
    document.dispatchVisibility("hidden");
    vi.advanceTimersByTime(MEANINGFUL_HIDDEN_INTERVAL_MS);
    document.dispatchVisibility("visible");
    document.dispatchVisibility("visible");

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith({ type: "active", stale: true });

    unsubscribe();
    client.clear();
  });

  it("refetches only active stale enabled queries", async () => {
    const document = new FakeVisibilityDocument();
    const client = new QueryClient();
    const activeStaleFetch = vi.fn(async () => "active-stale-refetched");
    const activeFreshFetch = vi.fn(async () => "active-fresh-refetched");
    const inactiveFetch = vi.fn(async () => "inactive-refetched");
    const disabledFetch = vi.fn(async () => "disabled-refetched");

    client.setQueryDefaults(["inactive"], {
      queryFn: inactiveFetch,
      staleTime: 1,
    });

    client.setQueryData(["active-stale"], "seeded");
    client.setQueryData(["active-fresh"], "seeded");
    client.setQueryData(["inactive"], "seeded");
    client.setQueryData(["disabled"], "seeded");
    await client.invalidateQueries({
      queryKey: ["inactive"],
      refetchType: "none",
    });
    vi.advanceTimersByTime(1);

    const stopActiveStale = observeQuery(client, {
      queryKey: ["active-stale"],
      queryFn: activeStaleFetch,
      staleTime: 1,
      refetchOnMount: false,
    });
    const stopActiveFresh = observeQuery(client, {
      queryKey: ["active-fresh"],
      queryFn: activeFreshFetch,
      staleTime: Infinity,
      refetchOnMount: false,
    });
    const stopDisabled = observeQuery(client, {
      queryKey: ["disabled"],
      queryFn: disabledFetch,
      enabled: false,
      staleTime: 1,
    });

    const unsubscribe = subscribeToMeaningfulVisibilityRefresh(
      client,
      document,
    );
    document.dispatchVisibility("hidden");
    vi.advanceTimersByTime(MEANINGFUL_HIDDEN_INTERVAL_MS);
    document.dispatchVisibility("visible");
    await Promise.resolve();

    expect(activeStaleFetch).toHaveBeenCalledTimes(1);
    expect(activeFreshFetch).not.toHaveBeenCalled();
    expect(inactiveFetch).not.toHaveBeenCalled();
    expect(disabledFetch).not.toHaveBeenCalled();

    unsubscribe();
    stopActiveStale();
    stopActiveFresh();
    stopDisabled();
    client.clear();
  });

  it("removes its visibility listener during cleanup", () => {
    const document = new FakeVisibilityDocument();
    const client = new QueryClient();
    const refetch = vi.spyOn(client, "refetchQueries");
    const unsubscribe = subscribeToMeaningfulVisibilityRefresh(
      client,
      document,
    );

    unsubscribe();
    document.dispatchVisibility("hidden");
    vi.advanceTimersByTime(MEANINGFUL_HIDDEN_INTERVAL_MS);
    document.dispatchVisibility("visible");

    expect(refetch).not.toHaveBeenCalled();

    client.clear();
  });
});
