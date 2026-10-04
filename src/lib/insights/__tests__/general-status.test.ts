import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    insightStatusCache: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    measurement: { findMany: vi.fn() },
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

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { generateGeneralStatusForUser } from "../general-status";
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
});

describe("generateGeneralStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} per-metric series, not the full daily array", async () => {
    const now = new Date();

    const weightRecords: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      weightRecords.push({
        type: "WEIGHT",
        value: 80 + (day % 5),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(
      weightRecords as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generateGeneralStatusForUser("user-1", { locale: "en" });

    expect(captured.userPrompt).not.toBeNull();
    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    expect(match).not.toBeNull();
    const snapshot = JSON.parse(match![0]);

    const weight = snapshot.measurementSeries.WEIGHT.series;
    expect(weight).toHaveProperty("recent");
    expect(weight).toHaveProperty("weekly");
    expect(weight).toHaveProperty("monthly");
    expect(weight).toHaveProperty("yearly");
    expect(weight.recent.length).toBeLessThanOrEqual(21);
    expect(weight.recent[0]).toHaveProperty("date");
    expect(weight.recent[0]).toHaveProperty("mean");
    expect(weight.monthly[0]).toHaveProperty("month");
    const total =
      weight.recent.length +
      weight.weekly.length +
      weight.monthly.length +
      weight.yearly.length;
    expect(total).toBeLessThanOrEqual(50);
  });

  it("omits measurement types with no data", async () => {
    const now = new Date();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 80, measuredAt: now },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generateGeneralStatusForUser("user-1", { locale: "en" });
    const snapshot = JSON.parse(captured.userPrompt!.match(/\{[\s\S]*\}/)![0]);

    // Only WEIGHT has data — no empty PULSE/BP/etc. series objects.
    expect(Object.keys(snapshot.measurementSeries)).toEqual(["WEIGHT"]);
  });
});

describe("generateGeneralStatusForUser — timeout/error never persists", () => {
  it("serves the fallback without writing a cache row on timeout", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generateGeneralStatusForUser("user-1", {
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

describe("generateGeneralStatusForUser — a negative window is not a note", () => {
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
      { type: "WEIGHT", value: 82, measuredAt: now },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    stubCompletion('{"summary":"Fresh general assessment."}');

    const result = await generateGeneralStatusForUser("user-1", {
      locale: "en",
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh general assessment.");
    expect(result.cached).toBe(false);
  });
});

describe("generateGeneralStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    stubCompletion(
      '{"summary":"Weight trended down. metric:WEIGHT BP stable. metric:BLOOD_PRESSURE_SYS"}',
    );

    const result = await generateGeneralStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.text).toBeTruthy();
    expect(result.text).not.toContain("metric:");
    const notes = writtenNotes(prisma.insightStatusCache.upsert);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].text).not.toContain("metric:");
  });
});

describe("generateGeneralStatusForUser — a pulse day is the mean of its hours", () => {
  it("folds pulse days and buckets by hours and days, other types unchanged", async () => {
    // Yesterday: a workout hour of twelve readings at 150 and three resting
    // hours at 60 (day value 82.5); the day before one reading at 60. The
    // plain mean of yesterday's fifteen readings would be 132.
    const now = new Date();
    const midnight = (daysAgo: number) =>
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      daysAgo * dayMs;
    const at = (daysAgo: number, h: number, m = 0) =>
      new Date(midnight(daysAgo) + h * 3_600_000 + m * 60_000);
    const rows: Array<{ type: string; value: number; measuredAt: Date }> = [];
    for (const type of ["PULSE", "WEIGHT"]) {
      for (let i = 0; i < 12; i++) {
        rows.push({ type, value: 150, measuredAt: at(1, 10, i * 5) });
      }
      for (const h of [12, 14, 16]) {
        rows.push({ type, value: 60, measuredAt: at(1, h) });
      }
      rows.push({ type, value: 60, measuredAt: at(2, 8) });
    }
    rows.sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime());
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dateOfBirth: null,
      timezone: "UTC",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(rows as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generateGeneralStatusForUser("user-pulse-hours", { locale: "en" });

    const snapshot = JSON.parse(captured.userPrompt!.match(/\{[\s\S]*\}/)![0]);
    const pulse = snapshot.measurementSeries.PULSE;
    expect(pulse.summary.mean).toBe(71.25);
    expect(pulse.series.recent.map((d: { mean: number }) => d.mean)).toEqual([
      60, 82.5,
    ]);
    const weight = snapshot.measurementSeries.WEIGHT;
    expect(weight.series.recent.map((d: { mean: number }) => d.mean)).toEqual([
      60, 132,
    ]);
  });
});
