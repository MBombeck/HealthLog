/**
 * v1.30.22 — structural guard on the module→data ownership table.
 *
 * The three MCP leaks all had one root cause: the layer assumed every read
 * inherits gating from `buildCoachSnapshot`, which is true for the
 * Coach-routed tools and false for the families that deliberately bypass it.
 * Fixing the three call sites alone would leave the assumption in place, so
 * the ownership map moved to a shared table and the rich reads gate off it.
 *
 * WHAT THIS TEST FREEZES
 *
 *   1. Every metric the rich reads can resolve has been LOOKED AT: it either
 *      has an owning module or is named in `UNSCOPED_REVIEWED_TYPES`. A new
 *      metric that lands in the resolver without either fails here, which is
 *      the specific way finding 2 was able to happen — metrics became
 *      resolvable over MCP without anyone deciding who owned them.
 *   2. The table stays consistent with the Coach snapshot's own narrowing, so
 *      the MCP wire and the Coach prompt cannot drift into disagreeing about
 *      which module owns which domain.
 *   3. `UNSCOPED_REVIEWED_TYPES` stays a review record, not a dumping ground:
 *      an entry that later gains an owner must leave the list.
 *
 * WHAT IT CANNOT PROVE — read this before trusting it
 *
 *   - It does NOT prove any read calls the gate. A future `getMetricSummary`
 *     that calls `resolveRichMetric` directly instead of the module-aware
 *     resolver would leak exactly as before and this test would stay green.
 *     Only the per-read tests in `mcp/__tests__/rich-reads-module-gate.test.ts`
 *     cover that, and only for the reads that exist today. There is no
 *     compile-time barrier stopping a new caller from reaching the ungated
 *     resolver — `resolveRichMetric` is still exported because
 *     `build-efficacy` and the tests use it for pure resolvability checks.
 *   - It does NOT prove the OWNERSHIP assignments are correct, only that they
 *     exist. Mapping SLEEP_SCORE to `sleep` is a human judgement; if it truly
 *     belonged to `recovery`, this test would be just as green.
 *   - It says nothing about the surfaces that gate on a module key directly
 *     rather than through a metric (`insights` for correlations, `doctorReport`
 *     for the aggregate). Those are covered by their own tests.
 */
import { describe, it, expect } from "vitest";

import {
  MODULE_SCOPED_SOURCES,
  UNSCOPED_REVIEWED_TYPES,
  moduleForMeasurementType,
} from "../measurement-scope";
import { MODULE_KEYS, type ModuleKey } from "../gate";
import {
  MCP_METRIC_STATUS_DISCOVERY,
  MCP_CLINICAL_SIGNALS,
  resolveRichMetric,
} from "@/lib/mcp/rich-reads";
import { METRIC_STATUS_IDS } from "@/lib/insights/metric-status-registry";

/**
 * Every `MeasurementType` reachable through the rich-read resolver, collected
 * the way an assistant would actually reach them: the discovery listings plus
 * every metric-status id the resolver accepts by exact id.
 */
function resolvableTypes(): Set<string> {
  const out = new Set<string>();
  for (const sig of MCP_METRIC_STATUS_DISCOVERY) out.add(sig.measurementType);
  for (const sig of MCP_CLINICAL_SIGNALS) out.add(sig.measurementType);
  for (const id of METRIC_STATUS_IDS) {
    const m = resolveRichMetric(id);
    if (m) out.add(m.measurementType);
  }
  for (const name of ["weight", "pulse", "bmi", "glucose", "sleep", "hrv"]) {
    const m = resolveRichMetric(name);
    if (m) out.add(m.measurementType);
  }
  return out;
}

describe("module→data ownership table", () => {
  it("has an owner or a written review decision for every resolvable metric", () => {
    const unreviewed = [...resolvableTypes()].filter(
      (t) =>
        moduleForMeasurementType(t as never) === null &&
        !UNSCOPED_REVIEWED_TYPES.has(t as never),
    );

    // A failure here is not a bug to suppress: a metric became readable over
    // MCP without anyone deciding whether a module owns it. Either add it to
    // `METRIC_STATUS_MODULE_OWNERS` or record it in `UNSCOPED_REVIEWED_TYPES`
    // with a reason.
    expect(unreviewed).toEqual([]);
  });

  it("never assigns a metric to a module key that does not exist", () => {
    for (const type of resolvableTypes()) {
      const owner = moduleForMeasurementType(type as never);
      if (owner) expect(MODULE_KEYS).toContain(owner);
    }
  });

  it("keeps the reviewed-unscoped list free of metrics that now have an owner", () => {
    const stale = [...UNSCOPED_REVIEWED_TYPES].filter(
      (t) => moduleForMeasurementType(t) !== null,
    );
    expect(stale).toEqual([]);
  });

  it("scopes only module keys that actually exist", () => {
    for (const key of Object.keys(MODULE_SCOPED_SOURCES)) {
      expect(MODULE_KEYS).toContain(key as ModuleKey);
    }
  });

  it("resolves the domains the audit named to the modules that own them", () => {
    // Spot-checks with real consequences: these are the exact pairings where
    // `get_metric_series` (gated, via the snapshot) and `get_metric_baseline`
    // (ungated, before this change) disagreed for the same account.
    expect(moduleForMeasurementType("BLOOD_GLUCOSE")).toBe("glucose");
    expect(moduleForMeasurementType("SLEEP_DURATION")).toBe("sleep");
    expect(moduleForMeasurementType("HEART_RATE_VARIABILITY")).toBe("recovery");
    expect(moduleForMeasurementType("HRV_RMSSD")).toBe("recovery");
    expect(moduleForMeasurementType("SLEEP_SCORE")).toBe("sleep");
    expect(moduleForMeasurementType("BREATHING_DISTURBANCES")).toBe("sleep");
    expect(moduleForMeasurementType("DAY_STRAIN")).toBe("workouts");
    expect(moduleForMeasurementType("WORKOUT_STRAIN")).toBe("workouts");
    expect(moduleForMeasurementType("CARDIO_LOAD")).toBe("workouts");
    expect(moduleForMeasurementType("ANS_CHARGE")).toBe("recovery");
    expect(moduleForMeasurementType("CARDIO_RECOVERY")).toBe("recovery");
    expect(moduleForMeasurementType("BLOOD_KETONES")).toBe("glucose");
  });

  it("gives every module-owned checkup type the module the checkup job gates on", () => {
    // The checkup job reads this table; a screening checkup must fall silent
    // with the mental-health module, a ketone one with Glucose.
    for (const type of [
      "PHQ9_SCORE",
      "GAD7_SCORE",
      "WHO5_SCORE",
      "SCI_SCORE",
    ] as const) {
      expect(moduleForMeasurementType(type), type).toBe("mentalHealth");
    }
  });

  it("leaves the core clinical figures unowned on purpose", () => {
    // Gating these would hide data behind a toggle the user never associated
    // with them. Pinned so a future broad-brush "gate everything" change has
    // to argue with a test.
    expect(moduleForMeasurementType("WEIGHT")).toBeNull();
    expect(moduleForMeasurementType("PULSE")).toBeNull();
    expect(moduleForMeasurementType("BLOOD_PRESSURE_SYS")).toBeNull();
    expect(moduleForMeasurementType("BODY_MASS_INDEX")).toBeNull();
  });
});
