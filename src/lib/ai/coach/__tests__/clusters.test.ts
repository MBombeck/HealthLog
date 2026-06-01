import { describe, expect, it } from "vitest";

import {
  CLUSTER_PRIORITY,
  CLUSTER_SOURCES,
  clusterSourcesFromPrefs,
  expandClusters,
  resolveClusters,
  sourceCluster,
} from "../clusters";
import {
  DEFAULT_COACH_CLUSTERS,
  coachDataClusterEnum,
} from "@/lib/validations/coach-prefs";

/**
 * v1.7.0 — cluster taxonomy + resolution. The snapshot builder leans on
 * this module for the default source expansion + the degradation
 * priority order; these tests pin the contract so a future taxonomy
 * edit can't silently drop a metric or scramble the priority.
 */
describe("coach clusters", () => {
  it("maps every cluster to at least one source", () => {
    for (const cluster of coachDataClusterEnum.options) {
      expect(CLUSTER_SOURCES[cluster].length).toBeGreaterThan(0);
    }
  });

  it("lists every cluster in the degradation priority order", () => {
    expect([...CLUSTER_PRIORITY].sort()).toEqual(
      [...coachDataClusterEnum.options].sort(),
    );
    // Highest-signal clinical clusters lead the priority list.
    expect(CLUSTER_PRIORITY[0]).toBe("medication");
    expect(CLUSTER_PRIORITY[1]).toBe("cardio");
    // Lowest-signal trails it.
    expect(CLUSTER_PRIORITY[CLUSTER_PRIORITY.length - 1]).toBe("environment");
  });

  it("reverse-maps every source to its owning cluster", () => {
    for (const cluster of coachDataClusterEnum.options) {
      for (const source of CLUSTER_SOURCES[cluster]) {
        expect(sourceCluster(source)).toBe(cluster);
      }
    }
  });

  it("resolves undefined prefs to the legacy default cluster set", () => {
    expect(resolveClusters(undefined)).toEqual(DEFAULT_COACH_CLUSTERS);
  });

  it("honours an explicit empty array as everything-off", () => {
    expect(resolveClusters([])).toEqual([]);
    expect(expandClusters([]).size).toBe(0);
  });

  it("expands the default clusters to the legacy core sources + additive members", () => {
    const sources = clusterSourcesFromPrefs(undefined);
    // Legacy five domains' sources are all present.
    for (const core of ["bp", "weight", "pulse", "mood", "compliance"] as const) {
      expect(sources.has(core)).toBe(true);
    }
    // Additive members ride inside cardio/body.
    expect(sources.has("hrv")).toBe(true);
    expect(sources.has("body_fat")).toBe(true);
    // OFF-by-default clusters contribute nothing.
    expect(sources.has("steps")).toBe(false);
    expect(sources.has("glucose")).toBe(false);
    expect(sources.has("workouts")).toBe(false);
  });

  it("expands a full opt-in to every source across all clusters", () => {
    const all = expandClusters(coachDataClusterEnum.options);
    expect(all.has("glucose")).toBe(true);
    expect(all.has("workouts")).toBe(true);
    expect(all.has("walking_speed")).toBe(true);
    expect(all.has("audio_env")).toBe(true);
  });

  it("dedupes when expanding", () => {
    const cardio = expandClusters(["cardio"]);
    const cardioTwice = expandClusters(["cardio", "cardio"]);
    expect(cardioTwice.size).toBe(cardio.size);
  });
});
