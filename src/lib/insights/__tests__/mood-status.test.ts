import { describe, expect, it, vi, beforeEach } from "vitest";

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
    moodEntry: { findMany: vi.fn() },
    measurement: { findMany: vi.fn() },
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
import { generateMoodStatusForUser } from "../mood-status";
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
  // The snapshot threads the user's source priority into the factor crosstab;
  // default to "no custom priority" so every test resolves it without stubbing.
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    sourcePriorityJson: null,
  } as never);
});

describe("generateMoodStatusForUser — graded payload", () => {
  it("emits a graded {recent, weekly, monthly} mood series, not the full daily array", async () => {
    const now = new Date();
    const entries: Array<{
      date: string;
      score: number;
      tags: string[];
      moodLoggedAt: Date;
    }> = [];
    for (let day = 0; day < 1000; day++) {
      const t = new Date(now.getTime() - day * dayMs);
      entries.push({
        date: t.toISOString().slice(0, 10),
        score: 3 + (day % 3) * 0.5,
        tags: [],
        moodLoggedAt: t,
      });
    }

    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue(entries as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);

    const captured: { userPrompt: string | null } = { userPrompt: null };
    stubCompletion('{"summary":"OK"}', captured);

    await generateMoodStatusForUser("user-1", { locale: "en" });

    const match = captured.userPrompt!.match(/\{[\s\S]*\}/);
    const snapshot = JSON.parse(match![0]);

    const mood = snapshot.mood.series;
    expect(mood).toHaveProperty("recent");
    expect(mood).toHaveProperty("weekly");
    expect(mood).toHaveProperty("monthly");
    expect(mood).toHaveProperty("yearly");
    expect(mood.recent.length).toBeLessThanOrEqual(21);
    expect(mood.recent[0]).toHaveProperty("date");
    expect(mood.recent[0]).toHaveProperty("mean");
    expect(mood.monthly[0]).toHaveProperty("month");
    const total =
      mood.recent.length +
      mood.weekly.length +
      mood.monthly.length +
      mood.yearly.length;
    expect(total).toBeLessThanOrEqual(50);
  });
});

describe("generateMoodStatusForUser — timeout/error never persists", () => {
  it("serves the fallback without writing a cache row on timeout", async () => {
    const t = new Date();
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      {
        date: t.toISOString().slice(0, 10),
        score: 4,
        tags: [],
        moodLoggedAt: t,
      },
    ] as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);

    vi.mocked(runStatusCompletion).mockResolvedValue({
      kind: "timeout",
    } as never);

    const result = await generateMoodStatusForUser("user-1", { locale: "en" });

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

describe("generateMoodStatusForUser — a negative window is not a note", () => {
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
        retryAt: new Date(Date.now() + 60_000),
        negativeReason: "timeout",
      }) as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      {
        date: now.toISOString().slice(0, 10),
        score: 4,
        tags: [],
        moodLoggedAt: now,
      },
    ] as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);

    stubCompletion('{"summary":"Fresh mood assessment."}');

    const result = await generateMoodStatusForUser("user-1", { locale: "en" });

    expect(runStatusCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Fresh mood assessment.");
    expect(result.cached).toBe(false);
  });
});

describe("generateMoodStatusForUser — token-leak hardening (v1.4.27 F16)", () => {
  it("strips metric: tokens out of the cached text before persisting", async () => {
    const t = new Date();
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      {
        date: t.toISOString().slice(0, 10),
        score: 4,
        tags: [],
        moodLoggedAt: t,
      },
    ] as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);

    stubCompletion('{"summary":"Mood stayed positive. metric:MOOD"}');

    const result = await generateMoodStatusForUser("user-1", { locale: "en" });

    expect(result.text).toBeTruthy();
    expect(result.text).not.toContain("metric:");
    const notes = writtenNotes(prisma.insightStatusCache.upsert);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].text).not.toContain("metric:");
  });
});
