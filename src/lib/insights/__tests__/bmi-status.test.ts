import { describe, expect, it, vi, beforeEach } from "vitest";

// The graded series folds per-day aggregates in SQL; the fake folds the
// mocked `measurement.findMany` rows with the same rules.
// The input gate's stamp read answers from the mocked grouped count.
vi.mock("@/lib/insights/measurement-input-stamps", async () => ({
  readMeasurementInputStamps: (await import("./fake-input-stamps"))
    .stampsFromMockedGroupBy,
}));

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
    // v1.18.11 — the input gate probes salient inputs via groupBy.
    measurement: { findMany: vi.fn(), groupBy: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    // Weekly / monthly / yearly buckets are folded from the DAY tier in SQL.
    $queryRaw: vi.fn(),
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
import { generateBmiStatusForUser } from "../bmi-status";
import { noteRow, upsertedNotes, writtenNotes } from "./status-note-fixtures";

const dayMs = 24 * 60 * 60 * 1000;

/** A `runStatusCompletion` stub returning fixed content, capturing the prompt. */
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
  // Cold rollup tier: the BMI graded series scales the WEIGHT tier, which
  // folds from the full-history `measurement.findMany` fallback on a miss.
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  // v1.18.11 — input-gate probe default: empty groups so the fingerprint
  // is computed but, with no cached `inputHash`, the gate misses and fixtures
  // build normally. The forced fixtures skip the gate entirely.
  vi.mocked(prisma.measurement.groupBy).mockResolvedValue([] as never);
});

describe("generateBmiStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} BMI series, not the full daily array", async () => {
    const now = new Date();
    const records: Array<{ value: number; measuredAt: Date }> = [];
    for (let day = 0; day < 1000; day++) {
      records.push({
        value: 80 + (day % 5),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 175,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generateBmiStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const bmi = snapshot.bmi.series;
    expect(bmi).toHaveProperty("recent");
    expect(bmi).toHaveProperty("weekly");
    expect(bmi).toHaveProperty("monthly");
    expect(bmi).toHaveProperty("yearly");
    expect(bmi.recent.length).toBeLessThanOrEqual(21);
    expect(bmi.recent[0]).toHaveProperty("date");
    expect(bmi.recent[0]).toHaveProperty("mean");
    expect(bmi.monthly[0]).toHaveProperty("month");
    const total =
      bmi.recent.length +
      bmi.weekly.length +
      bmi.monthly.length +
      bmi.yearly.length;
    expect(total).toBeLessThanOrEqual(50);
  });
});

describe("generateBmiStatusForUser — per-user tz (QA F5)", () => {
  it("rolls the cache over at the USER's own midnight, not Berlin's", async () => {
    // A moment that is already "tomorrow" in Berlin (UTC+2 summer) but still
    // "today" in Los Angeles (UTC-7 summer) — the two zones disagree on the
    // calendar day. Before the fix every card's cache day-key was Berlin-
    // pinned regardless of the user's stored zone.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T23:30:00.000Z")); // Berlin: 06-21 01:30
    const laToday = "2026-06-20"; // Los Angeles: 06-20 16:30
    try {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        heightCm: 175,
        timezone: "America/Los_Angeles",
      } as never);
      // A cached row keyed to the LA calendar day should be served as a
      // fresh hit even though it is already "tomorrow" in Berlin.
      vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
        noteRow({
          dateKey: laToday,
          text: "LA-anchored cached BMI text.",
          generatedAt: new Date(),
        }) as never,
      );

      const result = await generateBmiStatusForUser("user-la", {
        locale: "en",
      });

      // If the day-key were still Berlin-pinned, this LA-dated row would
      // MISS (today in Berlin is 06-21) and a real generation would run
      // instead, serving the deterministic/no-key fallback rather than
      // this cached text.
      expect(result.cached).toBe(true);
      expect(result.text).toBe("LA-anchored cached BMI text.");
      expect(runStatusCompletion).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("generateBmiStatusForUser — timeout/error never persists", () => {
  it("serves the fallback without writing a cache row on timeout", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 175,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 80, measuredAt: new Date() },
    ] as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generateBmiStatusForUser("user-1", { locale: "en" });

    // The user-facing payload reads the deterministic fallback, but
    // NOTHING is persisted — so the next mount re-attempts a real
    // generation instead of sticking the fallback for the day.
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

  it("serves the fallback without writing a cache row on provider error", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 175,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 80, measuredAt: new Date() },
    ] as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "error",
    } as never);

    const result = await generateBmiStatusForUser("user-1", { locale: "en" });
    expect(result.text).toBeTruthy();
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

describe("generateBmiStatusForUser — a negative window is not a note", () => {
  it("regenerates when today's row carries only a negative-cache window", async () => {
    const now = new Date();
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(now);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 175,
    } as never);
    // The most recent cached row is a stub keyed to today.
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
      { value: 80, measuredAt: now },
    ] as never);

    stubCompletion('{"summary":"Fresh real assessment."}');

    const result = await generateBmiStatusForUser("user-1", { locale: "en" });

    // The stub must NOT be served — a fresh generation runs instead.
    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh real assessment.");
    expect(result.cached).toBe(false);
  });
});

describe("generateBmiStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: 175,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { value: 80, measuredAt: new Date() },
    ] as never);

    stubCompletion(
      '{"summary":"BMI sits in the green band. metric:WEIGHT and steady."}',
    );

    const result = await generateBmiStatusForUser("user-1", { locale: "en" });

    expect(result.text).toBeTruthy();
    expect(result.text).not.toContain("metric:");
    const notes = writtenNotes(prisma.insightStatusCache.upsert);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].text).not.toContain("metric:");
  });
});
