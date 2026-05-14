/**
 * Unit coverage for the PR detection worker (v1.4.25 W16c).
 *
 * The handler talks to Prisma in two passes (measurements then
 * workouts). We stub the methods used and assert:
 *   - warm-up gate (no PR until 7 measurements exist),
 *   - strict improvement for MAX and MIN directions,
 *   - tie behaviour (row written, no push),
 *   - drift guard (every PR-trackable measurement type triggers a
 *     scan path),
 *   - workout slots for longest run, longest distance, fastest 5 km,
 *   - silent flag propagation.
 */
import { describe, expect, it, vi } from "vitest";

import {
  PR_DETECTION_WARMUP_THRESHOLD,
  __test__,
  detectPersonalRecordsForUser,
} from "../pr-detection-worker";
import { isPRTrackable } from "../pr-direction";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import {
  PersonalRecordDirection,
  type MeasurementType,
  type PrismaClient,
} from "@/generated/prisma/client";

interface FakeMeasurementRow {
  id: string;
  type: MeasurementType;
  value: number;
  unit: string;
  measuredAt: Date;
  source: string;
  externalId: string | null;
  userId: string;
}

interface FakeWorkoutRow {
  id: string;
  userId: string;
  sportType: string;
  startedAt: Date;
  durationSec: number;
  totalDistanceM: number | null;
  source: string;
  externalId: string | null;
}

interface FakePersonalRecordRow {
  id: string;
  userId: string;
  metricType: MeasurementType;
  metricSlot: string | null;
  direction: PersonalRecordDirection;
  value: number;
  unit: string;
  achievedAt: Date;
  sourceMeasurementId: string | null;
  source: string;
  externalId: string | null;
}

interface FakeOrderBy {
  value?: "asc" | "desc";
  durationSec?: "asc" | "desc";
  totalDistanceM?: "asc" | "desc";
}

interface FakeWhere {
  userId?: string;
  type?: MeasurementType;
  metricType?: MeasurementType;
  metricSlot?: string | null;
  sportType?: string;
  totalDistanceM?: { gte: number };
  durationSec?: { gt: number } | { gte: number };
  achievedAt?: Date;
}

function makeFakePrisma(state: {
  measurements: FakeMeasurementRow[];
  workouts: FakeWorkoutRow[];
  personalRecords: FakePersonalRecordRow[];
}): PrismaClient {
  function matchesMeasurementWhere(
    row: FakeMeasurementRow,
    where: FakeWhere,
  ): boolean {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.type !== undefined && row.type !== where.type) return false;
    return true;
  }

  function matchesWorkoutWhere(
    row: FakeWorkoutRow,
    where: FakeWhere,
  ): boolean {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.sportType !== undefined && row.sportType !== where.sportType)
      return false;
    const distMin = where.totalDistanceM?.gte;
    if (distMin !== undefined && (row.totalDistanceM ?? 0) < distMin)
      return false;
    const durGt = (where.durationSec as { gt?: number } | undefined)?.gt;
    if (durGt !== undefined && row.durationSec <= durGt) return false;
    const distGt = (where.totalDistanceM as { gt?: number } | undefined)?.gt;
    if (distGt !== undefined && (row.totalDistanceM ?? 0) <= distGt)
      return false;
    return true;
  }

  function matchesPRWhere(
    row: FakePersonalRecordRow,
    where: FakeWhere,
  ): boolean {
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.metricType !== undefined && row.metricType !== where.metricType)
      return false;
    if (
      where.metricSlot !== undefined &&
      row.metricSlot !== where.metricSlot
    )
      return false;
    if (
      where.achievedAt !== undefined &&
      row.achievedAt.getTime() !== where.achievedAt.getTime()
    )
      return false;
    return true;
  }

  return {
    measurement: {
      count: vi.fn(async ({ where }: { where: FakeWhere }) => {
        return state.measurements.filter((r) =>
          matchesMeasurementWhere(r, where),
        ).length;
      }),
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: FakeWhere;
          orderBy?: FakeOrderBy;
        }) => {
          const matches = state.measurements.filter((r) =>
            matchesMeasurementWhere(r, where),
          );
          if (matches.length === 0) return null;
          const dir = orderBy?.value;
          matches.sort((a, b) =>
            dir === "desc" ? b.value - a.value : a.value - b.value,
          );
          return matches[0];
        },
      ),
    },
    workout: {
      count: vi.fn(async ({ where }: { where: FakeWhere }) => {
        return state.workouts.filter((r) => matchesWorkoutWhere(r, where))
          .length;
      }),
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: FakeWhere;
          orderBy?: FakeOrderBy;
        }) => {
          const matches = state.workouts.filter((r) =>
            matchesWorkoutWhere(r, where),
          );
          if (matches.length === 0) return null;
          if (orderBy?.durationSec) {
            const dir = orderBy.durationSec;
            matches.sort((a, b) =>
              dir === "desc"
                ? b.durationSec - a.durationSec
                : a.durationSec - b.durationSec,
            );
          } else if (orderBy?.totalDistanceM) {
            const dir = orderBy.totalDistanceM;
            matches.sort((a, b) =>
              dir === "desc"
                ? (b.totalDistanceM ?? 0) - (a.totalDistanceM ?? 0)
                : (a.totalDistanceM ?? 0) - (b.totalDistanceM ?? 0),
            );
          }
          return matches[0];
        },
      ),
    },
    personalRecord: {
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: FakeWhere;
          orderBy?: FakeOrderBy;
        }) => {
          const matches = state.personalRecords.filter((r) =>
            matchesPRWhere(r, where),
          );
          if (matches.length === 0) return null;
          const dir = orderBy?.value;
          matches.sort((a, b) =>
            dir === "desc" ? b.value - a.value : a.value - b.value,
          );
          return matches[0];
        },
      ),
      createMany: vi.fn(
        async ({
          data,
        }: {
          data: Array<Omit<FakePersonalRecordRow, "id">>;
          skipDuplicates?: boolean;
        }) => {
          let count = 0;
          for (const row of data) {
            const dup = state.personalRecords.some(
              (existing) =>
                existing.userId === row.userId &&
                existing.metricType === row.metricType &&
                existing.metricSlot === row.metricSlot &&
                existing.achievedAt.getTime() === row.achievedAt.getTime(),
            );
            if (dup) continue;
            state.personalRecords.push({
              id: `pr-${state.personalRecords.length + 1}`,
              ...row,
            });
            count += 1;
          }
          return { count };
        },
      ),
    },
  } as unknown as PrismaClient;
}

const USER = "user-1";

function measurement(
  type: MeasurementType,
  value: number,
  daysAgo = 1,
  idSuffix = "",
): FakeMeasurementRow {
  return {
    id: `m-${type}-${value}${idSuffix}`,
    type,
    value,
    unit: "x",
    measuredAt: new Date(Date.UTC(2026, 4, 14 - daysAgo)),
    source: "APPLE_HEALTH",
    externalId: null,
    userId: USER,
  };
}

function workout(
  sportType: "running" | "cycling",
  durationSec: number,
  totalDistanceM: number | null,
  daysAgo = 1,
  idSuffix = "",
): FakeWorkoutRow {
  return {
    id: `w-${sportType}-${durationSec}-${totalDistanceM ?? 0}${idSuffix}`,
    sportType,
    startedAt: new Date(Date.UTC(2026, 4, 14 - daysAgo)),
    durationSec,
    totalDistanceM,
    source: "APPLE_HEALTH",
    externalId: null,
    userId: USER,
  };
}

describe("detectPersonalRecordsForUser — warm-up gate", () => {
  it("does NOT write a PR when only one measurement of a metric exists", async () => {
    const state = {
      measurements: [measurement("ACTIVITY_STEPS", 12000)],
      workouts: [],
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    const result = await detectPersonalRecordsForUser(USER, { prisma });

    expect(result.inserted).toBe(0);
    expect(state.personalRecords).toHaveLength(0);
  });

  it(
    `writes the first PR once ${PR_DETECTION_WARMUP_THRESHOLD} measurements exist`,
    async () => {
      const samples: FakeMeasurementRow[] = [];
      for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD; i++) {
        samples.push(measurement("ACTIVITY_STEPS", 8000 + i * 100, i + 1, `i${i}`));
      }
      // The last sample is the all-time best.
      samples.push(measurement("ACTIVITY_STEPS", 15000, 0, "best"));

      const state = {
        measurements: samples,
        workouts: [],
        personalRecords: [] as FakePersonalRecordRow[],
      };
      const prisma = makeFakePrisma(state);

      const result = await detectPersonalRecordsForUser(USER, { prisma });

      expect(result.inserted).toBeGreaterThanOrEqual(1);
      const stepsPR = state.personalRecords.find(
        (r) => r.metricType === "ACTIVITY_STEPS" && r.metricSlot === null,
      );
      expect(stepsPR).toBeDefined();
      expect(stepsPR?.value).toBe(15000);
      expect(stepsPR?.direction).toBe(PersonalRecordDirection.MAX);
    },
  );
});

describe("detectPersonalRecordsForUser — direction semantics", () => {
  it("picks the MAX value for ACTIVITY_STEPS (higher is the record)", async () => {
    const samples: FakeMeasurementRow[] = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD - 1; i++) {
      samples.push(
        measurement("ACTIVITY_STEPS", 5000 + i * 250, i + 2, `seed-${i}`),
      );
    }
    samples.push(measurement("ACTIVITY_STEPS", 20000, 1, "best"));
    samples.push(measurement("ACTIVITY_STEPS", 9000, 0, "later"));

    const state = {
      measurements: samples,
      workouts: [],
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    await detectPersonalRecordsForUser(USER, { prisma });

    const pr = state.personalRecords.find(
      (r) => r.metricType === "ACTIVITY_STEPS",
    );
    expect(pr?.value).toBe(20000);
  });

  it("picks the MIN value for RESTING_HEART_RATE (lower is the record)", async () => {
    const samples: FakeMeasurementRow[] = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD - 1; i++) {
      samples.push(
        measurement("RESTING_HEART_RATE", 60 + i, i + 2, `seed-${i}`),
      );
    }
    samples.push(measurement("RESTING_HEART_RATE", 47, 1, "best"));
    samples.push(measurement("RESTING_HEART_RATE", 55, 0, "later"));

    const state = {
      measurements: samples,
      workouts: [],
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    await detectPersonalRecordsForUser(USER, { prisma });

    const pr = state.personalRecords.find(
      (r) => r.metricType === "RESTING_HEART_RATE",
    );
    expect(pr?.value).toBe(47);
    expect(pr?.direction).toBe(PersonalRecordDirection.MIN);
  });

  it("never writes a row for a null-direction metric (BP, weight, glucose)", async () => {
    const samples: FakeMeasurementRow[] = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD + 2; i++) {
      samples.push(measurement("WEIGHT", 78 + i, i + 1, `w-${i}`));
      samples.push(measurement("BLOOD_GLUCOSE", 95 + i, i + 1, `g-${i}`));
    }
    const state = {
      measurements: samples,
      workouts: [],
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    await detectPersonalRecordsForUser(USER, { prisma });

    expect(
      state.personalRecords.some((r) => r.metricType === "WEIGHT"),
    ).toBe(false);
    expect(
      state.personalRecords.some((r) => r.metricType === "BLOOD_GLUCOSE"),
    ).toBe(false);
  });
});

describe("detectPersonalRecordsForUser — ties and idempotency", () => {
  it("writes a tie row at the same value but counts it as a tie (push-suppressed)", async () => {
    const samples: FakeMeasurementRow[] = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD - 1; i++) {
      samples.push(
        measurement("ACTIVITY_STEPS", 5000 + i * 100, i + 5, `seed-${i}`),
      );
    }
    // Two readings tied at the all-time best, on different days.
    samples.push(measurement("ACTIVITY_STEPS", 18000, 3, "first-best"));

    const state = {
      measurements: samples,
      workouts: [],
      personalRecords: [
        {
          id: "pr-seed",
          userId: USER,
          metricType: "ACTIVITY_STEPS" as MeasurementType,
          metricSlot: null,
          direction: PersonalRecordDirection.MAX,
          value: 18000,
          unit: "x",
          achievedAt: new Date(Date.UTC(2026, 4, 1)),
          sourceMeasurementId: "m-seed",
          source: "APPLE_HEALTH",
          externalId: null,
        },
      ] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    const result = await detectPersonalRecordsForUser(USER, { prisma });

    expect(result.ties + result.inserted).toBeGreaterThanOrEqual(1);
    // The candidate and the seeded best are both 18000 — a tie should
    // be reported, not an improvement.
    expect(result.ties).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent — re-running with the same state does not duplicate rows", async () => {
    const samples: FakeMeasurementRow[] = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD; i++) {
      samples.push(
        measurement("ACTIVITY_STEPS", 4000 + i * 250, i + 1, `seed-${i}`),
      );
    }
    samples.push(measurement("ACTIVITY_STEPS", 19000, 0, "best"));

    const state = {
      measurements: samples,
      workouts: [],
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    await detectPersonalRecordsForUser(USER, { prisma });
    const after1 = state.personalRecords.length;
    await detectPersonalRecordsForUser(USER, { prisma });
    const after2 = state.personalRecords.length;

    expect(after2).toBe(after1);
  });

  it("multi-source same-value: both candidates considered, dedup index keeps a single row per instant", async () => {
    const sameInstant = new Date(Date.UTC(2026, 4, 1, 8, 0, 0));
    const samples: FakeMeasurementRow[] = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD - 1; i++) {
      samples.push(
        measurement("ACTIVITY_STEPS", 3000 + i * 100, i + 5, `seed-${i}`),
      );
    }
    samples.push(
      {
        id: "m-apple",
        type: "ACTIVITY_STEPS",
        value: 17500,
        unit: "x",
        measuredAt: sameInstant,
        source: "APPLE_HEALTH",
        externalId: null,
        userId: USER,
      },
      {
        id: "m-withings",
        type: "ACTIVITY_STEPS",
        value: 17500,
        unit: "x",
        measuredAt: sameInstant,
        source: "WITHINGS",
        externalId: null,
        userId: USER,
      },
    );

    const state = {
      measurements: samples,
      workouts: [],
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    await detectPersonalRecordsForUser(USER, { prisma });

    // The unique index (userId, metricType, metricSlot, achievedAt)
    // collapses the two rows into one — Migration 0054 deliberately
    // dropped `source` from the dedup key so the worker writes the
    // first-arriving row and suppresses the second.
    const stepRows = state.personalRecords.filter(
      (r) => r.metricType === "ACTIVITY_STEPS",
    );
    expect(stepRows).toHaveLength(1);
  });
});

describe("detectPersonalRecordsForUser — workout slots", () => {
  it("longest_run_duration writes a PR once 7 running workouts exist", async () => {
    const runs: FakeWorkoutRow[] = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD; i++) {
      runs.push(workout("running", 1800 + i * 60, 5000 + i * 200, i + 2, `r${i}`));
    }
    runs.push(workout("running", 7200, 18000, 1, "longest"));

    const state = {
      measurements: [],
      workouts: runs,
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    await detectPersonalRecordsForUser(USER, { prisma });

    const pr = state.personalRecords.find(
      (r) => r.metricSlot === "longest_run_duration",
    );
    expect(pr?.value).toBe(7200);
    expect(pr?.unit).toBe("s");
    expect(pr?.direction).toBe(PersonalRecordDirection.MAX);
  });

  it("longest_distance_run picks the run with the biggest totalDistanceM", async () => {
    const runs: FakeWorkoutRow[] = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD; i++) {
      runs.push(workout("running", 2400, 8000 + i * 100, i + 3, `r${i}`));
    }
    runs.push(workout("running", 3600, 21000, 1, "longest-dist"));

    const state = {
      measurements: [],
      workouts: runs,
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    await detectPersonalRecordsForUser(USER, { prisma });

    const pr = state.personalRecords.find(
      (r) => r.metricSlot === "longest_distance_run",
    );
    expect(pr?.value).toBe(21000);
    expect(pr?.unit).toBe("m");
  });

  it("fastest_5km_time only considers runs >= 5000 m and writes the MIN duration", async () => {
    const runs: FakeWorkoutRow[] = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD; i++) {
      // Short runs (3 km) — must NOT count for the 5km slot.
      runs.push(workout("running", 800, 3000, i + 10, `short-${i}`));
    }
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD; i++) {
      runs.push(workout("running", 1800 + i * 30, 5100 + i * 100, i + 2, `5k-${i}`));
    }
    runs.push(workout("running", 1500, 5050, 1, "5k-fastest"));

    const state = {
      measurements: [],
      workouts: runs,
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    await detectPersonalRecordsForUser(USER, { prisma });

    const pr = state.personalRecords.find(
      (r) => r.metricSlot === "fastest_5km_time",
    );
    expect(pr?.value).toBe(1500);
    expect(pr?.direction).toBe(PersonalRecordDirection.MIN);
  });
});

describe("detectPersonalRecordsForUser — zero-duration MIN guard", () => {
  // Regression for Fix-M / code-M2: the createWorkoutSchema gate now
  // rejects endedAt <= startedAt, but the PR detector stays defensive
  // against any historical row (pre-gate) or future code path that
  // produces a zero-duration workout. A MIN-direction slot (fastest
  // 5 km) sorts ascending — a zero-second row would always win.
  it("ignores zero-duration runs when scanning fastest_5km_time", async () => {
    const runs: FakeWorkoutRow[] = [];
    // Seed: enough legitimate 5 km finishes to clear the warm-up gate.
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD; i++) {
      runs.push(
        workout("running", 1800 + i * 30, 5100 + i * 100, i + 2, `5k-${i}`),
      );
    }
    // Poison row: a workout with durationSec === 0 at the same
    // distance threshold. A MIN-direction selector without the guard
    // would pick this row as "fastest".
    runs.push(workout("running", 0, 5200, 1, "zero-poison"));

    const state = {
      measurements: [],
      workouts: runs,
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    await detectPersonalRecordsForUser(USER, { prisma });

    const pr = state.personalRecords.find(
      (r) => r.metricSlot === "fastest_5km_time",
    );
    expect(pr).toBeDefined();
    // The PR must come from the seeded set, not the poison row.
    expect(pr?.value).toBeGreaterThan(0);
    expect(pr?.value).toBe(1800);
  });
});

describe("detectPersonalRecordsForUser — flags + drift guard", () => {
  it("propagates the silent flag onto the result envelope", async () => {
    const state = {
      measurements: [],
      workouts: [],
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    const loud = await detectPersonalRecordsForUser(USER, { prisma });
    expect(loud.silent).toBe(false);

    const quiet = await detectPersonalRecordsForUser(USER, {
      prisma,
      silent: true,
    });
    expect(quiet.silent).toBe(true);
  });

  it("scans every PR-trackable measurement type at least once", async () => {
    const state = {
      measurements: [],
      workouts: [],
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    const result = await detectPersonalRecordsForUser(USER, { prisma });

    const trackable = measurementTypeEnum.options.filter((t) =>
      isPRTrackable(t as MeasurementType),
    );
    expect(result.scanned).toBeGreaterThanOrEqual(trackable.length);
  });
});

describe("compareToCurrentBest — pure helper", () => {
  it("classifies improvement / tie / no-improvement for MAX direction", () => {
    const { compareToCurrentBest } = __test__;
    expect(compareToCurrentBest(100, undefined, PersonalRecordDirection.MAX)).toBe(
      "improvement",
    );
    expect(compareToCurrentBest(120, 100, PersonalRecordDirection.MAX)).toBe(
      "improvement",
    );
    expect(compareToCurrentBest(100, 100, PersonalRecordDirection.MAX)).toBe(
      "tie",
    );
    expect(compareToCurrentBest(80, 100, PersonalRecordDirection.MAX)).toBe(
      "no-improvement",
    );
  });

  it("classifies improvement / tie / no-improvement for MIN direction", () => {
    const { compareToCurrentBest } = __test__;
    expect(compareToCurrentBest(50, undefined, PersonalRecordDirection.MIN)).toBe(
      "improvement",
    );
    expect(compareToCurrentBest(45, 50, PersonalRecordDirection.MIN)).toBe(
      "improvement",
    );
    expect(compareToCurrentBest(50, 50, PersonalRecordDirection.MIN)).toBe("tie");
    expect(compareToCurrentBest(60, 50, PersonalRecordDirection.MIN)).toBe(
      "no-improvement",
    );
  });
});

describe("detectPersonalRecordsForUser — null-slot dup regression", () => {
  // Regression for Fix-O / senior-M3 + L2: the personal_records unique
  // index is `(userId, metricType, metricSlot, achievedAt)` with NULLS
  // NOT DISTINCT. Measurement-type PRs (ACTIVITY_STEPS, RESTING_HEART_RATE,
  // …) have `metricSlot = NULL`. Two back-to-back invocations on the
  // exact same input — same userId, same metricType, null slot, same
  // achievedAt — must coalesce to a single row. A future refactor that
  // forgets to compare NULL slot values via the NULLS-NOT-DISTINCT
  // semantics would silently double-insert; this test pins the
  // contract so the regression surfaces immediately.
  it("does not double-insert on back-to-back invocations with a NULL slot and the same achievedAt", async () => {
    const samples: FakeMeasurementRow[] = [];
    for (let i = 0; i < PR_DETECTION_WARMUP_THRESHOLD; i++) {
      samples.push(
        measurement("ACTIVITY_STEPS", 4000 + i * 250, i + 2, `seed-${i}`),
      );
    }
    // The candidate row that drives the PR write — pinned to a
    // specific UTC instant so both invocations see the same achievedAt.
    samples.push({
      id: "m-best",
      type: "ACTIVITY_STEPS",
      value: 19000,
      unit: "x",
      measuredAt: new Date(Date.UTC(2026, 4, 13, 8, 30, 0)),
      source: "APPLE_HEALTH",
      externalId: null,
      userId: USER,
    });

    const state = {
      measurements: samples,
      workouts: [],
      personalRecords: [] as FakePersonalRecordRow[],
    };
    const prisma = makeFakePrisma(state);

    await detectPersonalRecordsForUser(USER, { prisma });
    const stepRowsAfterFirst = state.personalRecords.filter(
      (r) => r.metricType === "ACTIVITY_STEPS" && r.metricSlot === null,
    );
    expect(stepRowsAfterFirst).toHaveLength(1);

    // Second invocation — same state, no new measurement rows. The
    // dedup index must coalesce; the row count must stay at 1.
    await detectPersonalRecordsForUser(USER, { prisma });
    const stepRowsAfterSecond = state.personalRecords.filter(
      (r) => r.metricType === "ACTIVITY_STEPS" && r.metricSlot === null,
    );
    expect(stepRowsAfterSecond).toHaveLength(1);
    expect(stepRowsAfterSecond[0].achievedAt.getTime()).toBe(
      stepRowsAfterFirst[0].achievedAt.getTime(),
    );
  });
});
