/**
 * Registry invariants — the drift guard that pins the SIGNAL REGISTRY to the
 * values the per-surface tables carry today. Any edit that changes a derived
 * table (FHIR coding, correlation eligibility, metric-status metadata) without
 * intentionally updating the golden master fails here, so a registry flip stays
 * a byte-for-byte no-op and accidental cross-surface drift cannot land.
 *
 * Golden masters under `./fixtures/*` were extracted verbatim from the
 * hand-maintained tables at the v1.25 branch base; update them deliberately
 * (and in lock-step with the registry) when a value genuinely changes.
 */
import { describe, expect, it } from "vitest";

import {
  METRIC_STATUS_IDS,
  getMetricStatusMeta,
} from "@/lib/insights/metric-status-registry";
import { MEASUREMENT_LOINC } from "@/lib/fhir/loinc-map";
import { SIGNALS, allSignals, getSignal } from "@/lib/signals/registry";
import { deriveMetricStatusRegistry } from "@/lib/signals/adapters/metric-status";
import { deriveMeasurementLoinc } from "@/lib/signals/adapters/fhir";
import { deriveBucketedTypes } from "@/lib/signals/adapters/correlation";
import { BIOMARKER_CATALOG } from "@/lib/labs/biomarker-catalog";

import expectedMeasurementLoinc from "./fixtures/expected-measurement-loinc.json";
import expectedBucketedTypes from "./fixtures/expected-bucketed-types.json";

describe("signal registry — structural sanity", () => {
  it("every entry's key matches its record key", () => {
    for (const [key, signal] of Object.entries(SIGNALS)) {
      expect(signal.key).toBe(key);
    }
  });

  it("every signal carries a well-formed source for its kind", () => {
    for (const signal of allSignals()) {
      if (signal.kind === "biomarker") {
        expect(signal.source.biomarkerKey.length).toBeGreaterThan(0);
      } else if (signal.kind === "environment") {
        expect(signal.source.environmentChannelKey.length).toBeGreaterThan(0);
      } else {
        expect(signal.source.measurementType.length).toBeGreaterThan(0);
      }
    }
  });

  it("every biomarker signal's source key resolves to a real catalog slug", () => {
    // The declared registry↔labs bridge: a `kind: "biomarker"` signal's
    // `source.biomarkerKey` must name an actual `BIOMARKER_CATALOG` slug. The
    // length-only check above would let a typo (`"lpa"` vs `"lp-a"`) ride
    // through; this catches biomarker-slug drift the moment it lands.
    const catalogSlugs = new Set(BIOMARKER_CATALOG.map((b) => b.slug));
    for (const signal of allSignals()) {
      if (signal.kind === "biomarker") {
        expect(
          catalogSlugs.has(signal.source.biomarkerKey),
          `biomarker signal "${signal.key}" → unknown catalog slug "${signal.source.biomarkerKey}"`,
        ).toBe(true);
      }
    }
  });

  it("every Coach-snapshot signal is also MCP-readable", () => {
    // `mcp` and `coachSnapshot` are INDEPENDENT facets: a Coach-scoped signal
    // is always reachable over MCP (the Coach `get_metric_series` path), but a
    // signal can be MCP-readable WITHOUT a Coach scope (the v1.25 physical
    // signals, exposed only through the rollup-backed rich reads). So the
    // invariant is one-directional — coachSnapshot ⇒ mcp, never the reverse.
    for (const signal of allSignals()) {
      if (signal.surfaces.coachSnapshot !== false) {
        expect(signal.surfaces.mcp).toBe(true);
      }
    }
  });

  it("the physical clinical signals are MCP-readable but off the Coach snapshot", () => {
    for (const key of [
      "GRIP_STRENGTH",
      "PAIN_NRS",
      "WAIST_CIRCUMFERENCE",
      "WAIST_TO_HEIGHT",
    ]) {
      const signal = getSignal(key);
      expect(signal, `${key} missing from registry`).not.toBeNull();
      expect(signal!.surfaces.mcp).toBe(true);
      expect(signal!.surfaces.coachSnapshot).toBe(false);
    }
  });

  it("the mental-health screeners and environmental signals stay off MCP", () => {
    for (const key of ["PHQ9_SCORE", "GAD7_SCORE"]) {
      const signal = getSignal(key);
      expect(signal, `${key} missing from registry`).not.toBeNull();
      expect(signal!.surfaces.mcp).toBe(false);
    }
    for (const signal of allSignals()) {
      if (signal.kind === "environment") {
        expect(signal.surfaces.mcp, `${signal.key} must stay off MCP`).toBe(
          false,
        );
      }
    }
  });

  it("no two measurement/score signals back the same measurement type", () => {
    const types: string[] = [];
    for (const signal of allSignals()) {
      if (signal.kind !== "measurement" && signal.kind !== "score") continue;
      types.push(signal.source.measurementType);
    }
    expect(new Set(types).size).toBe(types.length);
  });
});

describe("signal registry — metric-status projection equals the live table", () => {
  it("registers every generic metric-status id", () => {
    for (const id of METRIC_STATUS_IDS) {
      expect(getSignal(id)).not.toBeNull();
    }
  });

  it("derives each MetricStatusMeta byte-for-byte from the registry", () => {
    const derived = deriveMetricStatusRegistry();
    for (const id of METRIC_STATUS_IDS) {
      expect(derived[id]).toEqual(getMetricStatusMeta(id));
    }
  });
});

describe("signal registry — FHIR table is byte-identical", () => {
  it("derives MEASUREMENT_LOINC equal to the golden master", () => {
    expect(deriveMeasurementLoinc()).toEqual(expectedMeasurementLoinc);
  });

  it("the live (flipped) MEASUREMENT_LOINC export equals the golden master", () => {
    expect(MEASUREMENT_LOINC).toEqual(expectedMeasurementLoinc);
  });
});

describe("signal registry — correlation table is byte-identical", () => {
  it("derives BUCKETED_TYPES equal to the golden master (set semantics)", () => {
    expect([...deriveBucketedTypes()].sort()).toEqual(
      [...(expectedBucketedTypes as string[])].sort(),
    );
  });
});
