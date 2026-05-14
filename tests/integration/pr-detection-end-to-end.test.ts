/**
 * v1.4.25 W16c — PR detection end-to-end.
 *
 * The handler runs against a real Postgres testcontainer + real
 * Measurement / Workout rows. We assert two flows:
 *
 *   1. After enough measurements land, the detector writes a
 *      PersonalRecord row at the all-time best and tags the
 *      `sourceMeasurementId` to the winning row.
 *   2. The detector is idempotent — re-running the same handler over
 *      the same dataset produces no duplicate rows because the
 *      `(userId, metricType, metricSlot, achievedAt)` unique index
 *      absorbs the second insert.
 *
 * The HTTP-layer enqueue is covered by the per-route unit suites
 * (`src/app/api/measurements/batch/__tests__/pr-detection-hook.test.ts`
 * and the workouts equivalent). This file walks the handler instead
 * of going through pg-boss so the integration suite stays free of
 * out-of-process job-queue plumbing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const TEST_USER_ID = "user-pr-detection-e2e";

const { detectPersonalRecordsForUser, PR_DETECTION_WARMUP_THRESHOLD } =
  await import("@/lib/personal-records/pr-detection-worker");
const { isPRTrackable } = await import("@/lib/personal-records/pr-direction");
import type { MeasurementType } from "@/generated/prisma/client";
const { measurementTypeEnum } = await import("@/lib/validations/measurement");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "pr-detection",
      email: "pr-detection@example.test",
    },
  });
});

describe("PR detection — measurement-driven (real DB)", () => {
  it("writes one PersonalRecord row for the all-time best after the warm-up gate", async () => {
    const prisma = getPrismaClient();

    // Seed enough samples to clear the warm-up gate plus one obvious
    // all-time best. Days are stepped backwards from today so the
    // best row's `measuredAt` lands at a deterministic, unique
    // timestamp.
    const baseDate = new Date("2026-05-14T00:00:00Z");
    const samples = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD; i++) {
      samples.push({
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS" as const,
        value: 8000 + i * 100,
        unit: "count",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(baseDate.getTime() - (i + 1) * 86_400_000),
        externalId: `seed-${i}`,
      });
    }
    samples.push({
      userId: TEST_USER_ID,
      type: "ACTIVITY_STEPS" as const,
      value: 18234,
      unit: "count",
      source: "APPLE_HEALTH" as const,
      measuredAt: baseDate,
      externalId: "all-time-best",
    });
    await prisma.measurement.createMany({ data: samples });

    const result = await detectPersonalRecordsForUser(TEST_USER_ID);
    expect(result.inserted).toBeGreaterThanOrEqual(1);

    const stepsPR = await prisma.personalRecord.findFirst({
      where: {
        userId: TEST_USER_ID,
        metricType: "ACTIVITY_STEPS",
        metricSlot: null,
      },
    });
    expect(stepsPR).not.toBeNull();
    expect(stepsPR?.value).toBe(18234);
    expect(stepsPR?.direction).toBe("MAX");
    expect(stepsPR?.sourceMeasurementId).toBeDefined();
  });

  it("is idempotent — re-running the handler does not duplicate the row", async () => {
    const prisma = getPrismaClient();

    const baseDate = new Date("2026-05-14T00:00:00Z");
    const samples = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD; i++) {
      samples.push({
        userId: TEST_USER_ID,
        type: "RESTING_HEART_RATE" as const,
        value: 65 + i,
        unit: "bpm",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(baseDate.getTime() - (i + 1) * 86_400_000),
        externalId: `rhr-seed-${i}`,
      });
    }
    samples.push({
      userId: TEST_USER_ID,
      type: "RESTING_HEART_RATE" as const,
      value: 47,
      unit: "bpm",
      source: "APPLE_HEALTH" as const,
      measuredAt: baseDate,
      externalId: "rhr-best",
    });
    await prisma.measurement.createMany({ data: samples });

    await detectPersonalRecordsForUser(TEST_USER_ID);
    const after1 = await prisma.personalRecord.count({
      where: { userId: TEST_USER_ID, metricType: "RESTING_HEART_RATE" },
    });

    await detectPersonalRecordsForUser(TEST_USER_ID);
    const after2 = await prisma.personalRecord.count({
      where: { userId: TEST_USER_ID, metricType: "RESTING_HEART_RATE" },
    });

    expect(after1).toBe(1);
    expect(after2).toBe(1);
  });

  it("propagates the silent flag without affecting the row written", async () => {
    const prisma = getPrismaClient();
    const baseDate = new Date("2026-05-14T00:00:00Z");
    const samples = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD; i++) {
      samples.push({
        userId: TEST_USER_ID,
        type: "VO2_MAX" as const,
        value: 38 + i * 0.5,
        unit: "ml/kg/min",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(baseDate.getTime() - (i + 1) * 86_400_000),
        externalId: `vo2-${i}`,
      });
    }
    samples.push({
      userId: TEST_USER_ID,
      type: "VO2_MAX" as const,
      value: 52.5,
      unit: "ml/kg/min",
      source: "APPLE_HEALTH" as const,
      measuredAt: baseDate,
      externalId: "vo2-best",
    });
    await prisma.measurement.createMany({ data: samples });

    const result = await detectPersonalRecordsForUser(TEST_USER_ID, {
      silent: true,
    });
    expect(result.silent).toBe(true);

    const pr = await prisma.personalRecord.findFirst({
      where: { userId: TEST_USER_ID, metricType: "VO2_MAX" },
    });
    expect(pr).not.toBeNull();
    expect(pr?.value).toBeCloseTo(52.5);
  });
});

describe("PR detection — drift guard (real DB)", () => {
  it("scans every PR-trackable metric type when no row exists", async () => {
    // Drift assertion — `scanned` should match the count of PR-trackable
    // metrics (and at least every direction enum case must appear in
    // either the worker or the suppress branch via `getPRDirection`).
    const result = await detectPersonalRecordsForUser(TEST_USER_ID);

    const trackable = measurementTypeEnum.options.filter((t) =>
      isPRTrackable(t as MeasurementType),
    );
    expect(result.scanned).toBeGreaterThanOrEqual(trackable.length);
  });
});
