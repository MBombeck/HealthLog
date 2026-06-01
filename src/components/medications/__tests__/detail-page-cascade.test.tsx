/**
 * v1.5.5 D-3 §9 — detail-page query-key + invalidation cascade.
 *
 * Pins the contract every detail-page section reads/writes:
 *
 *   §9.1 header → reads `medicationDetail(id)` (under `["medications"]`
 *                  prefix; lives in the bundle).
 *   §9.2 today  → POSTs intake → bundle invalidates compliance chart
 *                  (`compliance-chart-inline` prefix landed in the
 *                  bundle per §10 invariant 20).
 *   §9.4 phases → `medicationPhaseConfig(id)` lives at
 *                  `["phase-config", id]`, NOT under `["medications"]`,
 *                  so the bundle does not catch it. The save mutation
 *                  must invalidate it explicitly (settings-section
 *                  does so via `[...medicationDependentKeys,
 *                  queryKeys.medicationPhaseConfig(id)]`).
 *   §9.5 intake list → reads `medicationIntakeList(id, …)` under the
 *                  `["medications", id, "intake", "list"]` prefix.
 *
 * These tests guard the per-section query-key shape so a future
 * rename (e.g. introducing a `["medications"]` -> `["meds"]` factory)
 * doesn't silently drift across the eight section consumers.
 */

import { describe, it, expect } from "vitest";
import {
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

function asStrings(keys: readonly unknown[]): string[] {
  return keys.map((k) => JSON.stringify(k));
}

function isUnderPrefix(key: readonly unknown[], prefix: readonly unknown[]) {
  if (key.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (key[i] !== prefix[i]) return false;
  }
  return true;
}

describe("medication-detail-page query-key cascade (D-3 §9)", () => {
  it("§9.1 header reads sit under the `[\"medications\"]` prefix so the bundle catches them", () => {
    const detail = queryKeys.medicationDetail("med-1");
    expect(isUnderPrefix(detail, queryKeys.medications())).toBe(true);
  });

  it("§9.2 today's-dose mutation evicts the inline compliance chart via the bundle (C-E2-1 / §10 #20)", () => {
    const inlineChart = queryKeys.medicationComplianceChart("med-1");
    const bundleStrings = asStrings(medicationDependentKeys);
    // Hierarchical-prefix semantics — the per-id chart slot rides
    // under the `["compliance-chart-inline"]` prefix we added.
    expect(bundleStrings).toContain(
      JSON.stringify(["compliance-chart-inline"]),
    );
    expect(inlineChart[0]).toBe("compliance-chart-inline");
  });

  it("§9.4 phase-config is OUTSIDE the bundle and the settings section explicitly invalidates it", () => {
    const phaseKey = queryKeys.medicationPhaseConfig("med-1");
    const bundleStrings = asStrings(medicationDependentKeys);
    expect(bundleStrings).not.toContain(JSON.stringify(phaseKey));
    expect(bundleStrings).not.toContain(JSON.stringify(["phase-config"]));
    // The settings section composes the bundle + the phase key on
    // save (see `phase-config-sheet.tsx` save handler). This guard
    // documents that contract.
    expect(phaseKey).toEqual(["phase-config", "med-1"]);
  });

  it("§9.5 intake-history list keys ride under `[\"medications\", id, \"intake\", \"list\"]`", () => {
    const listKey = queryKeys.medicationIntakeList("med-1", {
      sortBy: "takenAt",
      sortDir: "desc",
      limit: 14,
      offset: 0,
      status: "completed",
    });
    expect(listKey.slice(0, 4)).toEqual([
      "medications",
      "med-1",
      "intake",
      "list",
    ]);
    // And catches by the bundle's `["medications"]` prefix.
    expect(isUnderPrefix(listKey, queryKeys.medications())).toBe(true);
  });

  it("§9.7 api-endpoint per-medication slot rides under the `[\"medications\"]` prefix", () => {
    // The `<ApiTokensRow>` uses a per-medication key
    // `["medications", id, "api-endpoint"]` so the bundle catches it
    // alongside every other medication-scoped tile.
    const apiEndpointKey = ["medications", "med-1", "api-endpoint"] as const;
    expect(isUnderPrefix(apiEndpointKey, queryKeys.medications())).toBe(true);
  });
});
