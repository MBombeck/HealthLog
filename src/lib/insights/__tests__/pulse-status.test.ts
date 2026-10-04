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
    // v1.28.25 — the graded-series cold-tier fallback day-buckets dense
    // types (PULSE) via a raw aggregate instead of a full findMany walk.
    $queryRaw: vi.fn(async () => []),
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

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { generatePulseStatusForUser } from "../pulse-status";
import { noteRow, writtenNotes } from "./status-note-fixtures";

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
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  // Cold rollup tier: the pulse graded series folds monthly/yearly from
  // the full-history `measurement.findMany` fallback on a tier miss.
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
});

describe("generatePulseStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} pulse series, not the full daily array", async () => {
    const now = new Date();
    const records: Array<{ value: number; measuredAt: Date }> = [];
    for (let day = 0; day < 1000; day++) {
      records.push({
        value: 70 + (day % 8),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    // v1.28.25 — PULSE is a dense type, so the cold-tier fallback reads
    // a SQL day-bucket aggregate instead of the raw findMany walk. Feed
    // the same 1000 days as day buckets.
    // The rollup tier is empty (the coarse fold over it returns nothing),
    // so the monthly / yearly slices come from that fallback.
    const dayBuckets = records
      .map((r) => ({ bucket_start: r.measuredAt, mean: r.value }))
      .reverse();
    vi.mocked(prisma.$queryRaw).mockImplementation(((
      strings: TemplateStringsArray,
    ) =>
      Promise.resolve(
        strings.join("").includes("measurement_rollups") ? [] : dayBuckets,
      )) as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generatePulseStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const pulse = snapshot.pulse.series;
    expect(pulse).toHaveProperty("recent");
    expect(pulse).toHaveProperty("weekly");
    expect(pulse).toHaveProperty("monthly");
    expect(pulse).toHaveProperty("yearly");
    expect(pulse.recent.length).toBeLessThanOrEqual(21);
    expect(pulse.recent[0]).toHaveProperty("date");
    expect(pulse.recent[0]).toHaveProperty("mean");
    expect(pulse.monthly[0]).toHaveProperty("month");
    const total =
      pulse.recent.length +
      pulse.weekly.length +
      pulse.monthly.length +
      pulse.yearly.length;
    expect(total).toBeLessThanOrEqual(50);
  });
});

describe("generatePulseStatusForUser — A2 resting-target in-target %", () => {
  it("scores RESTING_HEART_RATE against the resting band, ignoring workout PULSE", async () => {
    const now = new Date();
    // PULSE polluted with a heavy workout burst (would tank the in-target
    // % if scored against the resting band).
    const pulseRecords: Array<{ value: number; measuredAt: Date }> = [];
    for (let i = 0; i < 500; i++) {
      pulseRecords.push({
        value: 150,
        measuredAt: new Date(now.getTime() - (i % 30) * dayMs),
      });
    }
    // Clean resting series, comfortably inside a 60-100 band, covering the
    // SAME 30-day span as the PULSE above. The span has to match for the
    // fixture to mean what the test name claims: the resolver merges per
    // day, so a day with no resting row of its own is estimated from that
    // day's PULSE rather than dropped. Leaving ten of the thirty days
    // resting-free made this assert the merge's gap-fill behaviour by
    // accident — on days whose only readings are a 150 bpm workout, the
    // honest estimate IS out of band. Gap-day behaviour is pinned directly
    // in `resting-pulse.test.ts`; this case is about preferring the clean
    // signal over workout HR where both exist.
    const restingRecords: Array<{ value: number; measuredAt: Date }> = [];
    for (let d = 0; d < 30; d++) {
      restingRecords.push({
        value: 72,
        measuredAt: new Date(now.getTime() - d * dayMs),
      });
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    // pulse-status reads PULSE first, then RESTING_HEART_RATE.
    vi.mocked(prisma.measurement.findMany)
      .mockResolvedValueOnce(pulseRecords as never)
      .mockResolvedValueOnce(restingRecords as never)
      .mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generatePulseStatusForUser("user-resting", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);
    // Resting 72 sits inside the 60-100 band → 100 % in target, NOT the
    // ~0 % the workout-polluted PULSE stream would have produced.
    expect(snapshot.pulse.target.inTargetPctLast30DailyPoints).toBe(100);
  });

  it("falls back to a low-percentile PULSE proxy when no resting rows exist", async () => {
    const now = new Date();
    // Each day: mostly resting reads ~72 + a workout burst ~150. The
    // proxy's low percentile should keep most days in-band.
    const pulseRecords: Array<{ value: number; measuredAt: Date }> = [];
    for (let d = 0; d < 10; d++) {
      const dayStart = new Date(now.getTime() - d * dayMs);
      for (let i = 0; i < 20; i++) {
        pulseRecords.push({
          value: 70 + (i % 10),
          measuredAt: new Date(dayStart.getTime() - i * 60_000),
        });
      }
      for (let i = 0; i < 5; i++) {
        pulseRecords.push({
          value: 150,
          measuredAt: new Date(dayStart.getTime() - (i + 30) * 60_000),
        });
      }
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.measurement.findMany)
      .mockResolvedValueOnce(pulseRecords as never)
      .mockResolvedValueOnce([] as never); // no RESTING_HEART_RATE
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generatePulseStatusForUser("user-proxy", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);
    // The proxy excludes the workout burst → the resting estimate stays
    // in the healthy band, so the in-target % is high, not tanked to ~0.
    expect(
      snapshot.pulse.target.inTargetPctLast30DailyPoints,
    ).toBeGreaterThanOrEqual(80);
  });
});

describe("generatePulseStatusForUser — per-user tz (QA F5)", () => {
  it("rolls the cache over at the USER's own midnight, not Berlin's", async () => {
    // A moment that is already "tomorrow" in Berlin (UTC+2 summer) but still
    // "today" in New York (UTC-4 summer). Before the fix, `todayKey` was
    // computed from `toBerlinDayKey(new Date())` BEFORE the user's profile
    // (and its timezone) was even read.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T23:30:00.000Z")); // Berlin: 06-21 01:30
    const nyToday = "2026-06-20"; // New York: 06-20 19:30
    try {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        dateOfBirth: null,
        gender: null,
        timezone: "America/New_York",
      } as never);
      vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
        noteRow({
          dateKey: nyToday,
          text: "NY-anchored cached pulse text.",
          generatedAt: new Date(),
        }) as never,
      );

      const result = await generatePulseStatusForUser("user-ny", {
        locale: "en",
      });

      // If the day-key were still Berlin-pinned, this NY-dated row would
      // MISS (today in Berlin is 06-21) and a real generation would run.
      expect(result.cached).toBe(true);
      expect(result.text).toBe("NY-anchored cached pulse text.");
      expect(runStatusCompletion).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("generatePulseStatusForUser — a negative window is not a note", () => {
  it("regenerates when today's row carries only a negative-cache window", async () => {
    const now = new Date();
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(now);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
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
      { value: 72, measuredAt: now },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    stubCompletion('{"summary":"Fresh pulse assessment."}');

    const result = await generatePulseStatusForUser("user-1", { locale: "en" });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh pulse assessment.");
    expect(result.cached).toBe(false);
  });
});

describe("generatePulseStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 72, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    stubCompletion(
      '{"summary":"Your pulse is stable. metric:PULSE The 7-day average sits inside the band."}',
    );

    const result = await generatePulseStatusForUser("user-1", { locale: "en" });

    expect(result.text).toBeTruthy();
    expect(result.text).not.toContain("metric:");
    const notes = writtenNotes(prisma.insightStatusCache.upsert);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].text).not.toContain("metric:");
    expect(notes[0].text).toContain("Your pulse is stable.");
  });
});

describe("generatePulseStatusForUser — a pulse day is the mean of its hours", () => {
  it("gives the latest day and the summary the hours' and days' means", async () => {
    // Yesterday: a workout hour of twelve readings at 150 and three resting
    // hours at 60 (day value 82.5). The day before: one reading at 60. The
    // plain mean of yesterday's fifteen readings would be 132.
    const now = new Date();
    const midnight = (daysAgo: number) =>
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      daysAgo * dayMs;
    const records: Array<{ value: number; measuredAt: Date }> = [];
    for (let i = 0; i < 12; i++) {
      records.push({
        value: 150,
        measuredAt: new Date(midnight(1) + 10 * 3_600_000 + i * 300_000),
      });
    }
    for (const h of [12, 14, 16]) {
      records.push({
        value: 60,
        measuredAt: new Date(midnight(1) + h * 3_600_000),
      });
    }
    records.push({
      value: 60,
      measuredAt: new Date(midnight(2) + 8 * 3_600_000),
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      gender: null,
      timezone: "UTC",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockImplementation(((args: {
      where: { type: string };
    }) =>
      Promise.resolve(
        args.where.type === "PULSE" ? [...records].reverse() : [],
      )) as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generatePulseStatusForUser("user-pulse-hours", { locale: "en" });

    const snapshot = JSON.parse(captured.userPrompt!.match(/\{[\s\S]*\}/)![0]);
    expect(snapshot.pulse.latestDayFocus.value).toBe(82.5);
    expect(snapshot.pulse.summary.mean).toBe(71.25);
  });
});
