/**
 * v1.8.0 — measurement-driven per-metric assessment invalidation.
 *
 * A fresh measurement of a given type must re-warm the cached
 * `insights.<scope>-status.<locale>` rows for the scopes that reading
 * dirties, so the next mount (or the next nightly warm pass) reflects
 * the new data instead of serving the pre-measurement text for the rest
 * of the day. These tests pin the type → scope mapping, the debounce,
 * and (v1.16.8) that the invalidator enqueues regenerations WITHOUT
 * deleting the cache rows — the worker's forced generation runs the
 * generator's content-hash gate, which decides whether the data
 * actually changed; keeping the row preserves stale-while-revalidate
 * and lets a re-synced unchanged batch cost zero LLM calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteMany = vi.fn();
const noteFindMany = vi.fn();
const aiCapabilityForRecord = vi.fn();
const enqueueStatusGeneration = vi.fn();
const userFindUnique = vi.fn();
const measurementFindMany = vi.fn();
// v1.42 — type discovery goes through the loose-index-scan helper; the
// rows it answers with are the types themselves.
const listLiveTypes = vi.fn();
const measurementGroupBy = {
  mockResolvedValue: (rows: Array<{ type: string }>) =>
    listLiveTypes.mockResolvedValue(rows.map((row) => row.type)),
  mockRejectedValue: (err: Error) => listLiveTypes.mockRejectedValue(err),
};

vi.mock("@/lib/measurements/live-types", () => ({
  listLiveMeasurementTypes: (...a: unknown[]) => listLiveTypes(...a),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    insightStatusCache: {
      deleteMany: (...a: unknown[]) => deleteMany(...a),
      findMany: (...a: unknown[]) => noteFindMany(...a),
    },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    measurement: {
      findMany: (...a: unknown[]) => measurementFindMany(...a),
    },
  },
}));

vi.mock("@/lib/jobs/insight-status-generate-shared", () => ({
  enqueueStatusGeneration: (...a: unknown[]) => enqueueStatusGeneration(...a),
}));

vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: (...a: unknown[]) => aiCapabilityForRecord(...a),
  aiCapabilityToServe: (...args: unknown[]) =>
    (aiCapabilityForRecord as (...a: unknown[]) => unknown)(...args),
  aiCapabilityForJob: vi.fn(async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  })),
}));

const UNAVAILABLE = {
  available: false,
  reason: "user_disabled",
  onDeviceAllowed: false,
};

import {
  enqueueStatusRefillForUser,
  invalidateStatusInsightsForTypes,
} from "../comprehensive-generate";

beforeEach(() => {
  vi.clearAllMocks();
  deleteMany.mockResolvedValue({ count: 0 });
  // Default: no recently-warmed cache rows, so every dirtied scope is stale
  // and refreshes — the pre-debounce contract the bulk of these tests pin.
  noteFindMany.mockResolvedValue([]);
  aiCapabilityForRecord.mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
  enqueueStatusGeneration.mockResolvedValue(undefined);
  userFindUnique.mockResolvedValue({ locale: "de" });
  measurementFindMany.mockResolvedValue([]);
  measurementGroupBy.mockResolvedValue([]);
});

/** Distinct scopes the invalidator enqueued a regenerate for. */
function enqueuedScopes(): string[] {
  return [
    ...new Set(
      enqueueStatusGeneration.mock.calls.map(
        (c) => (c[0] as { metric: string }).metric,
      ),
    ),
  ].sort();
}

describe("invalidateStatusInsightsForTypes", () => {
  it("maps WEIGHT to weight + bmi + general", async () => {
    await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
    expect(enqueuedScopes()).toEqual(["bmi", "general", "weight"]);
    expect(
      enqueueStatusGeneration.mock.calls.every(
        (c) => (c[0] as { userId: string }).userId === "u1",
      ),
    ).toBe(true);
  });

  it("never deletes the cached assessment rows (v1.16.8 — hash gate decides)", async () => {
    await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
    // The rows stay for stale-while-revalidate AND for the content-hash
    // gate the worker's forced regeneration runs; deleting them here would
    // force a full LLM regeneration even for a re-synced unchanged batch.
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("maps both blood-pressure components to blood-pressure + general", async () => {
    await invalidateStatusInsightsForTypes("u1", [
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
    ]);
    expect(enqueuedScopes()).toEqual(["blood-pressure", "general"]);
  });

  it("maps PULSE and RESTING_HEART_RATE to pulse + general (+ the resting-HR generic scope)", async () => {
    await invalidateStatusInsightsForTypes("u1", [
      "PULSE",
      "RESTING_HEART_RATE",
    ]);
    // PULSE feeds the specialised pulse + general scopes; RESTING_HEART_RATE
    // feeds those too AND carries its own generic assessment card
    // (`metric:RESTING_HEART_RATE`), so all three are dirtied.
    expect(enqueuedScopes()).toEqual([
      "general",
      "metric:RESTING_HEART_RATE",
      "pulse",
    ]);
  });

  it("maps a metric with no specialised scope to general + its generic scope", async () => {
    // BLOOD_GLUCOSE has no specialised assessment, but v1.8.7.1 gives it a
    // generic `metric:BLOOD_GLUCOSE` card, so a fresh reading dirties the
    // general overview AND that generic scope.
    await invalidateStatusInsightsForTypes("u1", ["BLOOD_GLUCOSE"]);
    expect(enqueuedScopes()).toEqual(["general", "metric:BLOOD_GLUCOSE"]);
  });

  it("dedupes scopes across a mixed batch", async () => {
    await invalidateStatusInsightsForTypes("u1", [
      "WEIGHT",
      "PULSE",
      "BLOOD_GLUCOSE",
    ]);
    // weight + bmi + general (WEIGHT) ∪ pulse + general (PULSE) ∪
    // general + metric:BLOOD_GLUCOSE (BLOOD_GLUCOSE)
    expect(enqueuedScopes()).toEqual([
      "bmi",
      "general",
      "metric:BLOOD_GLUCOSE",
      "pulse",
      "weight",
    ]);
  });

  it("is a no-op for an empty type set (no DB call)", async () => {
    await invalidateStatusInsightsForTypes("u1", []);
    expect(noteFindMany).not.toHaveBeenCalled();
    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
  });

  it("enqueues nothing while statusText is unavailable for the record", async () => {
    aiCapabilityForRecord.mockResolvedValue(UNAVAILABLE);
    await invalidateStatusInsightsForTypes("u1", ["WEIGHT", "PULSE"]);
    expect(aiCapabilityForRecord).toHaveBeenCalledWith("u1", "statusText");
    expect(noteFindMany).not.toHaveBeenCalled();
    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
  });

  it("enqueues a debounced regenerate for every dirtied scope, the user's locale only", async () => {
    userFindUnique.mockResolvedValue({ locale: "de" });
    await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
    // weight + bmi + general, each warmed once for the user's resolved locale.
    expect(enqueuedScopes()).toEqual(["bmi", "general", "weight"]);
    expect(enqueueStatusGeneration).toHaveBeenCalledTimes(3);
    const locales = new Set(
      enqueueStatusGeneration.mock.calls.map(
        (c) => (c[0] as { locale: string }).locale,
      ),
    );
    expect([...locales]).toEqual(["de"]);
  });

  it("resolves the user's locale (en) for the regenerate, never the unused one", async () => {
    userFindUnique.mockResolvedValue({ locale: "en" });
    await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
    const locales = new Set(
      enqueueStatusGeneration.mock.calls.map(
        (c) => (c[0] as { locale: string }).locale,
      ),
    );
    expect([...locales]).toEqual(["en"]);
  });

  it("does not blanket-dirty general for an unrelated synced type", async () => {
    // A steps sample touches only the general overview, never the weight /
    // pulse / bp scopes — the constant Apple-Health sync must not thrash
    // every card's cache.
    await invalidateStatusInsightsForTypes("u1", ["ACTIVITY_STEPS"]);
    expect(enqueuedScopes()).toEqual(["general", "metric:STEPS"]);
  });

  it("re-warms the matching generic metric scope for a registered type", async () => {
    // v1.8.7.1 — a blood-glucose sample dirties the general overview AND
    // its own generic assessment card (`metric:BLOOD_GLUCOSE`), so the
    // freshly-synced metric's card refreshes in the background instead of
    // lagging until the nightly warm pass.
    await invalidateStatusInsightsForTypes("u1", ["BLOOD_GLUCOSE"]);
    expect(enqueuedScopes()).toEqual(["general", "metric:BLOOD_GLUCOSE"]);
  });

  it("maps a remapped MeasurementType to its registry metric id", async () => {
    // ACTIVE_ENERGY_BURNED is stored under that DB type but the generic
    // metric id (route param + cache scope) is ACTIVE_ENERGY.
    await invalidateStatusInsightsForTypes("u1", ["ACTIVE_ENERGY_BURNED"]);
    expect(enqueuedScopes()).toEqual(["general", "metric:ACTIVE_ENERGY"]);
  });

  it("does not emit a generic scope for an unregistered type", async () => {
    // A weight sample feeds weight + bmi + general; WEIGHT is one of the
    // seven specialised metrics and has no generic registry entry, so no
    // `metric:` scope is enqueued.
    await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
    expect(enqueuedScopes()).toEqual(["bmi", "general", "weight"]);
    expect(enqueuedScopes().some((s) => s.startsWith("metric:"))).toBe(false);
  });

  describe("ingest-invalidation debounce (v1.9.0; a 1 h minimum gap since v1.16.8)", () => {
    /** A recent (within-window) stored note, as the probe selects it. */
    function freshRow(scope: string, locale = "de") {
      return { metric: scope, locale };
    }

    it("skips a scope whose assessment was warmed within the gap", async () => {
      // `general` was regenerated within the gap; a fresh WEIGHT sample
      // must not re-enqueue it. weight + bmi are still stale, so they refresh.
      noteFindMany.mockResolvedValue([freshRow("general")]);
      await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
      expect(enqueuedScopes()).toEqual(["bmi", "weight"]);
    });

    it("re-enqueues a scope warmed longer than the gap ago (the hash gate meters cost)", async () => {
      // The DB probe is cutoff-filtered, so a scope last warmed before the
      // gap simply does not come back as fresh — it re-enqueues even though
      // a cache row exists. The worker's forced run lands on the content-
      // hash gate, which makes a no-change run a free timestamp refresh —
      // this is what lets same-day data be narrated same-day without
      // reopening the per-batch regeneration storm.
      noteFindMany.mockResolvedValue([]);
      await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
      expect(enqueuedScopes()).toEqual(["bmi", "general", "weight"]);
    });

    it("is a complete no-op (no enqueue) when every scope is fresh", async () => {
      noteFindMany.mockResolvedValue([
        freshRow("weight"),
        freshRow("bmi"),
        freshRow("general"),
      ]);
      await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
      expect(enqueueStatusGeneration).not.toHaveBeenCalled();
    });

    it("counts only a stored note as fresh, so a recently stalled scope still refreshes", async () => {
      // A row that carries only a negative-cache window has no note, so a
      // scope that recently stalled must retry rather than be debounced into
      // staying cold. The probe asks the database for noted rows only; with
      // none returned, every dirtied scope refreshes.
      await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
      const where = noteFindMany.mock.calls[0][0].where;
      expect(where.textEncrypted).toEqual({ not: null });
      expect(enqueuedScopes()).toEqual(["bmi", "general", "weight"]);
    });

    it("scopes the freshness probe to the user's resolved locale and a 1 h gap cutoff", async () => {
      userFindUnique.mockResolvedValue({ locale: "en" });
      const before = Date.now();
      await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
      const where = noteFindMany.mock.calls[0][0].where;
      expect(where.userId).toBe("u1");
      // Only the en notes for the dirtied scopes are probed.
      expect(
        new Set(
          (where.OR as { metric: string; locale: string }[]).map(
            (k) => `${k.metric}.${k.locale}`,
          ),
        ),
      ).toEqual(new Set(["weight.en", "bmi.en", "general.en"]));
      // The recency floor is ONE hour in the past. The 6 h wall this
      // started as kept same-day data from being narrated same-day (the
      // nightly warm restarted the window, so a morning reading stayed
      // un-narrated until tomorrow); the 1 h gap only bounds worker-run
      // frequency, while the worker's content-hash gate keeps an
      // unchanged re-run at zero LLM calls.
      const cutoff = (where.generatedAt.gte as Date).getTime();
      const oneHour = 60 * 60 * 1000;
      expect(before - cutoff).toBeGreaterThanOrEqual(oneHour - 5_000);
      expect(before - cutoff).toBeLessThanOrEqual(oneHour + 60_000);
    });
  });
});

// v1.16.8 — the manual comprehensive regenerate enqueues a hash-gated
// refill of the assessment cards instead of blanket-evicting them. The
// worker forces each enqueued scope past its same-day cache read, so the
// content-hash gate regenerates changed cards and refreshes unchanged
// ones for free — the hash baseline rows are never deleted.
describe("enqueueStatusRefillForUser", () => {
  it("enqueues the seven specialised scopes plus the user's data-bearing generic scopes", async () => {
    measurementGroupBy.mockResolvedValue([
      { type: "WEIGHT" }, // specialised — no generic registry entry
      { type: "BLOOD_GLUCOSE" }, // generic card
      { type: "ACTIVE_ENERGY_BURNED" }, // generic card under a remapped id
    ]);

    const count = await enqueueStatusRefillForUser("u1", "de");

    expect(enqueuedScopes()).toEqual([
      "blood-pressure",
      "bmi",
      "general",
      "medication-compliance",
      "metric:ACTIVE_ENERGY",
      "metric:BLOOD_GLUCOSE",
      "mood",
      "pulse",
      "weight",
    ]);
    expect(count).toBe(9);
    const locales = new Set(
      enqueueStatusGeneration.mock.calls.map(
        (c) => (c[0] as { locale: string }).locale,
      ),
    );
    expect([...locales]).toEqual(["de"]);
  });

  it("never deletes cache rows (the hash baselines survive the refill)", async () => {
    await enqueueStatusRefillForUser("u1", "en");
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("bypasses the ingest debounce — an explicit regenerate refills even freshly-warmed scopes", async () => {
    // Every scope reads as freshly warmed; the refill must NOT consult the
    // freshness probe at all (the user is explicitly asking).
    noteFindMany.mockResolvedValue([{ metric: "general", locale: "en" }]);
    await enqueueStatusRefillForUser("u1", "en");
    expect(noteFindMany).not.toHaveBeenCalled();
    expect(enqueuedScopes()).toContain("general");
  });

  it("refills nothing and returns 0 while statusText is unavailable", async () => {
    aiCapabilityForRecord.mockResolvedValue(UNAVAILABLE);
    measurementGroupBy.mockResolvedValue([{ type: "BLOOD_GLUCOSE" }]);
    const count = await enqueueStatusRefillForUser("u1", "de");
    expect(count).toBe(0);
    expect(enqueueStatusGeneration).not.toHaveBeenCalled();
    expect(listLiveTypes).not.toHaveBeenCalled();
  });

  it("still refills the specialised scopes when the generic-scope discovery read fails", async () => {
    measurementGroupBy.mockRejectedValue(new Error("pool exhausted"));
    const count = await enqueueStatusRefillForUser("u1", "de");
    expect(count).toBe(7);
    expect(enqueuedScopes()).toEqual([
      "blood-pressure",
      "bmi",
      "general",
      "medication-compliance",
      "mood",
      "pulse",
      "weight",
    ]);
  });
});
