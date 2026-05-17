import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/medication-category", () => ({
  getMedicationCategories: vi.fn(async () => ({})),
}));

import { prisma } from "@/lib/db";
import {
  extractFeatures,
  FeaturesPayloadTooLargeError,
  FEATURES_MAX_BYTES,
  type RawFeatures,
} from "../features";

const prismaMock = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn> };
  measurement: { findMany: ReturnType<typeof vi.fn> };
  measurementRollup: { findMany: ReturnType<typeof vi.fn> };
  moodEntry: { findMany: ReturnType<typeof vi.fn> };
  medication: { findMany: ReturnType<typeof vi.fn> };
  medicationIntakeEvent: { findMany: ReturnType<typeof vi.fn> };
};

const dayMs = 24 * 60 * 60 * 1000;

function rollupRow(daysAgo: number, mean: number, count: number) {
  return {
    bucketStart: new Date(Date.now() - daysAgo * dayMs),
    count,
    mean,
    minValue: mean,
    maxValue: mean,
    sd: 0,
    slope: 0,
    r2: 0,
    computedAt: new Date(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({
    heightCm: 180,
    dateOfBirth: new Date("1980-01-01"),
    gender: "MALE",
  });
  prismaMock.measurement.findMany.mockResolvedValue([]);
  prismaMock.measurementRollup.findMany.mockResolvedValue([]);
  prismaMock.moodEntry.findMany.mockResolvedValue([]);
  prismaMock.medication.findMany.mockResolvedValue([]);
  prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
});

describe("extractFeatures — v1.4.36 W3 bucketed payload", () => {
  it("does not attach bucketedMeasurements when includeRaw=false", async () => {
    const features = await extractFeatures("user-1", false);
    const asRecord = features as unknown as Record<string, unknown>;
    expect(asRecord.bucketedMeasurements).toBeUndefined();
    expect(asRecord.rawMeasurements).toBeUndefined();
  });

  it("attaches DAY / WEEK / MONTH buckets from measurement_rollups when includeRaw=true", async () => {
    // Two WEIGHT DAY buckets in the 0-90d window and one MONTH bucket
    // in the 365-1825d window. The reader is called once per
    // (type, granularity) combination — return data only for the two
    // we care about, empty for the rest.
    prismaMock.measurementRollup.findMany.mockImplementation(
      async (args: { where: { type: string; granularity: string } }) => {
        if (args.where.type === "WEIGHT" && args.where.granularity === "DAY") {
          return [rollupRow(10, 82.5, 2), rollupRow(20, 82.7, 1)];
        }
        if (
          args.where.type === "WEIGHT" &&
          args.where.granularity === "MONTH"
        ) {
          return [rollupRow(400, 85.1, 28)];
        }
        return [];
      },
    );

    const features = (await extractFeatures("user-1", true)) as RawFeatures;

    expect(features.bucketedMeasurements).toBeDefined();
    const weightDay = features.bucketedMeasurements.find(
      (s) => s.type === "WEIGHT" && s.granularity === "DAY",
    );
    expect(weightDay).toBeDefined();
    expect(weightDay?.buckets).toHaveLength(2);
    expect(weightDay?.buckets[0]).toMatchObject({
      mean: 82.5,
      count: 2,
    });
    expect(weightDay?.buckets[0].bucketStart).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );

    const weightMonth = features.bucketedMeasurements.find(
      (s) => s.type === "WEIGHT" && s.granularity === "MONTH",
    );
    expect(weightMonth?.buckets).toHaveLength(1);
    expect(weightMonth?.buckets[0].count).toBe(28);
  });

  it("drops empty (type, granularity) series so the payload never carries labelled-but-empty arrays", async () => {
    prismaMock.measurementRollup.findMany.mockResolvedValue([]);
    const features = (await extractFeatures("user-1", true)) as RawFeatures;
    expect(features.bucketedMeasurements).toEqual([]);
  });

  it("keeps anthropometrics (heightCm / ageYears / gender) on context", async () => {
    const features = await extractFeatures("user-1", false);
    expect(features.context.heightCm).toBe(180);
    expect(features.context.gender).toBe("MALE");
    expect(features.context.ageYears).toBeGreaterThan(40);
  });

  it("throws FeaturesPayloadTooLargeError when the serialised payload exceeds the 5 MB cap", async () => {
    // Fabricate an absurdly long bucket list so the JSON dump crosses
    // the ceiling. ~200 KB per series × 28 series ≈ ~5.6 MB.
    const giant = new Array(200_000).fill(null).map((_, i) => ({
      bucketStart: new Date(Date.now() - i * dayMs),
      count: i,
      mean: i,
      minValue: i,
      maxValue: i,
      sd: 0,
      slope: 0,
      r2: 0,
      computedAt: new Date(),
    }));
    prismaMock.measurementRollup.findMany.mockResolvedValue(giant);

    await expect(extractFeatures("user-1", true)).rejects.toThrow(
      FeaturesPayloadTooLargeError,
    );
  });

  it("exposes the size cap as a public constant", () => {
    expect(FEATURES_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});
