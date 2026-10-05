/**
 * The snapshot read serves the briefing as it stands today, for every
 * client: the dashboard, the RSC prefetch, iOS and the digest all read
 * through `readDashboardSnapshotCached`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/generated/prisma/client";
import {
  AI_AVAILABLE,
  aiUnavailable,
} from "@/__tests__/helpers/ai-capability-fixtures";

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
const capability = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityToServe: async () => capability.current,
}));
const requestTodayBriefingWarm = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => undefined),
);
vi.mock("@/lib/daily/briefing-today-warm", () => ({
  requestTodayBriefingWarm,
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
  capability.current = AI_AVAILABLE;
  requestTodayBriefingWarm.mockClear();
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

describe("readDashboardSnapshotCached — asking for today's briefing", () => {
  it("hands the read's view of the day to the today warm", async () => {
    await readDashboardSnapshotCached(
      user("2026-10-04T02:30:00.000Z"),
      undefined,
      {
        now: NOW,
      },
    );
    expect(requestTodayBriefingWarm).toHaveBeenCalledTimes(1);
    const arg = requestTodayBriefingWarm.mock.calls[0][0] as {
      generatedAt: string;
      timezone: string;
      now: Date;
      lastSeenAt: (type: string) => string | null;
    };
    expect(arg.generatedAt).toBe("2026-10-04T02:30:00.000Z");
    expect(arg.timezone).toBe("Europe/Berlin");
    expect(arg.now).toBe(NOW);
    expect(arg.lastSeenAt("PULSE")).toBe("2026-10-04T06:50:00.000Z");
  });

  it("asks for nothing while the briefing capability is unavailable", async () => {
    capability.current = aiUnavailable("consent_required");
    await readDashboardSnapshotCached(user(null), undefined, { now: NOW });
    expect(requestTodayBriefingWarm).not.toHaveBeenCalled();
  });
});
