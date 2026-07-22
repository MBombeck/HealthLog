import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  __resetCoachSnapshotCacheForTests,
  buildCoachSnapshot,
} from "../snapshot";
import { eventStorage } from "@/lib/logging/context";
import { WideEventBuilder } from "@/lib/logging/event-builder";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    // v1.18.1 P4 — the illness context block reads active + recent episodes.
    illnessEpisode: { findMany: vi.fn(async () => []) },
    // v1.18.11 (#65) — the labs context block reads recent lab results.
    labResult: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("@/lib/insights/features", () => ({
  extractFeatures: vi.fn(),
}));

// v1.18.0 — the snapshot resolves the per-user module map at build start
// so a disabled data-domain module's data never enters the coach context.
// Mock the gate's `resolveModuleMap` so the default fixture is "all
// modules on" (the legacy behaviour) and individual tests can flip a
// single module off without standing up the real gate's DB reads.
import { MODULE_KEYS, type ModuleKey } from "@/lib/modules/registry";

const allModulesEnabled = (): Record<ModuleKey, boolean> =>
  Object.fromEntries(MODULE_KEYS.map((k) => [k, true])) as Record<
    ModuleKey,
    boolean
  >;

vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: vi.fn(),
  // v1.18.0 — the coach cycle block now gates through
  // `isCycleAvailableForUser` → `isModuleEnabled(userId, "cycle")`. Back the
  // mock with the same resolved map the tests already drive via
  // `resolveModuleMap`, so flipping `cycle` off in a fixture also closes the
  // cycle block (operator/user kill-switch parity) without a DB read.
  isModuleEnabled: vi.fn(async (...args: [string, ModuleKey]) => {
    const key = args[1];
    const map = await (
      resolveModuleMap as unknown as () => Promise<Record<ModuleKey, boolean>>
    )();
    return map[key] !== false;
  }),
}));
import { resolveModuleMap } from "@/lib/modules/gate";
const resolveModuleMapMock = resolveModuleMap as unknown as ReturnType<
  typeof vi.fn
>;

// The rolling-profile memory block reads its own persisted sources
// (period narrative + band transitions); stub it out here so the
// query-count + cache assertions below stay scoped to the core snapshot
// reads. Its own assembly is covered in memory-snapshot.test.ts.
vi.mock("../memory-snapshot", () => ({
  buildCoachMemoryBlock: vi.fn().mockResolvedValue(null),
}));

// v1.18.0 — the recovery composites (derived block + trajectory) are read
// through these builders. Stub them so the recovery-disable test can
// assert they are never invoked (the disabled module pays no read cost);
// their own assembly is covered in derived-snapshot.test.ts /
// trajectory-snapshot.test.ts.
vi.mock("../derived-snapshot", () => ({
  buildDerivedSnapshotBlock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../trajectory-snapshot", () => ({
  buildTrajectorySnapshotBlock: vi.fn().mockResolvedValue(null),
}));

import { prisma } from "@/lib/db";
import { extractFeatures } from "@/lib/insights/features";
import {
  reconstructNights,
  sleepNeedMinutes,
} from "@/lib/insights/derived/sleep-score";
import { computeSleepRhythmFromNights } from "@/lib/insights/derived/sleep-rhythm";

const prismaMock = prisma as unknown as {
  measurement: { findMany: ReturnType<typeof vi.fn> };
  moodEntry: { findMany: ReturnType<typeof vi.fn> };
  medicationIntakeEvent: { findMany: ReturnType<typeof vi.fn> };
  medication: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};
const featuresMock = extractFeatures as unknown as ReturnType<typeof vi.fn>;

/**
 * Helper: produce a measurement row N days before "now" at 09:00 UTC.
 */
function daysAgo(
  n: number,
  value: number,
  type: string,
): {
  type: string;
  value: number;
  measuredAt: Date;
} {
  const ms = Date.now() - n * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  d.setUTCHours(9, 0, 0, 0);
  return { type, value, measuredAt: d };
}

describe("buildCoachSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // v1.4.33 — `buildCoachSnapshot` now memoises results in-process
    // for 60 s. Reset the cache between tests so each test sees its
    // own freshly-mocked Prisma fixture.
    __resetCoachSnapshotCacheForTests();
    prismaMock.measurement.findMany.mockResolvedValue([]);
    prismaMock.moodEntry.findMany.mockResolvedValue([]);
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
    prismaMock.medication.findMany.mockResolvedValue([]);
    // v1.4.23 H4 — snapshot now reads `User.coachPrefsJson` to apply
    // per-user excludeMetrics. Default null = use legacy defaults.
    prismaMock.user.findUnique.mockResolvedValue({ coachPrefsJson: null });
    // v1.18.0 — default fixture: every toggleable module enabled.
    resolveModuleMapMock.mockResolvedValue(allModulesEnabled());
    featuresMock.mockResolvedValue({
      bloodPressure: undefined,
      weight: undefined,
      pulse: undefined,
      mood: undefined,
    });
  });

  it("characterizes the complete public output for core, additive, profile, and native blocks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    try {
      const measurementRows = [
        daysAgo(20, 122, "BLOOD_PRESSURE_SYS"),
        daysAgo(20, 78, "BLOOD_PRESSURE_DIA"),
        daysAgo(10, 128, "BLOOD_PRESSURE_SYS"),
        daysAgo(10, 82, "BLOOD_PRESSURE_DIA"),
        daysAgo(20, 81.4, "WEIGHT"),
        daysAgo(4, 80.8, "WEIGHT"),
        daysAgo(20, 67, "PULSE"),
        daysAgo(3, 63, "PULSE"),
        daysAgo(18, 7_200, "ACTIVITY_STEPS"),
        daysAgo(2, 8_400, "ACTIVITY_STEPS"),
        daysAgo(12, 24.8, "BODY_MASS_INDEX"),
        daysAgo(5, 24.6, "BODY_MASS_INDEX"),
        daysAgo(15, 33.2, "SKIN_TEMPERATURE"),
        daysAgo(1, 33.5, "SKIN_TEMPERATURE"),
      ];
      const dayStrainRows = [
        { value: 11.24, measuredAt: daysAgo(6, 0, "DAY_STRAIN").measuredAt },
        { value: 13.87, measuredAt: daysAgo(1, 0, "DAY_STRAIN").measuredAt },
      ];
      prismaMock.measurement.findMany.mockImplementation(
        (args?: { where?: { type?: string | { in?: string[] } } }) => {
          if (args?.where?.type === "DAY_STRAIN") {
            return Promise.resolve(dayStrainRows);
          }
          if (
            typeof args?.where?.type === "object" &&
            Array.isArray(args.where.type.in)
          ) {
            return Promise.resolve([...measurementRows]);
          }
          return Promise.resolve([]);
        },
      );
      prismaMock.moodEntry.findMany.mockResolvedValue([
        { moodLoggedAt: daysAgo(16, 0, "MOOD").measuredAt, score: 3 },
        { moodLoggedAt: daysAgo(2, 0, "MOOD").measuredAt, score: 5 },
      ]);
      prismaMock.user.findUnique.mockResolvedValue({
        coachPrefsJson: null,
        timezone: "UTC",
        locale: "en",
        sourcePriorityJson: null,
        gender: null,
        cycleProfile: null,
        glucoseUnit: null,
        hasDiabetes: false,
      });
      featuresMock.mockResolvedValue({
        bloodPressure: {
          avgSys30: 125,
          avgDia30: 80,
          coverage: { count: 4 },
        },
        weight: { latest: 80.8, bmi: 24.7, coverage: { count: 2 } },
        pulse: { avg7: 63, coverage: { count: 2 } },
        mood: { avg30: 4, coverage: { count: 2 } },
        context: { heightCm: 181, ageYears: 41, gender: "MALE" },
      });

      const out = await buildCoachSnapshot("characterization-user", {
        window: "last30days",
        sources: [
          "bp",
          "weight",
          "pulse",
          "mood",
          "steps",
          "bmi",
          "skin_temp",
          "hrv",
        ],
      });

      expect(out.snapshotJson).toBe(JSON.stringify(out.sections, null, 2));
      expect(out).toMatchInlineSnapshot(`
        {
          "provenance": {
            "counts": {
              "bmi": 2,
              "bp": 4,
              "mood": 2,
              "pulse": 2,
              "skin_temp": 2,
              "steps": 2,
              "weight": 2,
            },
            "metrics": [
              "bp",
              "weight",
              "pulse",
              "mood",
              "bmi",
              "steps",
              "skin_temp",
            ],
            "windows": [
              "last30days",
              "last90days",
              "last7days",
            ],
          },
          "referenceGrounding": "REFERENCE GROUNDING (general guidance — not a diagnosis)
        These are published POPULATION reference bands for context only — they
        are not personal medical advice, not a diagnosis, and not a target set
        for this user. The user's own baseline always leads the read. Cite a
        band only to orient a reply ("the general reference range is …"); never
        tell the user they "have" or "don't have" a condition from a band.
        Blood pressure follows the European ESH 2023 line; US (ACC/AHA) and
        ESC framings differ and are context, not the call. This block does not
        change any safety rule above — keep deferring dose / diagnosis / drug-
        level questions to the user's clinician exactly as instructed.

        - blood pressure (systolic): general reference ≤120 mmHg (ESH 2023 (2023)). Yours sits just outside the general reference band.
        - BMI: general reference 18.5–24.9 kg/m² (WHO 2000 BMI (2000)). Yours sits inside the general reference band.

        Reminder: ranges are general guidance, not personal medical advice.",
          "sections": {
            "anthropometrics": {
              "ageYears": 41,
              "gender": "MALE",
              "heightCm": 181,
            },
            "bloodPressure": {
              "aggregate": {
                "avgDia30": 80,
                "avgSys30": 125,
                "coverage": {
                  "count": 4,
                },
              },
              "timeline": {
                "recent": [
                  {
                    "date": "2026-07-10",
                    "dia": 82,
                    "sys": 128,
                    "weekday": "Fri",
                  },
                ],
                "weeklyDia": [
                  {
                    "count": 1,
                    "mean": 78,
                    "weekISO": "2026-W27",
                  },
                ],
                "weeklySys": [
                  {
                    "count": 1,
                    "mean": 122,
                    "weekISO": "2026-W27",
                  },
                ],
              },
            },
            "bodyMassIndex": {
              "timeline": {
                "recent": [
                  {
                    "date": "2026-07-08",
                    "value": 24.8,
                    "weekday": "Wed",
                  },
                  {
                    "date": "2026-07-15",
                    "value": 24.6,
                    "weekday": "Wed",
                  },
                ],
                "weekly": [],
              },
            },
            "dayStrain": {
              "days": 2,
              "latest": 13.9,
              "note": "Device-native day strain; prefer over derived.STRAIN_SCORE (computed 0-100 proxy).",
              "recentMean": 12.6,
              "scale": "0-21",
              "source": "WHOOP-native",
            },
            "mood": {
              "aggregate": {
                "avg30": 4,
                "coverage": {
                  "count": 2,
                },
              },
              "timeline": {
                "recent": [
                  {
                    "date": "2026-07-18",
                    "value": 5,
                    "weekday": "Sat",
                  },
                ],
                "weekly": [
                  {
                    "count": 1,
                    "mean": 3,
                    "weekISO": "2026-W27",
                  },
                ],
              },
            },
            "pulse": {
              "aggregate": {
                "avg7": 63,
                "coverage": {
                  "count": 2,
                },
              },
              "timeline": {
                "recent": [
                  {
                    "date": "2026-07-17",
                    "value": 63,
                    "weekday": "Fri",
                  },
                ],
                "weekly": [
                  {
                    "count": 1,
                    "mean": 67,
                    "weekISO": "2026-W27",
                  },
                ],
              },
            },
            "scope": {
              "sources": [
                "bp",
                "weight",
                "pulse",
                "mood",
                "steps",
                "bmi",
                "skin_temp",
                "hrv",
              ],
              "timelineRecentDays": 14,
              "window": "last30days",
            },
            "skinTemperature": {
              "timeline": {
                "recent": [
                  {
                    "date": "2026-07-19",
                    "value": 33.5,
                    "weekday": "Sun",
                  },
                ],
                "weekly": [
                  {
                    "count": 1,
                    "mean": 33.2,
                    "weekISO": "2026-W27",
                  },
                ],
              },
            },
            "steps": {
              "timeline": {
                "recent": [
                  {
                    "date": "2026-07-18",
                    "value": 8400,
                    "weekday": "Sat",
                  },
                ],
                "weekly": [
                  {
                    "count": 1,
                    "mean": 7200,
                    "weekISO": "2026-W27",
                  },
                ],
              },
            },
            "weight": {
              "aggregate": {
                "bmi": 24.7,
                "coverage": {
                  "count": 2,
                },
                "latest": 80.8,
              },
              "timeline": {
                "recent": [
                  {
                    "date": "2026-07-16",
                    "value": 80.8,
                    "weekday": "Thu",
                  },
                ],
                "weekly": [
                  {
                    "count": 1,
                    "mean": 81.4,
                    "weekISO": "2026-W27",
                  },
                ],
              },
            },
          },
          "snapshotJson": "{
          "bloodPressure": {
            "aggregate": {
              "avgSys30": 125,
              "avgDia30": 80,
              "coverage": {
                "count": 4
              }
            },
            "timeline": {
              "recent": [
                {
                  "date": "2026-07-10",
                  "weekday": "Fri",
                  "sys": 128,
                  "dia": 82
                }
              ],
              "weeklySys": [
                {
                  "weekISO": "2026-W27",
                  "mean": 122,
                  "count": 1
                }
              ],
              "weeklyDia": [
                {
                  "weekISO": "2026-W27",
                  "mean": 78,
                  "count": 1
                }
              ]
            }
          },
          "weight": {
            "aggregate": {
              "latest": 80.8,
              "bmi": 24.7,
              "coverage": {
                "count": 2
              }
            },
            "timeline": {
              "recent": [
                {
                  "date": "2026-07-16",
                  "weekday": "Thu",
                  "value": 80.8
                }
              ],
              "weekly": [
                {
                  "weekISO": "2026-W27",
                  "mean": 81.4,
                  "count": 1
                }
              ]
            }
          },
          "pulse": {
            "aggregate": {
              "avg7": 63,
              "coverage": {
                "count": 2
              }
            },
            "timeline": {
              "recent": [
                {
                  "date": "2026-07-17",
                  "weekday": "Fri",
                  "value": 63
                }
              ],
              "weekly": [
                {
                  "weekISO": "2026-W27",
                  "mean": 67,
                  "count": 1
                }
              ]
            }
          },
          "mood": {
            "aggregate": {
              "avg30": 4,
              "coverage": {
                "count": 2
              }
            },
            "timeline": {
              "recent": [
                {
                  "date": "2026-07-18",
                  "weekday": "Sat",
                  "value": 5
                }
              ],
              "weekly": [
                {
                  "weekISO": "2026-W27",
                  "mean": 3,
                  "count": 1
                }
              ]
            }
          },
          "bodyMassIndex": {
            "timeline": {
              "recent": [
                {
                  "date": "2026-07-08",
                  "weekday": "Wed",
                  "value": 24.8
                },
                {
                  "date": "2026-07-15",
                  "weekday": "Wed",
                  "value": 24.6
                }
              ],
              "weekly": []
            }
          },
          "steps": {
            "timeline": {
              "recent": [
                {
                  "date": "2026-07-18",
                  "weekday": "Sat",
                  "value": 8400
                }
              ],
              "weekly": [
                {
                  "weekISO": "2026-W27",
                  "mean": 7200,
                  "count": 1
                }
              ]
            }
          },
          "skinTemperature": {
            "timeline": {
              "recent": [
                {
                  "date": "2026-07-19",
                  "weekday": "Sun",
                  "value": 33.5
                }
              ],
              "weekly": [
                {
                  "weekISO": "2026-W27",
                  "mean": 33.2,
                  "count": 1
                }
              ]
            }
          },
          "anthropometrics": {
            "heightCm": 181,
            "ageYears": 41,
            "gender": "MALE"
          },
          "dayStrain": {
            "source": "WHOOP-native",
            "scale": "0-21",
            "latest": 13.9,
            "recentMean": 12.6,
            "days": 2,
            "note": "Device-native day strain; prefer over derived.STRAIN_SCORE (computed 0-100 proxy)."
          },
          "scope": {
            "window": "last30days",
            "sources": [
              "bp",
              "weight",
              "pulse",
              "mood",
              "steps",
              "bmi",
              "skin_temp",
              "hrv"
            ],
            "timelineRecentDays": 14
          }
        }",
        }
      `);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a 'general'-only provenance when nothing is in the log", async () => {
    const out = await buildCoachSnapshot("user-1");
    expect(out.provenance.metrics).toContain("general");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.scope.window).toBe("last30days");
  });

  it("includes day-level BP rows with weekday labels for the recent window", async () => {
    featuresMock.mockResolvedValue({
      bloodPressure: {
        avgSys30: 138,
        avgDia30: 85,
        coverage: { count: 4 },
      },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(2, 142, "BLOOD_PRESSURE_SYS"),
      daysAgo(2, 92, "BLOOD_PRESSURE_DIA"),
      daysAgo(5, 130, "BLOOD_PRESSURE_SYS"),
      daysAgo(5, 80, "BLOOD_PRESSURE_DIA"),
    ]);

    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    const recent = parsed.bloodPressure.timeline.recent as Array<{
      date: string;
      weekday: string;
      sys: number;
      dia: number;
    }>;
    expect(recent.length).toBe(2);
    expect(recent[0]).toMatchObject({ sys: expect.any(Number) });
    expect(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]).toContain(
      recent[0].weekday,
    );
    expect(out.provenance.metrics).toContain("bp");
  });

  it("respects the scope.sources filter — excluded metrics drop out", async () => {
    featuresMock.mockResolvedValue({
      bloodPressure: { avgSys30: 138, coverage: { count: 4 } },
      weight: { latest: 80, coverage: { count: 4 } },
    });

    const out = await buildCoachSnapshot("user-1", {
      sources: ["weight"],
      window: "last30days",
    });
    expect(out.provenance.metrics).toContain("weight");
    expect(out.provenance.metrics).not.toContain("bp");
    // Snapshot shouldn't mention BP either
    expect(out.snapshotJson).not.toContain("bloodPressure");
  });

  it("respects the scope.window — last7days yields a tighter window", async () => {
    featuresMock.mockResolvedValue({
      pulse: { avg7: 70, coverage: { count: 4 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(2, 70, "PULSE"),
    ]);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["pulse"],
      window: "last7days",
    });
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.scope.window).toBe("last7days");
    expect(parsed.pulse.timeline.recent.length).toBe(1);
  });

  it("respects the scope.window — lastYear flags the year-in-review window", async () => {
    featuresMock.mockResolvedValue({
      bloodPressure: { avg30Sys: 124, coverage: { count: 50 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(120, 124, "BLOOD_PRESSURE_SYS"),
      daysAgo(120, 81, "BLOOD_PRESSURE_DIA"),
    ]);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["bp"],
      window: "lastYear",
    });
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.scope.window).toBe("lastYear");
    expect(out.provenance.windows).toContain("lastYear");
  });

  // v1.7.0 — the default source set now expands the legacy default
  // clusters (cardio + body + mood + medication) instead of a flat
  // five-source list. The legacy core sources (bp/weight/pulse/mood/
  // compliance) are still present; the additive members (HRV, resting
  // HR, body-composition, …) ride along but only surface a block when
  // the user has rows for them. This is the documented additive
  // default + PROMPT_VERSION bump, not strict legacy byte-parity.
  it("expands the default clusters when no scope is provided", async () => {
    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    const sources = parsed.scope.sources as string[];
    for (const core of ["bp", "weight", "pulse", "mood", "compliance"]) {
      expect(sources).toContain(core);
    }
    // Additive members from the cardio + body clusters.
    expect(sources).toContain("hrv");
    expect(sources).toContain("body_fat");
    // Clusters that are OFF by default contribute no sources.
    expect(sources).not.toContain("steps");
    expect(sources).not.toContain("glucose");
    expect(sources).not.toContain("workouts");
    expect(parsed.scope.window).toBe("last30days");
  });

  // v1.4.36 W3 T2 — `medications` exclusion drops the GLP-1 weeklyContext
  // block + the compliance source so no medication data reaches the
  // prompt. Empty-data behaviour: when the user has no GLP-1 medication
  // the block is absent anyway (this test only proves the toggle path).
  it("omits weeklyContext.glp1 when excludeMetrics contains 'medications'", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: { excludeMetrics: ["medications"] },
      timezone: "Europe/Berlin",
    });
    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.weeklyContext).toBeUndefined();
    expect(parsed.compliance).toBeUndefined();
    expect(parsed.scope.sources).not.toContain("compliance");
  });

  // v1.17 W1c — the coach's headline adherence % must route through the
  // SAME `calculateCompliance(...).rate` authority the medication card
  // shows, never a per-day / per-week denominator of its own. A daily med
  // with 7 of 10 expected doses taken reads 70 % on the card; the coach
  // snapshot must surface the identical figure on `compliance.rate`.
  it("surfaces a headline compliance rate equal to calculateCompliance().rate", async () => {
    const { calculateCompliance, buildComplianceMedicationContext } =
      await import("@/lib/analytics/compliance");

    const dayMs = 24 * 60 * 60 * 1000;
    const createdAt = new Date(Date.now() - 40 * dayMs);
    // Ten daily doses 1..10 days ago at 08:00 UTC; the 3 most recent
    // confirmed-late and the rest taken on time, except days 4/7/9 missed.
    const schedule = {
      id: "sched-1",
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      timesOfDay: ["08:00"],
      reminderGraceMinutes: null,
      rrule: null,
      rollingIntervalDays: null,
      scheduleType: null,
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
      doseWindows: null,
    };
    const missedDays = new Set([4, 7, 9]);
    const intakeEvents = [];
    for (let n = 1; n <= 10; n++) {
      const scheduledFor = new Date(Date.now() - n * dayMs);
      scheduledFor.setUTCHours(8, 0, 0, 0);
      const missed = missedDays.has(n);
      intakeEvents.push({
        scheduledFor,
        takenAt: missed ? null : scheduledFor,
        skipped: false,
        autoMissed: missed,
      });
    }
    const medication = {
      id: "med-1",
      name: "Testdrug",
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt,
      schedules: [schedule],
      scheduleRevisions: [],
      intakeEvents,
    };
    // The compliance query and the GLP-1 query share this mock; only the
    // compliance one (no `treatmentClass` filter) gets the fixture so the
    // GLP-1 block — which selects `doseChanges` etc. — sees no rows.
    prismaMock.medication.findMany.mockImplementation(
      (args?: { where?: { treatmentClass?: string } }) => {
        if (args?.where?.treatmentClass === "GLP1") return Promise.resolve([]);
        return Promise.resolve([medication]);
      },
    );
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: null,
      timezone: "Europe/Berlin",
    });

    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);

    expect(parsed.compliance).toBeDefined();
    expect(parsed.compliance.rate).not.toBeNull();

    // Independent authority over the same window the coach uses (30-day
    // default scope), same ledger context — the coach rate must equal it.
    const now = new Date();
    const ctx = buildComplianceMedicationContext(
      medication,
      null,
      "Europe/Berlin",
    );
    const authority = calculateCompliance(
      intakeEvents,
      [schedule],
      30,
      createdAt,
      { now, medicationContext: ctx },
    );
    expect(parsed.compliance.rate).toBe(authority.rate);
  });

  // v1.4.36 W3 T2 — `anthropometrics` exclusion drops the profile
  // block even when features.context has populated fields.
  it("omits anthropometrics when excludeMetrics contains 'anthropometrics'", async () => {
    featuresMock.mockResolvedValue({
      context: { heightCm: 180, ageYears: 45, gender: "MALE" },
    });
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: { excludeMetrics: ["anthropometrics"] },
      timezone: "Europe/Berlin",
    });
    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.anthropometrics).toBeUndefined();
  });

  // v1.4.36 W3 T2 — anthropometrics block is added when features.context
  // has at least one non-null field AND the exclusion is off.
  it("includes anthropometrics when context has data and exclusion is off", async () => {
    featuresMock.mockResolvedValue({
      context: { heightCm: 180, ageYears: 45, gender: "MALE" },
    });
    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.anthropometrics).toEqual({
      heightCm: 180,
      ageYears: 45,
      gender: "MALE",
    });
  });

  // v1.4.36 W3 T2 — empty-block omit: when every anthropometric field
  // is null the block is dropped entirely, not emitted as a labelled
  // null-trio that would render as `Hier sind die Profildaten: [keine]`
  // in the eventual prompt.
  it("drops anthropometrics when every field is null", async () => {
    featuresMock.mockResolvedValue({
      context: { heightCm: null, ageYears: null, gender: null },
    });
    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.anthropometrics).toBeUndefined();
  });

  it("scope-only-mood pulls just mood data, no measurements query", async () => {
    featuresMock.mockResolvedValue({
      mood: { avg30: 4.2, coverage: { count: 12 } },
    });
    prismaMock.moodEntry.findMany.mockResolvedValue([
      {
        moodLoggedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        score: 4,
      },
    ]);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["mood"],
    });
    expect(prismaMock.measurement.findMany).not.toHaveBeenCalled();
    expect(out.provenance.metrics).toContain("mood");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.mood.timeline.recent.length).toBe(1);
  });

  // v1.4.33 — 60 s in-process snapshot cache. A chat conversation
  // sends 2-4 turns within a minute and rebuilding the snapshot from
  // ~10 measurement reads on every turn is wasteful. Cache hits skip
  // every persistent read; cache misses on a different scope (window
  // or sources) compute fresh.
  it("memoises the result for repeated (userId, scope) within the 60 s window", async () => {
    featuresMock.mockResolvedValue({
      weight: { avg30: 82.1, coverage: { count: 5 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(2, 82.0, "WEIGHT"),
      daysAgo(5, 82.4, "WEIGHT"),
    ]);

    const first = await buildCoachSnapshot("user-1", { sources: ["weight"] });
    const second = await buildCoachSnapshot("user-1", { sources: ["weight"] });

    // Same JSON shape on both calls.
    expect(second.snapshotJson).toBe(first.snapshotJson);
    // Prisma reads ran once for the first call; the second call short-
    // circuits on the cache so the count is still 1.
    expect(prismaMock.measurement.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("recomputes when the scope window or sources change", async () => {
    featuresMock.mockResolvedValue({
      weight: { avg30: 82.1, coverage: { count: 5 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(3, 82.0, "WEIGHT"),
    ]);

    await buildCoachSnapshot("user-1", {
      window: "last7days",
      sources: ["weight"],
    });
    await buildCoachSnapshot("user-1", {
      window: "last30days",
      sources: ["weight"],
    });

    // Two distinct window keys → two cache slots → two Prisma reads.
    expect(prismaMock.measurement.findMany).toHaveBeenCalledTimes(2);
  });

  // ── v1.17.0 sleep-rhythm block (sleep-debt + chronotype) ──────────
  //
  // The coach reads the SAME computed values the Sleep page + dashboard
  // show: it hands the canonical per-night reconstruction to the SAME
  // assembler (`computeSleepRhythmFromNights`) the dashboard route uses,
  // never recomputing sleep-debt or chronotype inline. These tests pin
  // the reuse contract + the learning-gate honesty.

  /**
   * One night's bare-ASLEEP block, wake instant in UTC. `reconstructNights`
   * reads asleep = `asleepMinutes` and a midpoint at wake − asleep/2 — the
   * same fixture shape the sleep-rhythm unit suite uses.
   */
  function nightRow(wakeIso: string, asleepMinutes: number) {
    return {
      type: "SLEEP_DURATION",
      value: asleepMinutes,
      measuredAt: new Date(wakeIso),
      sleepStage: "ASLEEP" as const,
      source: null,
      deviceType: null,
    };
  }

  it("emits a ready sleepRhythm block equal to the assembler's DTO", async () => {
    // 14 consecutive nights across two weekends → debt ready (≥7 nights)
    // and chronotype ready (≥3 free/weekend nights). 2026-06-01 is a Monday.
    const rows = Array.from({ length: 14 }, (_, i) => {
      const day = 1 + i; // 2026-06-01 .. 2026-06-14
      const dd = String(day).padStart(2, "0");
      return nightRow(`2026-06-${dd}T06:00:00Z`, 360 + (i % 3) * 20);
    });
    prismaMock.measurement.findMany.mockResolvedValue(rows);
    featuresMock.mockResolvedValue({
      context: { heightCm: null, ageYears: 40, gender: null },
    });
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: null,
      timezone: "UTC",
    });

    const out = await buildCoachSnapshot("user-1", { sources: ["sleep"] });
    const parsed = JSON.parse(out.snapshotJson);

    // Independently run the SAME engine over the SAME rows + need — the
    // snapshot must equal it field-for-field (reuse, never recompute).
    const expected = computeSleepRhythmFromNights(
      reconstructNights(rows, "UTC", null),
      sleepNeedMinutes(40),
    );
    expect(expected.sleepDebt.state).toBe("ready");
    expect(expected.chronotype.state).toBe("ready");
    expect(expected.chronotype.band).not.toBeNull();

    expect(parsed.sleepRhythm.sleepDebt).toEqual({
      state: expected.sleepDebt.state,
      debtMinutes: expected.sleepDebt.debtMinutes,
      needMinutes: expected.sleepDebt.needMinutes,
    });
    expect(parsed.sleepRhythm.chronotype).toEqual({
      state: expected.chronotype.state,
      band: expected.chronotype.band,
      socialJetlagMinutes: expected.chronotype.socialJetlagMinutes,
    });
  });

  it("never asserts a band for a learning chronotype", async () => {
    // 8 weekday nights (2026-06-15 Mon .. 2026-06-22 Mon, weekends 06-20/21
    // are the only free days) — enough for debt to be ready but the
    // chronotype stays learning until it has ≥3 free-day nights. With only
    // two weekend nights here, the band must NOT be asserted.
    const weekdayRows = [15, 16, 17, 18, 19, 22].map((d) =>
      nightRow(`2026-06-${String(d).padStart(2, "0")}T06:00:00Z`, 380),
    );
    prismaMock.measurement.findMany.mockResolvedValue(weekdayRows);
    featuresMock.mockResolvedValue({
      context: { heightCm: null, ageYears: 40, gender: null },
    });
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: null,
      timezone: "UTC",
    });

    const out = await buildCoachSnapshot("user-1", { sources: ["sleep"] });
    const parsed = JSON.parse(out.snapshotJson);

    const expected = computeSleepRhythmFromNights(
      reconstructNights(weekdayRows, "UTC", null),
      sleepNeedMinutes(40),
    );
    expect(expected.chronotype.state).toBe("learning");

    expect(parsed.sleepRhythm.chronotype.state).toBe("learning");
    // A learning chronotype carries no band the data supports.
    expect(parsed.sleepRhythm.chronotype.band).toBeNull();
    expect(parsed.sleepRhythm.chronotype.socialJetlagMinutes).toBeNull();
  });

  it("omits the sleepRhythm block when no sleep rows exist", async () => {
    prismaMock.measurement.findMany.mockResolvedValue([]);
    featuresMock.mockResolvedValue({
      context: { heightCm: null, ageYears: 40, gender: null },
    });
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: null,
      timezone: "UTC",
    });

    const out = await buildCoachSnapshot("user-1", { sources: ["sleep"] });
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.sleepRhythm).toBeUndefined();
  });

  // ── v1.18.0 module enable/disable — disabled domains never reach the
  // coach context ───────────────────────────────────────────────────────
  //
  // When a toggleable data-domain module is disabled for the account, the
  // snapshot must exclude that domain entirely — the source drops from
  // `scope.sources`, no block is emitted, and the provenance metric is
  // absent. The gate's resolved map is authoritative (delegations already
  // resolved), so the snapshot folds it into the same SYSTEM-side
  // exclusion the user's `excludeMetrics` flow already drives.

  it("drops the mood domain from the snapshot when the mood module is disabled", async () => {
    resolveModuleMapMock.mockResolvedValue({
      ...allModulesEnabled(),
      mood: false,
    });
    featuresMock.mockResolvedValue({
      mood: { avg30: 4.2, coverage: { count: 12 } },
    });
    prismaMock.moodEntry.findMany.mockResolvedValue([
      {
        moodLoggedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        score: 4,
      },
    ]);

    const out = await buildCoachSnapshot("user-1", { sources: ["mood"] });
    const parsed = JSON.parse(out.snapshotJson);

    // No mood block, no mood source in scope, no mood metric in provenance.
    expect(parsed.mood).toBeUndefined();
    expect(parsed.scope.sources).not.toContain("mood");
    expect(out.provenance.metrics).not.toContain("mood");
    // The disabled domain's table is never even read.
    expect(prismaMock.moodEntry.findMany).not.toHaveBeenCalled();
  });

  it("drops the glucose domain when the glucose module is disabled", async () => {
    resolveModuleMapMock.mockResolvedValue({
      ...allModulesEnabled(),
      glucose: false,
    });
    featuresMock.mockResolvedValue({});
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(2, 105, "BLOOD_GLUCOSE"),
      daysAgo(4, 98, "BLOOD_GLUCOSE"),
    ]);

    const out = await buildCoachSnapshot("user-1", { sources: ["glucose"] });
    const parsed = JSON.parse(out.snapshotJson);

    expect(parsed.glucose).toBeUndefined();
    expect(parsed.scope.sources).not.toContain("glucose");
    expect(out.provenance.metrics).not.toContain("glucose");
  });

  it("drops the environment/exposure blocks when the environment module is disabled", async () => {
    // The opt-in environment cluster owns the audio-exposure / daylight /
    // skin-temperature sources. With the module off, none may reach the model.
    resolveModuleMapMock.mockResolvedValue({
      ...allModulesEnabled(),
      environment: false,
    });
    featuresMock.mockResolvedValue({});
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(2, 72, "AUDIO_EXPOSURE_ENV"),
      daysAgo(3, 33.1, "SKIN_TEMPERATURE"),
      daysAgo(4, 45, "TIME_IN_DAYLIGHT"),
    ]);

    const envSources = [
      "audio_env",
      "audio_headphone",
      "audio_event",
      "daylight",
      "skin_temp",
    ] as const;
    const out = await buildCoachSnapshot("user-1", {
      sources: [...envSources],
    });
    const parsed = JSON.parse(out.snapshotJson);

    // No environment block reaches the prompt.
    expect(parsed.audioExposureEnvironment).toBeUndefined();
    expect(parsed.audioExposureHeadphone).toBeUndefined();
    expect(parsed.audioExposureEvent).toBeUndefined();
    expect(parsed.timeInDaylight).toBeUndefined();
    expect(parsed.skinTemperature).toBeUndefined();
    // Every environment source token is stripped from scope.
    for (const src of envSources) {
      expect(parsed.scope.sources).not.toContain(src);
      expect(out.provenance.metrics).not.toContain(src);
    }
  });

  it("drops the sleep + sleepRhythm blocks when the sleep module is disabled", async () => {
    resolveModuleMapMock.mockResolvedValue({
      ...allModulesEnabled(),
      sleep: false,
    });
    // 14 nights that would otherwise build both the sleep block and a
    // ready sleepRhythm DTO.
    const rows = Array.from({ length: 14 }, (_, i) => {
      const dd = String(1 + i).padStart(2, "0");
      return {
        type: "SLEEP_DURATION",
        value: 360 + (i % 3) * 20,
        measuredAt: new Date(`2026-06-${dd}T06:00:00Z`),
        sleepStage: "ASLEEP" as const,
        source: null,
        deviceType: null,
      };
    });
    prismaMock.measurement.findMany.mockResolvedValue(rows);
    featuresMock.mockResolvedValue({
      context: { heightCm: null, ageYears: 40, gender: null },
    });
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: null,
      timezone: "UTC",
    });

    const out = await buildCoachSnapshot("user-1", { sources: ["sleep"] });
    const parsed = JSON.parse(out.snapshotJson);

    expect(parsed.sleep).toBeUndefined();
    expect(parsed.sleepRhythm).toBeUndefined();
    expect(parsed.scope.sources).not.toContain("sleep");
    expect(out.provenance.metrics).not.toContain("sleep");
  });

  it("drops the recovery composites when the recovery module is disabled, even with sleep on", async () => {
    // Recovery off but sleep on. `derivedActive` reads the sleep signal,
    // so without an explicit recovery gate the derived / dayStrain /
    // trajectory blocks would still build off sleep alone.
    resolveModuleMapMock.mockResolvedValue({
      ...allModulesEnabled(),
      recovery: false,
    });
    const { buildDerivedSnapshotBlock } = await import("../derived-snapshot");
    const { buildTrajectorySnapshotBlock } =
      await import("../trajectory-snapshot");

    prismaMock.measurement.findMany.mockResolvedValue([]);
    featuresMock.mockResolvedValue({
      context: { heightCm: 180, ageYears: 40, gender: "MALE" },
    });

    const out = await buildCoachSnapshot("user-1", {
      sources: ["sleep", "hrv", "resting_hr", "vo2_max"],
    });
    const parsed = JSON.parse(out.snapshotJson);

    // No recovery composites reach the prompt.
    expect(parsed.derived).toBeUndefined();
    expect(parsed.dayStrain).toBeUndefined();
    expect(parsed.trajectory).toBeUndefined();
    // The recovery source tokens are stripped from scope.
    for (const src of ["hrv", "resting_hr", "vo2_max"]) {
      expect(parsed.scope.sources).not.toContain(src);
    }
    // The derived / trajectory readers are never even called — the
    // disabled module pays no read cost.
    expect(buildDerivedSnapshotBlock).not.toHaveBeenCalled();
    expect(buildTrajectorySnapshotBlock).not.toHaveBeenCalled();
  });

  it("keeps an enabled domain present while a sibling module is disabled", async () => {
    // glucose off, weight on — weight must still flow through.
    resolveModuleMapMock.mockResolvedValue({
      ...allModulesEnabled(),
      glucose: false,
    });
    featuresMock.mockResolvedValue({
      weight: { latest: 80, coverage: { count: 4 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(2, 80.0, "WEIGHT"),
    ]);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["weight", "glucose"],
    });
    const parsed = JSON.parse(out.snapshotJson);

    expect(parsed.weight).toBeDefined();
    expect(parsed.scope.sources).toContain("weight");
    expect(out.provenance.metrics).toContain("weight");
    expect(parsed.scope.sources).not.toContain("glucose");
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.4.43 W13 L-2 — snapshot free-text regression guard.
//
// Every snapshot builder is allowed to ship arbitrary structured data
// (numbers, booleans, ISO dates, enum strings) into the SNAPSHOT JSON
// that prefixes the Coach userPrompt. Free-text fields (medication name,
// dose unit, note bodies, free-form descriptions) MUST wrap through
// `sanitizeForPrompt` first — otherwise a user-controlled string
// containing "SYSTEM:" / "---END---" / control sequences would bleed
// into the prompt and could override the patient-safety guardrails.
//
// This regression guard scans the snapshot-builder source files and
// fails when a recognised free-text field name is assigned a value that
// doesn't include `sanitizeForPrompt`. Cheap, deterministic, no false
// positives on numeric / boolean / date assignments (those don't trip
// the heuristic because the field-name allow-list is the only trigger).
//
// Adding a new free-text field name to the heuristic is a one-row edit.
//
// v1.30.25 — the file list is DERIVED from the import graph, not hardcoded.
// The hardcoded list had rotted into uselessness: of its four entries, three
// (`blood-pressure-status`, `medication-compliance-status`, `glp1-plateau`)
// were no longer reachable from `snapshot.ts` at all, and the one that was
// covered a single file out of the dozen that actually emit free text. That is
// why an un-sanitised lab analyte name reached the prompt for several releases
// without this guard noticing — `labs-snapshot.ts` was never on the list, and
// no one had reason to add it.
//
// A list nobody updates is worse than no list, because it reads as coverage.
// So walk the real graph: start at `snapshot.ts`, follow every internal import
// transitively, and keep the files under the Coach / insights trees. A new
// snapshot block is covered the moment it is imported.
// ────────────────────────────────────────────────────────────────────

/** Resolve a `@/…` or relative import specifier onto a repo-relative .ts path. */
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = `src/${spec.slice(2)}`;
  } else if (spec.startsWith(".")) {
    const dir = dirname(fromFile);
    base = normalize(join(dir, spec));
  } else {
    // A bare package specifier — not our source.
    return null;
  }
  for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
    if (
      candidate.endsWith(".ts") &&
      existsSync(resolve(process.cwd(), candidate))
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Every internal source file reachable from `snapshot.ts`, bounded to the
 * Coach + insights trees (the snapshot-builder surface). Generated Prisma
 * types and node_modules are excluded by construction — neither resolves to a
 * `src/lib/{ai/coach,insights}` path.
 */
function snapshotBuilderFiles(): string[] {
  const ENTRY = "src/lib/ai/coach/snapshot.ts";
  const IMPORT_RE =
    /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
  const seen = new Set<string>();
  const queue = [ENTRY];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(resolve(process.cwd(), file), "utf-8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const target = resolveImport(file, match[1]);
      if (!target) continue;
      // `@/generated/**` is the Prisma client — never open it, and it carries
      // no prompt text.
      if (target.startsWith("src/generated/")) continue;
      if (!seen.has(target)) queue.push(target);
    }
  }

  return [...seen]
    .filter(
      (f) =>
        f.startsWith("src/lib/ai/coach/") || f.startsWith("src/lib/insights/"),
    )
    .filter((f) => !f.includes("__tests__"))
    .sort();
}

const SNAPSHOT_BUILDER_FILES = snapshotBuilderFiles();

/**
 * Field names that consistently mean "free-text the user typed". This
 * list is conservative — date / count / value / unit-numeric fields
 * never appear here. Adding a new free-text name is the documented
 * extension hook.
 */
const FREE_TEXT_FIELD_NAMES = [
  "name",
  "note",
  "notes",
  "description",
  "comment",
  "drug",
  "doseUnit",
  "dose",
] as const;

/**
 * Walk the file looking for `name: <expr>` style property assignments
 * where the key matches a free-text field. For each hit, capture the
 * full single-line `name: …,` or up to the next comma at the same
 * brace-depth. Any hit must contain the literal token `sanitizeForPrompt`
 * somewhere in its value expression — OR the file must demonstrably
 * import + use `sanitizeForPrompt` for the same source identifier
 * elsewhere (the GLP-1-plateau context case: production builds a raw
 * struct, the consumer prompt-builder wraps).
 *
 * Pragmatically: a new snapshot builder that forgets to import the
 * sanitiser fails immediately. An existing file that derives an
 * intermediate context and sanitises at consumption stays green —
 * because the audit-row contract (v1.4.43 W13 L-2) is about preventing
 * an un-sanitised field from reaching the prompt, and a file-level
 * sanitisation pattern provably catches that.
 */
function findUnsanitisedFreeTextAssignments(
  filePath: string,
): { fieldName: string; line: number; snippet: string }[] {
  const source = readFileSync(resolve(process.cwd(), filePath), "utf-8");
  const lines = source.split("\n");
  const violations: { fieldName: string; line: number; snippet: string }[] = [];

  // File-level escape hatch: any file that imports + uses
  // `sanitizeForPrompt` for the free-text fields is considered safe.
  // The check only fires on a NEW file (added without the import) or
  // on a file that uses sanitise nowhere — both meaningful regression
  // signals.
  const fileSanitisesSomewhere = /sanitizeForPrompt\s*\(/.test(source);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const field of FREE_TEXT_FIELD_NAMES) {
      // Match `<field>:` as a property key. Anchored after `{` / `(`
      // / `,` / start-of-line whitespace so we don't trip on words
      // inside string literals or identifiers.
      const re = new RegExp(`(?:^|[\\s,{(])${field}\\s*:`);
      if (!re.test(line)) continue;
      // The value can extend to the next comma at the same depth or
      // to the next line. Capture the trailing portion of the current
      // line plus up to two lookahead lines as the "value expression".
      const valueExpr = [line, lines[i + 1] ?? "", lines[i + 2] ?? ""].join(
        "\n",
      );
      // Numeric / boolean / null / undefined assignments don't need
      // sanitisation. They originate inside the server (counts,
      // slopes, ids) or are already-bounded enum strings.
      const numericOrBoolean =
        /:\s*(?:-?\d|true\b|false\b|null\b|undefined\b)/.test(line);
      if (numericOrBoolean) continue;
      // String literals / template literals built entirely from
      // server-controlled tokens are accepted; the heuristic only
      // demands `sanitizeForPrompt` when the value reads from a
      // user-controlled identifier (Identifier or Member-Expression
      // ending in `name|note|description|doseUnit|drug|dose`).
      const referencesFreeTextSource = new RegExp(
        `\\.(${FREE_TEXT_FIELD_NAMES.join("|")})\\b`,
      ).test(valueExpr);
      if (!referencesFreeTextSource) continue;
      if (valueExpr.includes("sanitizeForPrompt")) continue;
      // File-level pass: the file calls sanitizeForPrompt at least
      // once, so the free-text value is wrapped at the consumer.
      if (fileSanitisesSomewhere) continue;
      violations.push({
        fieldName: field,
        line: i + 1,
        snippet: line.trim(),
      });
    }
  }
  return violations;
}

describe("Coach snapshot — free-text fields wrap through sanitizeForPrompt (L-2)", () => {
  for (const filePath of SNAPSHOT_BUILDER_FILES) {
    it(`${filePath} — every free-text assignment routes through sanitizeForPrompt`, () => {
      const violations = findUnsanitisedFreeTextAssignments(filePath);
      if (violations.length > 0) {
        const formatted = violations
          .map(
            (v) => `  ${filePath}:${v.line} — \`${v.fieldName}\`: ${v.snippet}`,
          )
          .join("\n");
        throw new Error(
          `Snapshot builder leaks an un-sanitised free-text field into the Coach prompt:\n${formatted}\n` +
            `Wrap the value via \`sanitizeForPrompt(value, maxLen)\` from \`@/lib/insights/sanitize\`.`,
        );
      }
      expect(violations).toEqual([]);
    });
  }

  // A DERIVED list can fail open in a way a hardcoded one cannot: if the
  // import resolver ever stops matching (a path-alias change, a move to
  // `import type`, a bundler rewrite), it silently yields [] and every
  // assertion above vanishes with the suite still green. Pin the floor.
  it("the derived file list actually resolves the snapshot graph", () => {
    expect(SNAPSHOT_BUILDER_FILES.length).toBeGreaterThan(20);
    // Named anchors: the blocks that carry user-controlled or
    // document-sourced free text. If any of these drops out of the graph,
    // the guard has stopped covering the surface it exists to cover.
    for (const required of [
      "src/lib/ai/coach/labs-snapshot.ts",
      "src/lib/ai/coach/illness-snapshot.ts",
      "src/lib/ai/coach/glp1-snapshot.ts",
      "src/lib/ai/coach/memory-snapshot.ts",
      "src/lib/ai/coach/plans.ts",
      "src/lib/ai/coach/facts.ts",
      "src/lib/insights/features.ts",
      "src/lib/insights/derived/adherence-storyline.ts",
    ]) {
      expect(SNAPSHOT_BUILDER_FILES).toContain(required);
    }
  });

  it("the guard itself trips on an obvious leak (sanity check)", () => {
    // Sanity check — the heuristic must flag a synthetic snapshot
    // builder that reads from a user-controlled identifier without the
    // wrap AND has no sanitiser anywhere in the file. This is the
    // "new builder forgot the import" failure mode.
    const synthetic = `
      // synthetic snapshot builder — no sanitiser imported anywhere.
      export function buildBlock(med) {
        return {
          name: med.name,
          dose: med.dose,
        };
      }
    `;
    const lines = synthetic.split("\n");
    const fileSanitisesSomewhere = /sanitizeForPrompt\s*\(/.test(synthetic);
    let hit = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const valueExpr = [line, lines[i + 1] ?? "", lines[i + 2] ?? ""].join(
        "\n",
      );
      if (
        /(?:^|[\s,{(])name\s*:/.test(line) &&
        /\.name\b/.test(valueExpr) &&
        !valueExpr.includes("sanitizeForPrompt") &&
        !fileSanitisesSomewhere
      ) {
        hit = true;
      }
    }
    expect(hit).toBe(true);
  });
});

// v1.18.6 (W7) — the citation-aware reference-range grounding rides through
// buildCoachSnapshot for the metrics present, gated on the W6 diabetes opt-in.
describe("buildCoachSnapshot — reference grounding (W7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCoachSnapshotCacheForTests();
    prismaMock.measurement.findMany.mockResolvedValue([]);
    prismaMock.moodEntry.findMany.mockResolvedValue([]);
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
    prismaMock.medication.findMany.mockResolvedValue([]);
    prismaMock.user.findUnique.mockResolvedValue({ coachPrefsJson: null });
    resolveModuleMapMock.mockResolvedValue(allModulesEnabled());
    featuresMock.mockResolvedValue({});
  });

  it("attaches an ESH-2023-cited grounding block when blood pressure is present", async () => {
    featuresMock.mockResolvedValue({
      bloodPressure: { avgSys30: 138, avgDia30: 85, coverage: { count: 4 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(2, 138, "BLOOD_PRESSURE_SYS"),
      daysAgo(2, 85, "BLOOD_PRESSURE_DIA"),
    ]);

    const out = await buildCoachSnapshot("user-1", { sources: ["bp"] });
    expect(out.referenceGrounding).not.toBeNull();
    expect(out.referenceGrounding).toContain("REFERENCE GROUNDING");
    expect(out.referenceGrounding).toContain("ESH 2023");
    // 138 sits in the high-normal band (130–139), two tiers past optimal →
    // the four-state contract reads that as "outside".
    expect(out.referenceGrounding).toContain(
      "sits outside the general reference band",
    );
    expect(out.referenceGrounding).toContain("not a diagnosis");
  });

  it("returns null grounding when no present metric is covered", async () => {
    const out = await buildCoachSnapshot("user-1");
    // Empty snapshot — no reference-covered scalar collected.
    expect(out.referenceGrounding).toBeNull();
  });

  it("uses the general non-diabetic glucose band when hasDiabetes is unset", async () => {
    featuresMock.mockResolvedValue({});
    prismaMock.measurement.findMany.mockResolvedValue([
      { ...daysAgo(2, 95, "BLOOD_GLUCOSE"), glucoseContext: "FASTING" },
    ]);
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: null,
      hasDiabetes: false,
    });

    const out = await buildCoachSnapshot("user-1", { sources: ["glucose"] });
    expect(out.referenceGrounding).toContain("general non-diabetic normal");
    expect(out.referenceGrounding).not.toContain("management goal");
  });

  it("uses the tighter ADA goal band when hasDiabetes is opted in", async () => {
    featuresMock.mockResolvedValue({});
    prismaMock.measurement.findMany.mockResolvedValue([
      { ...daysAgo(2, 150, "BLOOD_GLUCOSE"), glucoseContext: "FASTING" },
    ]);
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: null,
      hasDiabetes: true,
    });

    const out = await buildCoachSnapshot("user-1", { sources: ["glucose"] });
    expect(out.referenceGrounding).toContain("80–130 mg/dL");
    expect(out.referenceGrounding).toContain("management goal");
    // 150 fasting is outside the diabetic goal band.
    expect(out.referenceGrounding).toContain(
      "outside the typical diabetes management goal",
    );
  });

  it("never emits a commercial brand token in the grounding block", async () => {
    featuresMock.mockResolvedValue({
      bloodPressure: { avgSys30: 120, coverage: { count: 4 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(2, 120, "BLOOD_PRESSURE_SYS"),
      daysAgo(2, 78, "BLOOD_PRESSURE_DIA"),
    ]);
    const out = await buildCoachSnapshot("user-1", { sources: ["bp"] });
    for (const brand of ["Mounjaro", "Withings", "WHOOP", "Oura", "Dexcom"]) {
      expect(out.referenceGrounding!.toLowerCase()).not.toContain(
        brand.toLowerCase(),
      );
    }
  });
});

describe("buildCoachSnapshot request-scoped read sharing (H-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCoachSnapshotCacheForTests();
    prismaMock.measurement.findMany.mockResolvedValue([]);
    prismaMock.moodEntry.findMany.mockResolvedValue([]);
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
    prismaMock.medication.findMany.mockResolvedValue([]);
    prismaMock.user.findUnique.mockResolvedValue({ coachPrefsJson: null });
    resolveModuleMapMock.mockResolvedValue(allModulesEnabled());
    featuresMock.mockResolvedValue({
      bloodPressure: undefined,
      weight: undefined,
      pulse: undefined,
      mood: undefined,
    });
  });

  it("runs extractFeatures + the prefs read once across distinct-scope tool builds in one request", async () => {
    // The F1 coach tools each call buildCoachSnapshot with a DIFFERENT
    // single-source scope, so the 60s snapshot LRU (keyed on the source list)
    // does NOT share their reads. Memoising the two heavy per-user reads on the
    // request-scoped WideEventBuilder cache collapses the fan-out to one of each.
    await eventStorage.run(new WideEventBuilder(), async () => {
      // Same window (→ same windowDays key), distinct sources (→ distinct LRU
      // keys ⇒ two separate snapshot builds, mirroring the real tool fan-out).
      await Promise.all([
        buildCoachSnapshot("user-h1", {
          sources: ["bp"],
          window: "last30days",
        }),
        buildCoachSnapshot("user-h1", {
          sources: ["pulse"],
          window: "last30days",
        }),
      ]);
    });

    expect(featuresMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("keeps separate caches per request (no cross-request leakage)", async () => {
    // Distinct users so the in-process 60s snapshot LRU (keyed on userId) cannot
    // short-circuit the second request — the only thing under test here is that
    // the request-scoped feature/prefs cache does NOT survive across requests.
    await eventStorage.run(new WideEventBuilder(), async () => {
      await buildCoachSnapshot("user-h1a", {
        sources: ["bp"],
        window: "last30days",
      });
    });
    await eventStorage.run(new WideEventBuilder(), async () => {
      await buildCoachSnapshot("user-h1b", {
        sources: ["bp"],
        window: "last30days",
      });
    });

    expect(featuresMock).toHaveBeenCalledTimes(2);
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(2);
  });
});
