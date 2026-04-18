import { describe, it, expect, vi } from "vitest";
import {
  queryKeys,
  measurementDependentKeys,
  moodDependentKeys,
  medicationDependentKeys,
  invalidateKeys,
} from "../query-keys";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

describe("queryKeys factory", () => {
  it("returns stable tuples for simple keys", () => {
    expect(queryKeys.measurements()).toEqual(["measurements"]);
    expect(queryKeys.analytics()).toEqual(["analytics"]);
    expect(queryKeys.moodEntries()).toEqual(["mood-entries"]);
  });

  it("includes locale in insights status keys", () => {
    expect(queryKeys.insightsGeneralStatus("en")).toEqual([
      "insights",
      "general-status",
      "en",
    ]);
  });
});

describe("dependent-key bundles", () => {
  it("measurementDependentKeys invalidates analytics/insights/targets", () => {
    const keyStrings = measurementDependentKeys.map((k) =>
      JSON.stringify(k),
    );
    expect(keyStrings).toContain(JSON.stringify(["measurements"]));
    expect(keyStrings).toContain(JSON.stringify(["analytics"]));
    expect(keyStrings).toContain(JSON.stringify(["insights"]));
    expect(keyStrings).toContain(JSON.stringify(["insights", "targets"]));
    expect(keyStrings).toContain(
      JSON.stringify(["gamification", "achievements"]),
    );
  });

  it("moodDependentKeys bundle covers mood + analytics + targets", () => {
    const keyStrings = moodDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["mood-entries"]));
    expect(keyStrings).toContain(JSON.stringify(["mood-analytics"]));
    expect(keyStrings).toContain(JSON.stringify(["insights"]));
  });

  it("medicationDependentKeys bundle covers medications + analytics + achievements", () => {
    const keyStrings = medicationDependentKeys.map((k) => JSON.stringify(k));
    expect(keyStrings).toContain(JSON.stringify(["medications"]));
    expect(keyStrings).toContain(JSON.stringify(["analytics"]));
    expect(keyStrings).toContain(
      JSON.stringify(["gamification", "achievements"]),
    );
  });
});

describe("invalidateKeys", () => {
  it("calls invalidateQueries for every key in the bundle", async () => {
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const client = { invalidateQueries: invalidate } as unknown as QueryClient;
    const keys: QueryKey[] = [["a"], ["b", "c"], ["d"]];

    await invalidateKeys(client, keys);

    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenNthCalledWith(1, { queryKey: ["a"] });
    expect(invalidate).toHaveBeenNthCalledWith(2, { queryKey: ["b", "c"] });
    expect(invalidate).toHaveBeenNthCalledWith(3, { queryKey: ["d"] });
  });

  it("continues on partial failure (allSettled semantics)", async () => {
    const invalidate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const client = { invalidateQueries: invalidate } as unknown as QueryClient;
    const keys: QueryKey[] = [["a"], ["b"], ["c"]];

    const results = await invalidateKeys(client, keys);

    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("fulfilled");
  });
});
