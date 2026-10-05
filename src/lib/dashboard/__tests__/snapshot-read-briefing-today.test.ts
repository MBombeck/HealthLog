/**
 * The snapshot read serves the briefing as it stands today, for every
 * client: the dashboard, the RSC prefetch, iOS and the digest all read
 * through `readDashboardSnapshotCached`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/generated/prisma/client";
import { AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

const BRIEFING = {
  paragraph: "Your pulse is well above its usual level today.",
  signalsOfDay: [
    {
      sourceMetric: "pulse",
      tone: "watch",
      headline: "Pulse is up today",
      nudge: "Take it easy this evening.",
      delta: "+33.72 bpm vs your 30-day average",
    },
    {
      sourceMetric: "sleep",
      tone: "info",
      headline: "Shorter night",
      nudge: "An earlier night would suit it.",
      delta: null,
    },
  ],
  keyFindings: [],
};

const body = (pulseLastSeen: string) => ({
  tiles: {
    lastSeenByType: { PULSE: { lastSeenAt: pulseLastSeen, daysAgo: 0 } },
  },
  briefing: BRIEFING,
  briefingMemory: null,
  briefingState: "ready",
  // Stamped this morning, as every warm stamps the row.
  briefingUpdatedAt: "2026-10-05T02:30:00.000Z",
  briefingStale: false,
  briefingAi: null,
});
let current = body("2026-10-04T06:50:00.000Z");
const buildDashboardSnapshot = vi.fn(async () => current);

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/dashboard/snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/snapshot")>()),
  buildDashboardSnapshot: () => buildDashboardSnapshot(),
}));
vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: async () => "en",
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityToServe: async () => AI_AVAILABLE,
}));

const { readDashboardSnapshotCached } = await import("../snapshot-read");
const { __resetAllCachesForTests } = await import("@/lib/cache/server-cache");

/** 2026-10-05 21:00 in Berlin. */
const NOW = new Date("2026-10-05T19:00:00.000Z");

function user(generatedAt: string | null): User {
  return {
    id: "user-briefing-today",
    locale: "en",
    timezone: "Europe/Berlin",
    insightsCachedText: JSON.stringify({
      dailyBriefing: BRIEFING,
      ...(generatedAt ? { briefingGeneratedAt: generatedAt } : {}),
    }),
  } as unknown as User;
}

beforeEach(() => {
  __resetAllCachesForTests();
  current = body("2026-10-04T06:50:00.000Z");
});

describe("readDashboardSnapshotCached — the briefing's own day", () => {
  it("does not serve yesterday's text that a warm only re-stamped", async () => {
    const { body: read } = await readDashboardSnapshotCached(
      user("2026-10-04T02:30:00.000Z"),
      undefined,
      { now: NOW },
    );
    expect(read.briefing).toBeNull();
    expect(read.briefingState).toBe("preparing");
  });

  it("does not serve a payload with no generation moment", async () => {
    const { body: read } = await readDashboardSnapshotCached(
      user(null),
      undefined,
      { now: NOW },
    );
    expect(read.briefing).toBeNull();
  });

  it("drops a pulse signal last measured yesterday and keeps the rest", async () => {
    const { body: read } = await readDashboardSnapshotCached(
      user("2026-10-05T02:30:00.000Z"),
      undefined,
      { now: NOW },
    );
    expect(read.briefing?.signalsOfDay?.map((s) => s.sourceMetric)).toEqual([
      "sleep",
    ]);
    expect(read.briefingState).toBe("ready");
  });

  it("serves today's pulse signal with its delta at display precision", async () => {
    current = body("2026-10-05T06:50:00.000Z");
    const { body: read } = await readDashboardSnapshotCached(
      user("2026-10-05T02:30:00.000Z"),
      undefined,
      { now: NOW },
    );
    expect(read.briefing?.signalsOfDay?.[0]?.delta).toBe(
      "+34 bpm vs your 30-day average",
    );
  });
});
