import { describe, expect, it, vi, beforeEach } from "vitest";

// The graded series folds per-day aggregates in SQL; the fake folds the
// mocked `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

// The per-type measurement read is raw SQL; serve it from the findMany mock.
vi.mock("@/lib/measurements/newest-per-type", async () =>
  (
    await import("@/__tests__/helpers/newest-per-type-mock")
  ).newestPerTypeMock(),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    insightStatusCache: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    // v1.18.11 — the input gate probes salient inputs via groupBy +
    // moodEntry.aggregate before the heavy findMany build.
    measurement: { findMany: vi.fn(), groupBy: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    // Weekly / monthly / yearly buckets are folded from the DAY tier in SQL.
    $queryRaw: vi.fn(),
    moodEntry: { findMany: vi.fn(), aggregate: vi.fn() },
    customMetric: { findMany: vi.fn() },
    // v1.11.1 — the rollup readers lazy-load the user's
    // `sourcePriorityJson` via `loadUserSourcePriority`. `null` here →
    // default rank ladders.
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

vi.mock(
  "@/lib/ai/coach/bytes-codec",
  async () => (await import("./status-note-fixtures")).fakeBytesCodec,
);

// statusText is available unless a test says otherwise — the capability
// read itself has its own tests in status-cache.test.ts.
const {
  aiCapabilityForRecord,
  probeProviderPresence,
  enqueueStatusGeneration,
} = vi.hoisted(() => ({
  aiCapabilityForRecord: vi.fn(),
  probeProviderPresence: vi.fn(),
  enqueueStatusGeneration: vi.fn(),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord,
  aiCapabilityToServe: aiCapabilityForRecord,
}));
vi.mock("@/lib/ai/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/provider")>()),
  probeProviderPresence,
}));
vi.mock(
  "@/lib/jobs/insight-status-generate-shared",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/jobs/insight-status-generate-shared")
    >()),
    enqueueStatusGeneration,
  }),
);

vi.mock("@/lib/insights/memory", () => ({
  getPreviousInsightContext: vi.fn().mockResolvedValue(null),
  formatPreviousContextForPrompt: vi.fn().mockReturnValue(""),
}));

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { generateWeightStatusForUser } from "../weight-status";
import { getNoKeyWeightStatusText } from "@/lib/insights/no-key-fallbacks";
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
  // Cold rollup tier: the graded builder folds monthly/yearly from the
  // full-history `measurement.findMany` fallback the test already mocks.
  vi.mocked(prisma.measurementRollup.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  // v1.11.1 — null source-priority blob → default rank ladders.
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
  // v1.18.11 — input-gate probe. Default to empty groups + zero mood so
  // the fingerprint is computed but, with no cached `inputHash`, the gate
  // misses and every fixture proceeds to its normal build. Tests that
  // exercise the gate set these explicitly.
  vi.mocked(prisma.measurement.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.moodEntry.aggregate).mockResolvedValue({
    _count: { _all: 0 },
    _max: { moodLoggedAt: null },
  } as never);
  vi.mocked(prisma.customMetric.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.insightStatusCache.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.insightStatusCache.updateMany).mockResolvedValue(
    {} as never,
  );
  aiCapabilityForRecord.mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
  probeProviderPresence.mockResolvedValue(true);
  enqueueStatusGeneration.mockResolvedValue(undefined);
});

describe("generateWeightStatusForUser — read-only miss while statusText is unavailable", () => {
  it.each([
    ["consent_required", true],
    ["no_provider", false],
  ] as const)(
    "serves the deterministic line with hasProvider from the probe (%s) and enqueues nothing",
    async (reason, present) => {
      aiCapabilityForRecord.mockResolvedValue({
        available: false,
        reason,
        onDeviceAllowed: false,
      });
      probeProviderPresence.mockResolvedValue(present);

      const result = await generateWeightStatusForUser("user-1", {
        locale: "en",
        readOnly: true,
      });

      // `hasProvider` is provider presence only: a withdrawn consent is not
      // "no provider configured".
      expect(result.hasProvider).toBe(present);
      expect(result.text).toBe(getNoKeyWeightStatusText("en"));
      expect(result.updatedAt).toBeNull();
      expect(enqueueStatusGeneration).not.toHaveBeenCalled();
      expect(runStatusCompletion).not.toHaveBeenCalled();
      expect(prisma.insightStatusCache.findUnique).not.toHaveBeenCalled();
    },
  );
});

describe("generateWeightStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} weight series, not the full daily array", async () => {
    const now = new Date();
    const records: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      records.push({
        type: "WEIGHT",
        value: 80 + (day % 5),
        measuredAt: new Date(now.getTime() - day * dayMs),
      });
    }

    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generateWeightStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const weight = snapshot.weight.series;
    expect(weight).toHaveProperty("recent");
    expect(weight).toHaveProperty("weekly");
    expect(weight).toHaveProperty("monthly");
    expect(weight).toHaveProperty("yearly");
    // No raw daily array beyond the bounded recent window.
    expect(weight.recent.length).toBeLessThanOrEqual(21);
    expect(weight.recent[0]).toHaveProperty("date");
    expect(weight.recent[0]).toHaveProperty("mean");
    expect(weight.recent[0]).toHaveProperty("min");
    expect(weight.recent[0]).toHaveProperty("max");
    expect(weight.monthly[0]).toHaveProperty("month");
    expect(weight.monthly[0]).toHaveProperty("mean");
    // The whole graded series collapses 1000 daily readings to a tiny
    // bucket count.
    const total =
      weight.recent.length +
      weight.weekly.length +
      weight.monthly.length +
      weight.yearly.length;
    expect(total).toBeLessThanOrEqual(50);
  });
});

describe("generateWeightStatusForUser — timeout/error never persists", () => {
  it("serves the fallback without writing a cache row on timeout", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generateWeightStatusForUser("user-1", {
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
    expect(windows[0].negativeReason).toBe("timeout");
    expect(windows[0].retryAt).toBeInstanceOf(Date);
    expect(prisma.insightStatusCache.updateMany).not.toHaveBeenCalled();
  });
});

describe("generateWeightStatusForUser — a negative window is not a note", () => {
  it("regenerates when today's row carries only a negative-cache window", async () => {
    const now = new Date();
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(now);
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        dateKey: todayKey,
        text: null,
        generatedAt: null,
        retryAt: new Date(now.getTime() + 60_000),
        negativeReason: "timeout",
      }) as never,
    );
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: now },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    stubCompletion('{"summary":"Fresh real assessment."}');

    const result = await generateWeightStatusForUser("user-1", {
      locale: "en",
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh real assessment.");
    expect(result.cached).toBe(false);
  });
});

describe("generateWeightStatusForUser — content-hash gate (v1.16.8)", () => {
  it("skips the completion and refreshes the cache row when the snapshot is unchanged", async () => {
    // Fixed clock so both generator runs build the identical snapshot.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T10:00:00.000Z"));
    try {
      const now = new Date();
      const records = [
        {
          type: "WEIGHT",
          value: 82,
          measuredAt: new Date(now.getTime() - dayMs),
        },
        {
          type: "WEIGHT",
          value: 81.6,
          measuredAt: new Date(now.getTime() - 2 * dayMs),
        },
      ];
      // Fresh copy per call — the generator reverses the result array in
      // place, and a shared fixture would flip order between the two runs.
      vi.mocked(prisma.measurement.findMany).mockImplementation((async () =>
        records.map((r) => ({ ...r }))) as never);
      vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
      stubCompletion('{"summary":"First real assessment."}');

      // First run: a real generation persists the snapshot fingerprint.
      await generateWeightStatusForUser("user-1", {
        locale: "en",
        force: true,
      });
      expect(runStatusCompletion).toHaveBeenCalledTimes(1);
      const [persisted] = writtenNotes(prisma.insightStatusCache.upsert);
      expect(persisted.text).toBe("First real assessment.");
      expect(persisted.snapshotHash).toMatch(/^[0-9a-f]{64}$/);

      // Second run, same data: the gate finds the matching fingerprint,
      // re-persists the same text under today's dateKey, and never calls
      // the provider — even though the run is forced.
      vi.mocked(runStatusCompletion).mockClear();
      vi.mocked(prisma.insightStatusCache.upsert).mockClear();
      vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
        noteRow({
          // Yesterday's note — outside the same-day cache read.
          dateKey: "2026-06-09",
          text: persisted.text,
          generatedAt: now,
          snapshotHash: persisted.snapshotHash,
        }) as never,
      );

      const result = await generateWeightStatusForUser("user-1", {
        locale: "en",
        force: true,
      });

      expect(runStatusCompletion).not.toHaveBeenCalled();
      expect(result.cached).toBe(true);
      expect(result.text).toBe(persisted.text);
      // The refresh re-dates the stored note to today and leaves the note
      // and its fingerprint alone.
      expect(prisma.insightStatusCache.upsert).not.toHaveBeenCalled();
      expect(prisma.insightStatusCache.updateMany).toHaveBeenCalledTimes(1);
      const refreshed = (
        vi.mocked(prisma.insightStatusCache.updateMany).mock.calls[0][0] as {
          data: Record<string, unknown>;
        }
      ).data;
      expect(refreshed).not.toHaveProperty("snapshotHash");
      expect(refreshed).not.toHaveProperty("textEncrypted");
      expect(refreshed.dateKey).not.toBe("2026-06-09");
    } finally {
      vi.useRealTimers();
    }
  });

  it("regenerates when the stored fingerprint differs from the fresh snapshot", async () => {
    const now = new Date();
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: now },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.insightStatusCache.findUnique).mockResolvedValue(
      noteRow({
        dateKey: "2026-06-09",
        text: "Older assessment.",
        generatedAt: now,
        snapshotHash: "f".repeat(64),
      }) as never,
    );
    stubCompletion('{"summary":"Fresh assessment for changed data."}');

    const result = await generateWeightStatusForUser("user-1", {
      locale: "en",
      force: true,
    });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh assessment for changed data.");
    expect(result.cached).toBe(false);
  });
});

describe("generateWeightStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { type: "WEIGHT", value: 82, measuredAt: new Date() },
    ] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    stubCompletion(
      '{"summary":"Weight trended down 0.4 kg last week. metric:WEIGHT"}',
    );

    const result = await generateWeightStatusForUser("user-1", {
      locale: "en",
    });

    expect(result.text).toBeTruthy();
    expect(result.text).not.toContain("metric:");
    const notes = writtenNotes(prisma.insightStatusCache.upsert);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].text).not.toContain("metric:");
  });
});

describe("generateWeightStatusForUser — judged against the stored target (#1006)", () => {
  async function snapshotFor(thresholdsJson: unknown) {
    const now = new Date();
    const records = Array.from({ length: 40 }, (_, day) => ({
      type: "WEIGHT",
      // Rising from 58 toward a 65–70 target over the last forty days.
      value: 60 - day * 0.05,
      measuredAt: new Date(now.getTime() - day * dayMs),
    }));
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      thresholdsJson,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);
    await generateWeightStatusForUser("user-1", { locale: "en" });
    return JSON.parse(captured.userPrompt!.match(/\{[\s\S]*\}/)![0]);
  }

  it("below the target, the model reads gaining as progress", async () => {
    const snapshot = await snapshotFor({ WEIGHT: { min: 65, max: 70 } });
    expect(snapshot.weight.target).toMatchObject({
      position: "below",
      progress: "gaining",
    });
    expect(snapshot.weight.signal.direction).toBe("higher-better");
  });

  it("without a target, no direction is claimed", async () => {
    const snapshot = await snapshotFor(null);
    expect(snapshot.weight.target).toBeUndefined();
    expect(snapshot.weight.signal.direction).toBe("target-band");
  });
});

describe("generateWeightStatusForUser — the reader's mass unit", () => {
  it("hands an imperial reader every weight figure and threshold in pounds", async () => {
    const now = new Date();
    const records = Array.from({ length: 40 }, (_, day) => ({
      type: "WEIGHT",
      value: 80,
      measuredAt: new Date(now.getTime() - day * dayMs),
    }));
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      thresholdsJson: { WEIGHT: { min: 65, max: 70 } },
      unitPreference: "imperial",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(records as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    let sent: { systemPrompt: string; userPrompt: string } | null = null;
    vi.mocked(runStatusCompletion).mockImplementation(async (args) => {
      sent = args as never;
      return {
        kind: "ok",
        content: '{"summary":"OK"}',
        providerType: "anthropic",
        model: "x",
        tokensUsed: 1,
      } as never;
    });

    await generateWeightStatusForUser("user-1", { locale: "en" });

    const snapshot = JSON.parse(sent!.userPrompt.match(/\{[\s\S]*\}/)![0]);
    expect(snapshot.weight.unit).toBe("lb");
    expect(snapshot.weight.signal.unit).toBe("lb");
    expect(snapshot.weight.latestDayFocus.value).toBe(176.4);
    expect(snapshot.weight.summary.mean).toBe(176.4);
    expect(snapshot.weight.series.recent[0].mean).toBe(176.4);
    expect(snapshot.weight.target).toMatchObject({
      min: 143.3,
      max: 154.3,
      unit: "lb",
    });
    expect(JSON.stringify(snapshot.weight)).not.toContain("kg");
    // The card's own thresholds are stated in pounds as well.
    expect(sent!.systemPrompt).toContain("< 1.1 lb over");
    expect(sent!.systemPrompt).toContain("~1.1 lb-2.2 lb per week");
    expect(sent!.systemPrompt).not.toMatch(/\d kg/);
  });
});
