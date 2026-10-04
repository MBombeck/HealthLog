import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn(), findFirst: vi.fn() },
    moodEntryRollup: { findMany: vi.fn(), findFirst: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    // v1.22 — cross-signal integration blocks.
    labResult: { findMany: vi.fn() },
    measurementReminder: { findMany: vi.fn() },
    workout: { findMany: vi.fn() },
    ecgRecording: { findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
    // The all-time extremes read (one grouped aggregate).
    $queryRaw: vi.fn(),
  },
}));

// Stub the mood-rollup warm-up so test runs don't fire the real
// recompute aggregate. The warm-up is fire-and-forget on the route.
vi.mock("@/lib/rollups/mood-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/mood-rollups")
  >("@/lib/rollups/mood-rollups");
  return {
    ...actual,
    ensureUserMoodRollupsFresh: vi
      .fn()
      .mockResolvedValue({ recomputed: false }),
  };
});

vi.mock("@/lib/medication-category", () => ({
  getMedicationCategories: vi.fn(async () => ({})),
}));

import { prisma } from "@/lib/db";
import { invalidateUserTimezone } from "@/lib/tz/resolver";
import {
  extractFeatures,
  FeaturesPayloadTooLargeError,
  FEATURES_MAX_BYTES,
  type RawFeatures,
} from "../features";

const prismaMock = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn> };
  measurement: {
    findMany: ReturnType<typeof vi.fn>;
  };
  measurementRollup: { findMany: ReturnType<typeof vi.fn> };
  moodEntry: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  moodEntryRollup: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  medication: { findMany: ReturnType<typeof vi.fn> };
  medicationIntakeEvent: { findMany: ReturnType<typeof vi.fn> };
  labResult: { findMany: ReturnType<typeof vi.fn> };
  measurementReminder: { findMany: ReturnType<typeof vi.fn> };
  workout: { findMany: ReturnType<typeof vi.fn> };
  ecgRecording: { findMany: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
};

const dayMs = 24 * 60 * 60 * 1000;

/**
 * Its own account id, because `resolveUserTimezone` memoises per user for a
 * minute — reusing "user-1" would either read a zone a neighbouring test set
 * or leave one behind for the next.
 */
const TZ_USER = "user-tz";

function rollupRow(daysAgo: number, mean: number, count: number) {
  const now = new Date();
  return {
    // A stored DAY bucket starts at UTC midnight.
    bucketStart: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        daysAgo * dayMs,
    ),
    source: "MANUAL",
    count,
    mean,
    minValue: mean,
    maxValue: mean,
    sumValue: count * mean,
    sd: 0,
    slope: 0,
    r2: 0,
    sumX: null,
    sumXy: null,
    sumXx: null,
    sumYy: null,
    computedAt: new Date(),
  };
}

/** Keep the rows a DAY read's `bucketStart` window would return. */
function inWindow(
  rows: ReturnType<typeof rollupRow>[],
  where: { bucketStart: { gte: Date; lt?: Date } },
) {
  return rows.filter(
    (r) =>
      r.bucketStart >= where.bucketStart.gte &&
      (where.bucketStart.lt === undefined ||
        r.bucketStart < where.bucketStart.lt),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({
    heightCm: 180,
    dateOfBirth: new Date("1980-01-01"),
    gender: "MALE",
  });
  prismaMock.measurement.findMany.mockResolvedValue([]);
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.measurementRollup.findMany.mockResolvedValue([]);
  prismaMock.moodEntry.findMany.mockResolvedValue([]);
  prismaMock.moodEntry.findFirst.mockResolvedValue(null);
  prismaMock.moodEntryRollup.findMany.mockResolvedValue([]);
  prismaMock.moodEntryRollup.findFirst.mockResolvedValue(null);
  prismaMock.medication.findMany.mockResolvedValue([]);
  prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
  prismaMock.labResult.findMany.mockResolvedValue([]);
  prismaMock.measurementReminder.findMany.mockResolvedValue([]);
  prismaMock.workout.findMany.mockResolvedValue([]);
  prismaMock.ecgRecording.findMany.mockResolvedValue([]);
});

describe("extractFeatures — v1.4.36 W3 bucketed payload", () => {
  it("does not attach bucketedMeasurements when includeRaw=false", async () => {
    const features = await extractFeatures("user-1", false);
    const asRecord = features as unknown as Record<string, unknown>;
    expect(asRecord.bucketedMeasurements).toBeUndefined();
    expect(asRecord.rawMeasurements).toBeUndefined();
  });

  it("attaches DAY / WEEK / MONTH buckets from measurement_rollups when includeRaw=true", async () => {
    // Two WEIGHT DAY buckets in the 0-90d window (the DAY read) and one
    // month in the 365-1825d window (the SQL fold of the DAY tier).
    const weightDays = [rollupRow(10, 82.5, 2), rollupRow(20, 82.7, 1)];
    const monthStart = rollupRow(400, 85.1, 28).bucketStart;
    prismaMock.$queryRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = JSON.stringify([strings, values]);
        if (
          !sql.includes("measurement_rollups") ||
          !values.includes("WEIGHT") ||
          !sql.includes("'month'")
        ) {
          return [];
        }
        return [
          {
            bucket_start: monthStart,
            count: 28,
            sum_y: 28 * 85.1,
            min_value: 84,
            max_value: 86,
            sum_x: null,
            sum_xy: null,
            sum_xx: null,
            sum_yy: null,
            computed_at: new Date(),
          },
        ];
      },
    );
    prismaMock.measurementRollup.findMany.mockImplementation(
      async (args: {
        where: {
          type: string;
          granularity: string;
          bucketStart: { gte: Date; lt?: Date };
        };
      }) => {
        if (args.where.type !== "WEIGHT") return [];
        expect(args.where.granularity).toBe("DAY");
        return inWindow(weightDays, args.where);
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

  // Constructs a ~5.6 MB rollup payload and runs the whole serialiser
  // pipeline; the slower GitHub-Actions runners cross the default 5 s
  // budget. Raise this single test only — the rest of the suite stays
  // on the default timeout. Vitest 4 takes the timeout as a numeric
  // second argument (the old `it(name, fn, options)` signature was
  // removed in v4).
  it(
    "throws FeaturesPayloadTooLargeError when the serialised payload exceeds the 5 MB cap",
    { timeout: 30_000 },
    async () => {
      // Fabricate an absurdly long bucket list so the JSON dump crosses
      // the ceiling: every DAY read answers 200 000 distinct buckets inside
      // its own window, one second apart.
      prismaMock.measurementRollup.findMany.mockImplementation(
        async (args: { where: { bucketStart: { gte: Date } } }) =>
          new Array(200_000).fill(null).map((_, i) => ({
            ...rollupRow(0, i, i),
            bucketStart: new Date(
              args.where.bucketStart.gte.getTime() + i * 1000,
            ),
          })),
      );

      await expect(extractFeatures("user-1", true)).rejects.toThrow(
        FeaturesPayloadTooLargeError,
      );
    },
  );

  it("exposes the size cap as a public constant", () => {
    expect(FEATURES_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

// ─── v1.22 — cross-signal integration blocks ──────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function measurementRow(type: string, value: number, daysAgo: number) {
  return {
    type,
    value,
    measuredAt: new Date(Date.now() - daysAgo * DAY_MS),
    sleepStage: null,
    source: "MANUAL",
    deviceType: null,
  };
}

function labRow(opts: {
  analyte: string;
  value: number | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  daysAgo: number;
  hidden?: boolean;
  valueText?: string | null;
}) {
  return {
    analyte: opts.analyte,
    panel: null,
    unit: "mg/dL",
    value: opts.value,
    valueText: opts.valueText ?? null,
    referenceLow: opts.referenceLow,
    referenceHigh: opts.referenceHigh,
    takenAt: new Date(Date.now() - opts.daysAgo * DAY_MS),
    biomarkerId: opts.hidden === undefined ? null : "bm-" + opts.analyte,
    biomarker:
      opts.hidden === undefined
        ? null
        : {
            id: "bm-" + opts.analyte,
            name: opts.analyte,
            unit: "mg/dL",
            lowerBound: opts.referenceLow,
            upperBound: opts.referenceHigh,
            panel: null,
            hidden: opts.hidden,
          },
  };
}

describe("extractFeatures — v1.22 glucose aggregate block", () => {
  it("emits a glucose block from BLOOD_GLUCOSE readings", async () => {
    prismaMock.measurement.findMany.mockResolvedValue([
      measurementRow("BLOOD_GLUCOSE", 95, 1),
      measurementRow("BLOOD_GLUCOSE", 110, 10),
      measurementRow("BLOOD_GLUCOSE", 105, 40),
    ]);
    const f = await extractFeatures("user-1", false);
    expect(f.glucose).toBeDefined();
    expect(f.glucose?.latest).not.toBeNull();
    expect(f.glucose?.coverage.count).toBe(3);
  });

  it("omits the glucose block when there are no readings", async () => {
    const f = await extractFeatures("user-1", false);
    expect(f.glucose).toBeUndefined();
  });
});

describe("extractFeatures — v1.25.1 clinical-depth aggregate blocks", () => {
  it("emits grip, waist (with WHtR) and pain blocks from their readings", async () => {
    prismaMock.measurement.findMany.mockResolvedValue([
      measurementRow("GRIP_STRENGTH", 42, 1),
      measurementRow("GRIP_STRENGTH", 40, 20),
      measurementRow("WAIST_CIRCUMFERENCE", 90, 2),
      measurementRow("WAIST_CIRCUMFERENCE", 92, 25),
      measurementRow("PAIN_NRS", 4, 1),
      measurementRow("PAIN_NRS", 2, 10),
    ]);
    const f = await extractFeatures("user-1", false);

    expect(f.gripStrength).toBeDefined();
    expect(f.gripStrength?.latest).toBe(42);

    expect(f.waist).toBeDefined();
    expect(f.waist?.latest).toBe(90);
    // heightCm is 180 in the default user mock → WHtR = 90 / 180 = 0.5.
    expect(f.waist?.whtrLatest).toBe(0.5);

    expect(f.pain).toBeDefined();
    expect(f.pain?.latest).toBe(4);
  });

  it("omits the clinical-depth blocks when there are no readings", async () => {
    const f = await extractFeatures("user-1", false);
    expect(f.gripStrength).toBeUndefined();
    expect(f.waist).toBeUndefined();
    expect(f.pain).toBeUndefined();
  });

  it("leaves WHtR null when height is unknown", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      heightCm: null,
      dateOfBirth: new Date("1980-01-01"),
      gender: "MALE",
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      measurementRow("WAIST_CIRCUMFERENCE", 90, 2),
    ]);
    const f = await extractFeatures("user-1", false);
    expect(f.waist?.whtrLatest).toBeNull();
  });
});

describe("extractFeatures — weight target direction (#1006)", () => {
  const weightRows = [
    measurementRow("WEIGHT", 60, 1),
    measurementRow("WEIGHT", 59.6, 3),
    measurementRow("WEIGHT", 59.2, 5),
  ];

  it("tells the model gaining is progress when the person is below their own target", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      heightCm: 180,
      dateOfBirth: new Date("1980-01-01"),
      gender: "MALE",
      thresholdsJson: { WEIGHT: { min: 65, max: 70 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue(weightRows);
    const f = await extractFeatures("user-1", false);
    expect(f.weight?.target).toMatchObject({
      min: 65,
      max: 70,
      unit: "kg",
      position: "below",
      progress: "gaining",
    });
    expect(f.weight?.target?.reading).toMatch(/gaining weight is progress/);
  });

  it("says nothing about direction when no target is stored", async () => {
    prismaMock.measurement.findMany.mockResolvedValue(weightRows);
    const f = await extractFeatures("user-1", false);
    expect(f.weight).toBeDefined();
    expect(f.weight?.target).toBeUndefined();
  });
});

describe("extractFeatures — v1.22 labs briefing block", () => {
  it("surfaces an abnormal (out-of-range) biomarker", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      labRow({
        analyte: "LDL",
        value: 200,
        referenceLow: 0,
        referenceHigh: 130,
        daysAgo: 5,
      }),
    ]);
    const f = await extractFeatures("user-1", false);
    expect(f.labs).toBeDefined();
    expect(f.labs?.flagged[0]?.analyte).toBe("LDL");
    expect(f.labs?.flagged[0]?.rangeStatus).toBe("above");
  });

  it("excludes a HIDDEN biomarker even when it is abnormal", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      labRow({
        analyte: "Ferritin",
        value: 500,
        referenceLow: 30,
        referenceHigh: 300,
        daysAgo: 3,
        hidden: true,
      }),
    ]);
    const f = await extractFeatures("user-1", false);
    // The only marker is hidden + abnormal → block omitted entirely.
    expect(f.labs).toBeUndefined();
  });

  it("does not surface an in-range, non-trending marker", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      labRow({
        analyte: "TSH",
        value: 2,
        referenceLow: 0.4,
        referenceHigh: 4,
        daysAgo: 4,
      }),
    ]);
    const f = await extractFeatures("user-1", false);
    expect(f.labs).toBeUndefined();
  });

  it("surfaces an in-range but trending marker (rising vs prior reading)", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      // Newest first (route orders desc); both in range, but rising.
      labRow({
        analyte: "Glucose",
        value: 99,
        referenceLow: 70,
        referenceHigh: 100,
        daysAgo: 2,
      }),
      labRow({
        analyte: "Glucose",
        value: 80,
        referenceLow: 70,
        referenceHigh: 100,
        daysAgo: 60,
      }),
    ]);
    const f = await extractFeatures("user-1", false);
    expect(f.labs?.flagged[0]?.trend).toBe("rising");
  });
});

describe("extractFeatures — v1.22 preventive-care block", () => {
  it("buckets reminders into overdue and due", async () => {
    prismaMock.measurementReminder.findMany.mockResolvedValue([
      { label: "Blutbild", nextDueAt: new Date(Date.now() - 5 * DAY_MS) },
      { label: "Augenarzt", nextDueAt: new Date(Date.now() + 7 * DAY_MS) },
    ]);
    const f = await extractFeatures("user-1", false);
    expect(f.preventiveCare?.overdue[0]?.label).toBe("Blutbild");
    expect(f.preventiveCare?.overdue[0]?.daysOverdue).toBeGreaterThanOrEqual(4);
    expect(f.preventiveCare?.due[0]?.label).toBe("Augenarzt");
  });

  it("omits the block when nothing is due or overdue", async () => {
    const f = await extractFeatures("user-1", false);
    expect(f.preventiveCare).toBeUndefined();
  });

  /**
   * The day counting itself is pinned in `preventive-care-days.test.ts`; what
   * this pins is the wire between it and the account — that the zone the block
   * counts on is the one on the person's PROFILE, and that it survives the trip
   * through `extractFeatures`. Both ends were right once before while the
   * assembly between them handed down something else.
   *
   * One instant, three answers. At 05:00 UTC on the 18th it is still the 17th
   * in Los Angeles, so a checkup at 20:00 UTC on the 18th is tomorrow's there —
   * while UTC and the Berlin server default both call it today's. Only the
   * profile zone gives 1, so nothing but the profile zone can produce it.
   */
  it("counts the days on the profile's calendar, not UTC's or the server's", async () => {
    const NOW = Date.parse("2026-07-18T05:00:00Z");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    invalidateUserTimezone(TZ_USER);
    prismaMock.user.findUnique.mockResolvedValue({
      heightCm: 180,
      dateOfBirth: new Date("1980-01-01"),
      gender: "MALE",
      timezone: "America/Los_Angeles",
    });
    prismaMock.measurementReminder.findMany.mockResolvedValue([
      { label: "Augenarzt", nextDueAt: new Date("2026-07-18T20:00:00Z") },
    ]);

    try {
      const f = await extractFeatures(TZ_USER, false);
      expect(f.preventiveCare?.due).toEqual([
        { label: "Augenarzt", daysUntil: 1 },
      ]);
    } finally {
      vi.useRealTimers();
      invalidateUserTimezone(TZ_USER);
    }
  });
});

describe("extractFeatures — v1.22 workouts block", () => {
  it("aggregates counts + distance over the windows", async () => {
    prismaMock.workout.findMany.mockResolvedValue([
      {
        sportType: "running",
        startedAt: new Date(Date.now() - 1 * DAY_MS),
        durationSec: 1800,
        totalDistanceM: 5000,
      },
      {
        sportType: "cycling",
        startedAt: new Date(Date.now() - 20 * DAY_MS),
        durationSec: 3600,
        totalDistanceM: 20000,
      },
    ]);
    const f = await extractFeatures("user-1", false);
    expect(f.workouts?.last7.count).toBe(1);
    expect(f.workouts?.last30.count).toBe(2);
    expect(f.workouts?.last7.totalDistanceKm).toBe(5);
    expect(f.workouts?.latest?.sportType).toBe("running");
  });
});

describe("extractFeatures — v1.22 integration blocks are briefing-scoped", () => {
  it("skips the extra reads on the tight Coach-snapshot window (sinceDays: 90)", async () => {
    await extractFeatures("user-1", false, { sinceDays: 90 });
    expect(prismaMock.labResult.findMany).not.toHaveBeenCalled();
    expect(prismaMock.measurementReminder.findMany).not.toHaveBeenCalled();
    expect(prismaMock.workout.findMany).not.toHaveBeenCalled();
    // S10 — the ECG descriptor rides the same briefing-scoped gate.
    expect(prismaMock.ecgRecording.findMany).not.toHaveBeenCalled();
  });

  it("runs the extra reads on the wide briefing window (sinceDays: 400)", async () => {
    await extractFeatures("user-1", false, { sinceDays: 400 });
    expect(prismaMock.labResult.findMany).toHaveBeenCalled();
    expect(prismaMock.measurementReminder.findMany).toHaveBeenCalled();
    expect(prismaMock.workout.findMany).toHaveBeenCalled();
    expect(prismaMock.ecgRecording.findMany).toHaveBeenCalled();
  });
});

describe("extractFeatures — S10 ECG device-verdict descriptor", () => {
  const DAY = 86_400_000;

  it("emits a device-verdict descriptor and NEVER a waveform", async () => {
    const now = Date.now();
    prismaMock.ecgRecording.findMany.mockResolvedValue([
      {
        recordedAt: new Date(now - 2 * DAY),
        rhythmClassification: "IRREGULAR",
        averageHeartRate: 72,
      },
      {
        recordedAt: new Date(now - 10 * DAY),
        rhythmClassification: "NOT_DETECTED",
        averageHeartRate: 61,
      },
    ]);
    const f = await extractFeatures("user-1", false);
    expect(f.ecg?.recordingCount).toBe(2);
    expect(f.ecg?.deviceVerdicts).toEqual({
      irregular: 1,
      notDetected: 1,
      inconclusive: 0,
    });
    // The LATEST recording's device verdict + HR (newest-first ordering).
    expect(f.ecg?.latestDeviceVerdict).toBe("IRREGULAR");
    expect(f.ecg?.latestAverageHeartRate).toBe(72);
    // The waveform never reaches the payload — only descriptors.
    expect(JSON.stringify(f.ecg)).not.toMatch(
      /waveform|sample|signal|voltage|microvolt/i,
    );
  });

  it("omits the ECG block entirely when the user has no recordings", async () => {
    const f = await extractFeatures("user-1", false);
    expect(f.ecg).toBeUndefined();
  });

  it("only ever reads descriptor columns, never the encrypted waveform", async () => {
    await extractFeatures("user-1", false);
    const call = prismaMock.ecgRecording.findMany.mock.calls[0]?.[0];
    expect(call?.select?.waveformEncrypted).toBeUndefined();
    expect(call?.select?.recordedAt).toBe(true);
    expect(call?.select?.rhythmClassification).toBe(true);
  });
});

describe("extractFeatures — a day of pulse is the mean of its hours' means", () => {
  /**
   * Two days: one with a workout hour of twelve readings at 150 and three
   * resting hours of one reading at 60 (day value 82.5), one with a single
   * resting reading at 60. Every window weighs each day once: 71.25. The plain
   * mean over the seventeen readings would be about 123.5.
   */
  function pulseRows() {
    const now = new Date();
    const midnight = (daysAgo: number) =>
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      daysAgo * dayMs;
    const workout = midnight(2);
    const rows: Array<{ type: string; value: number; measuredAt: Date }> = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push({
        type: "PULSE",
        value: 150,
        measuredAt: new Date(workout + 10 * 3_600_000 + i * 5 * 60_000),
      });
    }
    for (const h of [12, 14, 16]) {
      rows.push({
        type: "PULSE",
        value: 60,
        measuredAt: new Date(workout + h * 3_600_000),
      });
    }
    rows.push({
      type: "PULSE",
      value: 60,
      measuredAt: new Date(midnight(3) + 8 * 3_600_000),
    });
    // The bulk read is newest-first; the builder reverses it.
    return rows
      .map((r) => ({
        ...r,
        sleepStage: null,
        source: "APPLE_HEALTH",
        deviceType: null,
      }))
      .sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime());
  }

  it("weighs each day once in every pulse window and in the all-time mean", async () => {
    prismaMock.measurement.findMany.mockResolvedValue(pulseRows());
    const f = await extractFeatures("user-pulse-day", false);
    expect(f.pulse?.avg7).toBe(71.25);
    expect(f.pulse?.avg30).toBe(71.25);
    expect(f.pulse?.avg90).toBe(71.25);
    expect(f.pulse?.allTimeAvg).toBe(71.25);
    // Extremes stay over every reading.
    expect(f.pulse?.allTimeMin).toBe(60);
    expect(f.pulse?.allTimeMax).toBe(150);
    expect(f.historicalComparison?.pulse?.current7dAvg).toBe(71.25);
  });
});
