/**
 * The "Usual range" strip places the same latest reading the dashboard tile
 * prints: the canonical latest (`readLatestCanonical`, latest day first, then
 * the source ladder), asked for the strip's own type. It used to take the
 * newest row of any source, so an account with two sources for a metric read
 * one figure on the dashboard and another under the chart.
 *
 * Swept over every measurement type. The types whose day mean moves with the
 * hour (glucose) are placed by their day mean instead, on purpose; they are
 * named here so a new one cannot slip out of the sweep unnoticed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readLatestCanonical = vi.fn();
vi.mock("@/lib/measurements/latest-canonical", () => ({
  readLatestCanonical: (...a: unknown[]) => readLatestCanonical(...a),
}));
vi.mock("@/lib/rollups/measurement-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rollups/measurement-read")>()),
  loadUserSourcePriority: async () => ({ ladder: "fixture" }),
}));
vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findFirst: vi.fn(), findMany: vi.fn() } },
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: async () => ({}),
}));
vi.mock("@/lib/ai/coach/tools/correlations-read", () => ({
  readCoachCorrelations: async () => ({ present: false }),
}));
vi.mock("@/lib/insights/derived/baseline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/insights/derived/baseline")>()),
  loadBaselineProfile: async () => ({ ageYears: 40, sex: "MALE" }),
  computeVitalsBaseline: async () => ({
    status: "ok",
    value: { low: 40, high: 60, center: 50, sampleDays: 20 },
    coverage: {},
    provenance: { windowDays: 30 },
  }),
}));

import { measurementTypeEnum } from "@/lib/validations/measurement";
import { SAME_HOURS_TYPES } from "@/lib/insights/derived/coincident-deviation";
import { buildCoachReadStrip } from "@/lib/insights/derived/coach-read";
import type { MeasurementType } from "@/generated/prisma/client";

const NOW = new Date("2026-06-02T10:00:00Z");

beforeEach(() => readLatestCanonical.mockReset());

describe("coach read: the latest reading is the dashboard's", () => {
  it("names the day-mean types it leaves out", () => {
    expect([...SAME_HOURS_TYPES].sort()).toEqual(["BLOOD_GLUCOSE"]);
  });

  const types = measurementTypeEnum.options.filter(
    (type) => !SAME_HOURS_TYPES.has(type as MeasurementType),
  );

  it.each(types)("%s places the canonical latest reading", async (type) => {
    readLatestCanonical.mockResolvedValue([
      { type, value: 47, measured_at: new Date("2026-06-02T08:00:00Z") },
    ]);
    const strip = await buildCoachReadStrip(
      "u1",
      type as MeasurementType,
      "en",
      { tz: "UTC", now: NOW },
    );
    expect(readLatestCanonical).toHaveBeenCalledWith(
      "u1",
      { ladder: "fixture" },
      null,
      [type],
    );
    expect(strip.baseline?.latest).toBe(47);
    expect(strip.baseline?.latestIsToday).toBe(true);
  });
});
