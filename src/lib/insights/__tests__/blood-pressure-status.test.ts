import { describe, expect, it, vi, beforeEach } from "vitest";

// The graded series folds per-day aggregates in SQL; the fake folds the
// mocked `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    insightStatusCache: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    // Weekly / monthly / yearly buckets are folded from the DAY tier in SQL.
    $queryRaw: vi.fn(),
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

vi.mock(
  "@/lib/ai/coach/bytes-codec",
  async () => (await import("./status-note-fixtures")).fakeBytesCodec,
);

// statusText is available in these fixtures — the capability read has its
// own tests in status-cache.test.ts.
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
  aiCapabilityToServe: async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
}));

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/medication-category", () => ({
  getMedicationCategories: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { getMedicationCategories } from "@/lib/medication-category";
import { generateBloodPressureStatusForUser } from "../blood-pressure-status";
import { noteRow, upsertedNotes, writtenNotes } from "./status-note-fixtures";

const dayMs = 24 * 60 * 60 * 1000;

function stubCompletion(
  content: string,
  capture?: { userPrompt: string | null },
) {
  vi.mocked(runStatusCompletion).mockImplementation(
    async (args: { userPrompt: string }) => {
      if (capture) capture.userPrompt = args.userPrompt;
      return {
        kind: "ok",
        content,
        providerType: "anthropic",
        model: "x",
        tokensUsed: 1,
      } as never;
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.insightStatusCache.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.insightStatusCache.updateMany).mockResolvedValue(
    {} as never,
  );
  vi.mocked(getMedicationCategories).mockResolvedValue({});
  // Cold rollup tier: the BP channels fold monthly/yearly from the
  // full-history `measurement.findMany` fallback on a tier miss.
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
});

/** The record row and the readings one generation reads, nothing else on file. */
function seed(
  records: Array<{ type: string; value: number; measuredAt: Date }>,
  user: Record<string, unknown> = { dateOfBirth: null },
) {
  vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
}

/** The snapshot the model was handed, parsed out of the user prompt. */
async function snapshotFor() {
  const captured: { userPrompt: string | null } = { userPrompt: null };
  stubCompletion('{"summary":"OK"}', captured);
  await generateBloodPressureStatusForUser("user-1", { locale: "en" });
  return JSON.parse(captured.userPrompt!.match(/\{[\s\S]*\}/)![0]);
}

describe("generateBloodPressureStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} per-metric series, not the full daily array", async () => {
    const now = new Date();

    const records: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      records.push({
        type: "BLOOD_PRESSURE_SYS",
        value: 120 + (day % 10),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
      records.push({
        type: "BLOOD_PRESSURE_DIA",
        value: 80 + (day % 5),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    seed(records);
    const snapshot = await snapshotFor();

    const sys = snapshot.bloodPressure.systolic.series;
    expect(sys).toHaveProperty("recent");
    expect(sys).toHaveProperty("weekly");
    expect(sys).toHaveProperty("monthly");
    // v1.18.10 — the per-channel SIGNAL block (the finished
    // recent-vs-baseline comparison) now rides the snapshot so the model
    // states the trend rather than re-deriving it.
    expect(snapshot.bloodPressure.systolic.signal).toHaveProperty("current");
    expect(snapshot.bloodPressure.systolic.signal).toHaveProperty(
      "outsideNormalSwing",
    );
    // `yearly` is the lowest-signal slice and the FIRST the budget degrader
    // sheds; on this deliberately-large 1000-day fixture it may be dropped to
    // make room. The recent/weekly/monthly core + the signal block stay.
    expect(sys.recent.length).toBeLessThanOrEqual(21);
    expect(sys.recent[0]).toHaveProperty("date");
    expect(sys.recent[0]).toHaveProperty("mean");
    expect(sys.monthly[0]).toHaveProperty("month");

    const dia = snapshot.bloodPressure.diastolic.series;
    expect(dia).toHaveProperty("recent");
    expect(dia).toHaveProperty("monthly");
    expect(dia.recent.length).toBeLessThanOrEqual(21);

    // Embedded correlation pair arrays are capped, not full-length.
    expect(snapshot.weightVsSystolic.pairs.length).toBeLessThanOrEqual(30);
  });
});

describe("generateBloodPressureStatusForUser — timeout/error never persists", () => {
  it("serves the fallback without writing a cache row on timeout", async () => {
    seed([
      { type: "BLOOD_PRESSURE_SYS", value: 132, measuredAt: new Date() },
      { type: "BLOOD_PRESSURE_DIA", value: 84, measuredAt: new Date() },
    ]);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generateBloodPressureStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.text).toBeTruthy();
    expect(result.cached).toBe(true);
    expect(result.updatedAt).toBeNull();
    // v1.8.3 — no real assessment persisted (updatedAt stays null above),
    // but a short-TTL negative window IS opened so the read-only route does
    // not re-enqueue on every navigation while the provider is degraded.
    // The window carries no note, so it can never be served as one.
    await Promise.resolve();
    expect(writtenNotes(prisma.insightStatusCache.upsert)).toEqual([]);
    const windows = upsertedNotes(prisma.insightStatusCache.upsert);
    expect(windows).toHaveLength(1);
    expect(windows[0].retryAt).toBeInstanceOf(Date);
    expect(prisma.insightStatusCache.updateMany).not.toHaveBeenCalled();
  });
});

describe("generateBloodPressureStatusForUser — a negative window is not a note", () => {
  it("regenerates when today's row carries only a negative-cache window", async () => {
    const now = new Date();
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(now);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        dateKey: todayKey,
        text: null,
        generatedAt: null,
        retryAt: new Date(Date.now() + 60_000),
        negativeReason: "timeout",
      }) as never,
    );
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "BLOOD_PRESSURE_SYS", value: 132, measuredAt: now },
      { type: "BLOOD_PRESSURE_DIA", value: 84, measuredAt: now },
    ] as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    stubCompletion('{"summary":"Fresh BP assessment."}');

    const result = await generateBloodPressureStatusForUser("user-1", {
      locale: "en",
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh BP assessment.");
    expect(result.cached).toBe(false);
  });
});

describe("generateBloodPressureStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "BLOOD_PRESSURE_SYS", value: 132, measuredAt: new Date() },
      { type: "BLOOD_PRESSURE_DIA", value: 84, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    stubCompletion(
      '{"summary":"Systolic averaged 132. metric:BLOOD_PRESSURE_SYS Diastolic stable. metric:BLOOD_PRESSURE_DIA"}',
    );

    const result = await generateBloodPressureStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.text).toBeTruthy();
    expect(result.text).not.toContain("metric:");
    const notes = writtenNotes(prisma.insightStatusCache.upsert);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].text).not.toContain("metric:");
  });
});

// The BP-status gate reads its medications' adherence to decide what to say
// about a reading. `calculateCompliance` answers `rate: 100, totalExpected: 0`
// for a medication with no schedule, so a blood-pressure medication saved
// without one told the model the person was perfectly adherent — the exact
// fabrication the doctor report has excluded since it was written.
describe("generateBloodPressureStatusForUser — no rate without an expectation", () => {
  const SCHEDULE = {
    id: "sch-1",
    windowStart: "07:00",
    windowEnd: "08:00",
    timesOfDay: ["07:00"],
    daysOfWeek: null,
    rrule: null,
    rollingIntervalDays: null,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    doseWindows: [],
  };

  function bpMed(id: string, name: string, schedules: unknown[]) {
    return {
      id,
      name,
      dose: "5mg",
      active: true,
      asNeeded: false,
      createdAt: new Date(Date.now() - 60 * dayMs),
      schedules,
      scheduleRevisions: [],
      pauseEras: [],
    };
  }

  it("omits a blood-pressure medication that expects no dose", async () => {
    const now = new Date();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "BLOOD_PRESSURE_SYS", value: 132, measuredAt: now },
      { type: "BLOOD_PRESSURE_DIA", value: 84, measuredAt: now },
    ] as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      bpMed("med-empty", "Unscheduled", []),
      bpMed("med-real", "Amlodipine", [SCHEDULE]),
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(getMedicationCategories).mockResolvedValue({
      "med-empty": "BLOOD_PRESSURE",
      "med-real": "BLOOD_PRESSURE",
    });

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generateBloodPressureStatusForUser("user-1", { locale: "en" });

    const snapshot = JSON.parse(captured.userPrompt!.match(/\{[\s\S]*\}/)![0]);
    const names = snapshot.bpMedications.map((m: { name: string }) => m.name);
    expect(names).not.toContain("Unscheduled");
    expect(names).toContain("Amlodipine");
  });
});

describe("generateBloodPressureStatusForUser — the person's own target", () => {
  const readings = [1, 2, 3].flatMap((daysAgo) => {
    const measuredAt = new Date(Date.now() - daysAgo * dayMs);
    return [
      { type: "BLOOD_PRESSURE_SYS", value: 135, measuredAt },
      { type: "BLOOD_PRESSURE_DIA", value: 85, measuredAt },
    ];
  });

  it("hands the model the own target and the share of days inside it", async () => {
    seed(readings, {
      heightCm: 180,
      dateOfBirth: new Date("1980-01-01"),
      gender: "MALE",
      thresholdsJson: {
        BLOOD_PRESSURE_SYS: { min: 110, max: 140 },
        BLOOD_PRESSURE_DIA: { min: 70, max: 90 },
      },
    });
    const targets = (await snapshotFor()).bloodPressure.targets;
    expect(targets.systolic).toEqual({ min: 110, max: 140 });
    expect(targets.diastolic).toEqual({ min: 70, max: 90 });
    expect(targets.inTargetPctLast30DailyPoints).toBe(100);
  });

  it("falls back to the age default without one", async () => {
    seed(readings, { dateOfBirth: new Date("1980-01-01") });
    const targets = (await snapshotFor()).bloodPressure.targets;
    expect(targets.systolic.max).toBeLessThan(135);
    expect(targets.inTargetPctLast30DailyPoints).toBe(0);
  });
});
