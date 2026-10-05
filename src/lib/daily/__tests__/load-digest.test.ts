import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `loadDailyDigest` — cache behaviour for the S11/S12 "extras" (the milestone
 * gather + the intraday-tension read). Perf finding: both re-derived from
 * scratch on every 120 s poll of every open tab, reading ~8.5k rows to
 * surface a usually-null marker. Now wrapped in one SWR cell
 * (`loadDailyDigestExtrasCached`, internal to `load-digest.ts`) under the
 * shared `analytics` bucket, so this file drives the reads its builder
 * touches (`probeRollupCoverage`, `loadIntradayPulse`) and asserts they run
 * once per cache generation, not once per request.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    integrationStatus: { findMany: vi.fn().mockResolvedValue([]) },
    measurementReminder: { findMany: vi.fn().mockResolvedValue([]) },
    coachPlan: { findMany: vi.fn().mockResolvedValue([]) },
    ecgRecording: { findFirst: vi.fn().mockResolvedValue(null) },
    dismissedPriorityItem: { findMany: vi.fn().mockResolvedValue([]) },
    personalRecord: { findMany: vi.fn().mockResolvedValue([]) },
    arrivalReaction: { findMany: vi.fn().mockResolvedValue([]) },
    encounter: { findMany: vi.fn().mockResolvedValue([]) },
    healthScoreRecord: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/lib/insights/derived/coincident-deviation", () => ({
  computeCoincidentDeviation: vi.fn(),
}));

vi.mock("@/lib/illness/rest-mode", () => ({
  resolveRestMode: vi.fn(),
}));

vi.mock("@/lib/cycle/today-verdict", () => ({
  readTodayCycle: vi.fn(),
}));

vi.mock("@/lib/dashboard/snapshot-read", () => ({
  readDashboardSnapshotCached: vi.fn(),
}));

vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/insights/derived/baseline", () => ({
  readDayMeanSeries: vi.fn().mockResolvedValue({ points: [], source: "none" }),
  loadBaselineProfile: vi
    .fn()
    .mockResolvedValue({ ageYears: 40, sex: "FEMALE", heightCm: 170 }),
}));

vi.mock("@/lib/analytics/intraday-pulse-io", () => ({
  loadIntradayPulse: vi.fn(),
}));

vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: vi.fn(),
  aiCapabilityToServe: vi.fn(),
}));

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: vi.fn(() => "a reaction line"),
}));

vi.mock("@/lib/i18n/server-translator", () => ({
  getServerTranslator: vi.fn().mockReturnValue({ t: (key: string) => key }),
}));

import type { User } from "@/generated/prisma/client";
import { loadDailyDigest } from "../load-digest";
import { readDashboardSnapshotCached } from "@/lib/dashboard/snapshot-read";
import { resolveModuleMap } from "@/lib/modules/gate";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { loadIntradayPulse } from "@/lib/analytics/intraday-pulse-io";
import { readDayMeanSeries } from "@/lib/insights/derived/baseline";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { prisma } from "@/lib/db";
import {
  aiCapabilityForRecord,
  aiCapabilityToServe,
} from "@/lib/ai/capabilities/gate";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { computeCoincidentDeviation } from "@/lib/insights/derived/coincident-deviation";
import { resolveRestMode } from "@/lib/illness/rest-mode";
import { readTodayCycle } from "@/lib/cycle/today-verdict";
import {
  AI_AVAILABLE,
  aiUnavailable,
} from "@/__tests__/helpers/ai-capability-fixtures";

const SNAPSHOT = {
  body: {
    layout: { enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS] },
    tiles: { lastSeenByType: {} },
    medsToday: {
      activeCount: 0,
      scheduledToday: 0,
      takenToday: 0,
      skippedToday: 0,
      nextDueAt: null,
      nextDueOverdue: false,
    },
    healthScore: null,
    briefing: null,
    briefingState: "ready",
    briefingUpdatedAt: null,
    briefingStale: false,
    briefingAi: AI_AVAILABLE,
  },
  locale: "en",
};

const USER = {
  id: "user-1",
  timezone: "Europe/Berlin",
  morningDigestRefreshedOn: null,
} as unknown as User;

const NOW = new Date("2026-07-17T09:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllCachesForTests();
  vi.mocked(readDashboardSnapshotCached).mockResolvedValue(SNAPSHOT as never);
  vi.mocked(resolveModuleMap).mockResolvedValue({} as never);
  vi.mocked(probeRollupCoverage).mockResolvedValue(new Map());
  vi.mocked(loadIntradayPulse).mockResolvedValue({ tension: null } as never);
  vi.mocked(aiCapabilityForRecord).mockResolvedValue(AI_AVAILABLE);
  vi.mocked(aiCapabilityToServe).mockResolvedValue(AI_AVAILABLE);
  vi.mocked(computeCoincidentDeviation).mockResolvedValue({
    status: "insufficient",
  } as never);
  vi.mocked(resolveRestMode).mockResolvedValue({
    active: false,
    since: null,
    episodeCount: 0,
    episodes: [],
  });
  vi.mocked(readTodayCycle).mockResolvedValue(null);
});

describe("loadDailyDigest — milestone day", () => {
  // 21:30 on 16 July in New York is already 17 July in UTC. A best set at
  // 19:00 local that evening was reached today, on the user's calendar.
  const NY_USER = { ...USER, timezone: "America/New_York" } as User;
  const NY_EVENING = new Date("2026-07-17T01:30:00.000Z");

  it("keys today and a new record on the user's own day", async () => {
    vi.mocked(prisma.personalRecord.findMany).mockResolvedValueOnce([
      {
        metricType: "RESTING_HEART_RATE",
        achievedAt: new Date("2026-07-16T23:00:00.000Z"),
      },
    ] as never);

    const digest = await loadDailyDigest(NY_USER, NY_EVENING);

    expect(digest.worthALook.some((i) => i.kind === "milestone")).toBe(true);
  });

  it("folds the streak series on the user's days", async () => {
    vi.mocked(probeRollupCoverage).mockResolvedValue(
      new Map([["RESTING_HEART_RATE", true]]) as never,
    );
    await loadDailyDigest(NY_USER, NY_EVENING);
    const calls = vi.mocked(readDayMeanSeries).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[5]).toBe("America/New_York");
  });
});

describe("loadDailyDigest — S11/S12 extras cache", () => {
  it("gathers the milestone + tension inputs once, then serves the second poll from cache", async () => {
    await loadDailyDigest(USER, NOW);
    await loadDailyDigest(USER, NOW);

    expect(probeRollupCoverage).toHaveBeenCalledTimes(1);
    expect(loadIntradayPulse).toHaveBeenCalledTimes(1);
  });

  it("runs the milestone gather and the tension read in parallel, not sequentially", async () => {
    const order: string[] = [];
    vi.mocked(probeRollupCoverage).mockImplementation(async () => {
      order.push("milestone-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("milestone-end");
      return new Map();
    });
    vi.mocked(loadIntradayPulse).mockImplementation(async () => {
      order.push("tension-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("tension-end");
      return { tension: null } as never;
    });

    await loadDailyDigest(USER, NOW);

    // Sequential awaits would read as [milestone-start, milestone-end,
    // tension-start, tension-end]. Promise.all interleaves the starts
    // before either finishes.
    expect(order.slice(0, 2).sort()).toEqual([
      "milestone-start",
      "tension-start",
    ]);
  });

  it("refreshes on the next read after a measurement write invalidates the user's cache", async () => {
    await loadDailyDigest(USER, NOW);
    expect(probeRollupCoverage).toHaveBeenCalledTimes(1);

    // A fresh sleep / vitals landing (interactive write) hard-evicts the
    // `${userId}|` prefix — the same sweep the dashboard-snapshot cell
    // already relies on.
    invalidateUserMeasurements(USER.id, { evict: true });

    await loadDailyDigest(USER, NOW);
    expect(probeRollupCoverage).toHaveBeenCalledTimes(2);
    expect(loadIntradayPulse).toHaveBeenCalledTimes(2);
  });

  it("gathers the extras even with the insights module (the AI analysis opt-out) off", async () => {
    vi.mocked(resolveModuleMap).mockResolvedValue({ insights: false } as never);

    await loadDailyDigest(USER, NOW);

    expect(probeRollupCoverage).toHaveBeenCalled();
    expect(loadIntradayPulse).toHaveBeenCalled();
  });
  it("threads the resolved hero-item visibility into composition", async () => {
    vi.mocked(readDashboardSnapshotCached).mockResolvedValueOnce({
      ...SNAPSHOT,
      body: {
        ...SNAPSHOT.body,
        layout: { enabledHeroItemKinds: [] },
        medsToday: {
          ...SNAPSHOT.body.medsToday,
          nextDueOverdue: true,
          nextDueMedicationName: "Morning dose",
        },
      },
    } as never);

    const digest = await loadDailyDigest(USER, NOW);
    expect(digest.worthALook).toEqual([]);
  });
  it("lets non-hero consumers consider a candidate hidden by the dashboard", async () => {
    vi.mocked(readDashboardSnapshotCached).mockResolvedValueOnce({
      ...SNAPSHOT,
      body: {
        ...SNAPSHOT.body,
        layout: { enabledHeroItemKinds: [] },
        medsToday: {
          ...SNAPSHOT.body.medsToday,
          nextDueOverdue: true,
          nextDueMedicationName: "Morning dose",
        },
      },
    } as never);

    const digest = await loadDailyDigest(USER, NOW, {
      enabledItemKinds: PRIORITY_ITEM_KINDS,
    });

    expect(digest.worthALook.map((item) => item.kind)).toContain("dose_window");
  });
});

describe("loadDailyDigest — AI parts", () => {
  const ARRIVAL = {
    kind: "sleep_night",
    occurredAt: new Date("2026-07-17T06:00:00.000Z"),
    arrivedAt: new Date("2026-07-17T08:55:00.000Z"),
    lineEncrypted: new Uint8Array([1, 2, 3]),
    generatedAt: new Date("2026-07-17T08:56:00.000Z"),
  };

  it("resolves the coach and reaction-line capabilities for the record and publishes them", async () => {
    const digest = await loadDailyDigest(USER, NOW);

    expect(aiCapabilityForRecord).toHaveBeenCalledWith("user-1", "coach");
    expect(aiCapabilityToServe).toHaveBeenCalledWith("user-1", "reactionLines");
    expect(digest.ai).toEqual({
      briefing: AI_AVAILABLE,
      coach: AI_AVAILABLE,
      reactionLines: AI_AVAILABLE,
    });
  });

  it("serves the stored reaction line while the capability is available", async () => {
    vi.mocked(prisma.arrivalReaction.findMany).mockResolvedValueOnce([
      ARRIVAL,
    ] as never);

    const digest = await loadDailyDigest(USER, NOW);

    expect(digest.reactionLine).toBe("a reaction line");
  });

  it("neither decrypts nor serves a stored reaction line while the capability is unavailable", async () => {
    vi.mocked(aiCapabilityToServe).mockResolvedValue(
      aiUnavailable("user_disabled"),
    );
    vi.mocked(prisma.arrivalReaction.findMany).mockResolvedValueOnce([
      ARRIVAL,
    ] as never);

    const digest = await loadDailyDigest(USER, NOW);

    expect(digest.reactionLine).toBeNull();
    expect(decryptFromBytes).not.toHaveBeenCalled();
    // The marker itself is data and still drives the "just in" chip.
    expect(digest.justIn?.kind).toBe("sleep_night");
  });

  it("does not decrypt plan prose while the coach capability is unavailable", async () => {
    vi.mocked(aiCapabilityForRecord).mockResolvedValue(
      aiUnavailable("operator_disabled"),
    );
    vi.mocked(prisma.coachPlan.findMany).mockResolvedValueOnce([
      {
        id: "p1",
        status: "active",
        reviewDate: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        ifCueEncrypted: new Uint8Array([1]),
        thenActionEncrypted: new Uint8Array([2]),
      },
    ] as never);

    const digest = await loadDailyDigest(USER, NOW);

    expect(decryptFromBytes).not.toHaveBeenCalled();
    expect(digest.worthALook.some((i) => i.kind === "coach_checkin")).toBe(
      false,
    );
  });

  it("fails closed on the briefing when a cached body predates the published state", async () => {
    const { briefingAi: _dropped, ...older } = SNAPSHOT.body;
    vi.mocked(readDashboardSnapshotCached).mockResolvedValueOnce({
      ...SNAPSHOT,
      body: older,
    } as never);

    const digest = await loadDailyDigest(USER, NOW);

    expect(digest.ai.briefing).toEqual({
      available: false,
      reason: "check_failed",
      onDeviceAllowed: false,
    });
  });
});

describe("loadDailyDigest — the briefing's own day", () => {
  const BRIEFING = {
    paragraph: "Last night's sleep came in a little short of your usual.",
    signalsOfDay: [
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

  function withBriefing(cachedText: string) {
    vi.mocked(readDashboardSnapshotCached).mockResolvedValueOnce({
      ...SNAPSHOT,
      // The row was stamped this morning, as every warm stamps it.
      body: {
        ...SNAPSHOT.body,
        briefing: BRIEFING,
        briefingUpdatedAt: "2026-07-17T02:30:00.000Z",
      },
    } as never);
    return { ...USER, insightsCachedText: cachedText } as User;
  }

  it("does not serve yesterday's text that a warm only re-stamped", async () => {
    // Generated yesterday; the unchanged-hash warm at 04:30 refreshed only
    // insightsCachedAt.
    const user = withBriefing(
      JSON.stringify({
        dailyBriefing: BRIEFING,
        briefingGeneratedAt: "2026-07-16T02:30:00.000Z",
      }),
    );
    const digest = await loadDailyDigest(user, NOW);
    expect(digest.briefingLead).toBeNull();
    expect(digest.topSignal).toBeNull();
  });

  it("does not serve a payload that predates the generation moment", async () => {
    const user = withBriefing(JSON.stringify({ dailyBriefing: BRIEFING }));
    const digest = await loadDailyDigest(user, NOW);
    expect(digest.topSignal).toBeNull();
  });

  it("serves text generated today", async () => {
    const user = withBriefing(
      JSON.stringify({
        dailyBriefing: BRIEFING,
        briefingGeneratedAt: "2026-07-17T02:30:00.000Z",
      }),
    );
    const digest = await loadDailyDigest(user, NOW);
    expect(digest.briefingLead).toBe(BRIEFING.paragraph);
    expect(digest.topSignal?.sourceMetric).toBe("sleep");
  });
});

/** A reminder row as the preventive read selects it; due this morning. */
function reminderRow(over: Record<string, unknown> = {}) {
  return {
    label: "Skin check",
    origin: "VORSORGE",
    intervalDays: null,
    rrule: "FREQ=YEARLY;INTERVAL=1",
    anchorDate: null,
    notifyHour: 9,
    lastSatisfiedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    nextDueAt: new Date("2026-07-17T07:00:00.000Z"),
    ...over,
  };
}

// v1.39.2 — the two reads behind the check-up and visit rail items. NOW is
// 11:00 in Berlin on 2026-07-17, so the local day runs 2026-07-16T22:00Z to
// 2026-07-17T22:00Z.
describe("loadDailyDigest — due check-ups and today's visits", () => {
  it("reads check-ups due before the end of the local day, not only before now", async () => {
    await loadDailyDigest(USER, NOW);

    const args = vi.mocked(prisma.measurementReminder.findMany).mock
      .calls[0][0] as { where: Record<string, unknown> };
    expect(args.where.nextDueAt).toEqual({
      not: null,
      lt: new Date("2026-07-17T22:00:00.000Z"),
    });
    // Appointments stay off the preventive read.
    expect(args.where.origin).toEqual({ not: "ENCOUNTER" });
  });

  it("reads every planned visit from the start of the local day", async () => {
    await loadDailyDigest(USER, NOW);

    const args = vi.mocked(prisma.encounter.findMany).mock.calls[0][0] as {
      where: { status: string; occurredAt: { gte: Date; lte: Date } };
    };
    expect(args.where.status).toBe("PLANNED");
    expect(args.where.occurredAt.gte).toEqual(
      new Date("2026-07-16T22:00:00.000Z"),
    );
    expect(args.where.occurredAt.lte).toEqual(
      new Date("2026-07-19T09:00:00.000Z"),
    );
  });

  it("puts a visit that started this morning on the rail as today's", async () => {
    vi.mocked(prisma.encounter.findMany).mockResolvedValueOnce([
      {
        id: "v1",
        kind: "ROUTINE",
        occurredAt: new Date("2026-07-17T07:00:00.000Z"), // 09:00 Berlin
        practitioner: { name: "Dr. Weiss" },
      },
      {
        id: "v2",
        kind: "ROUTINE",
        occurredAt: new Date("2026-07-17T23:30:00.000Z"), // 01:30 tomorrow
        practitioner: { name: "Lab" },
      },
    ] as never);

    const digest = await loadDailyDigest(USER, NOW);

    const visits = digest.worthALook.filter(
      (item) => item.kind === "upcoming_visit",
    );
    // The translator is stubbed to echo keys, so the bucket shows in the key.
    expect(visits.map((item) => item.body)).toEqual([
      "daily.item.upcomingVisit.bodyToday",
      "daily.item.upcomingVisit.bodyTomorrow",
    ]);
  });

  it("translates a Coach cadence label and keeps a free-text one", async () => {
    const t = vi.fn((key: string) =>
      key === "coach.cadence.bp7day.label" ? "Blood pressure week" : key,
    );
    const { getServerTranslator } =
      await import("@/lib/i18n/server-translator");
    vi.mocked(getServerTranslator).mockReturnValueOnce({ t } as never);
    vi.mocked(prisma.measurementReminder.findMany).mockResolvedValueOnce([
      reminderRow({ label: "coach.cadence.bp7day.label", origin: "COACH" }),
      reminderRow({ label: "coach.cadence.bp7day.label" }),
    ] as never);

    await loadDailyDigest(USER, NOW);

    expect(t).toHaveBeenCalledWith("daily.item.preventiveCare.bodyManyNamed", {
      labels: "Blood pressure week, coach.cadence.bp7day.label",
    });
  });

  // Watched red: with every reminder due before the end of the day on the
  // rail, a daily weigh-in at 20:00 read "check-up due" from the morning on.
  it("shows a reminder that stays due from the morning of its day", async () => {
    vi.mocked(prisma.measurementReminder.findMany).mockResolvedValueOnce([
      reminderRow({
        label: "PHQ-9",
        measurementType: "PHQ9_SCORE",
        rrule: null,
        intervalDays: 14,
        nextDueAt: new Date("2026-07-17T16:00:00.000Z"), // 18:00 today
      }),
    ] as never);

    const digest = await loadDailyDigest(USER, NOW);

    expect(digest.worthALook.map((i) => i.kind)).toContain("preventive_care");
  });

  it("leaves a short-cycle reminder due later today off until its time", async () => {
    vi.mocked(prisma.measurementReminder.findMany).mockResolvedValueOnce([
      reminderRow({
        label: "Weigh-in",
        measurementType: "WEIGHT",
        rrule: null,
        intervalDays: 1,
        notifyHour: 20,
        nextDueAt: new Date("2026-07-17T18:00:00.000Z"), // 20:00 today
      }),
    ] as never);

    const digest = await loadDailyDigest(USER, NOW);

    expect(digest.worthALook.map((i) => i.kind)).not.toContain(
      "preventive_care",
    );
  });

  it("shows a short-cycle reminder once its time has come", async () => {
    vi.mocked(prisma.measurementReminder.findMany).mockResolvedValueOnce([
      reminderRow({
        label: "Weigh-in",
        rrule: null,
        intervalDays: 1,
        nextDueAt: new Date("2026-07-17T06:00:00.000Z"), // 08:00 today
      }),
    ] as never);

    const digest = await loadDailyDigest(USER, NOW);

    expect(digest.worthALook.map((i) => i.kind)).toContain("preventive_care");
  });
});

describe("loadDailyDigest — Today overview inputs", () => {
  // Visits are left off the rail here so the Today line is the one place
  // they appear; with the rail kind on, the line steps aside (see
  // `today-overview.test.ts`).
  const NO_VISIT_RAIL = PRIORITY_ITEM_KINDS.filter(
    (kind) => kind !== "upcoming_visit",
  );

  function visit(at: string, name = "GP") {
    return {
      id: `v-${at}`,
      kind: "ROUTINE",
      occurredAt: new Date(at),
      practitioner: { name },
    };
  }

  // 21:30Z on 17 July is 23:30 in Berlin (CEST): the last half hour of the
  // local day. A visit at 23:45 local is still today; one at 00:30 local is
  // tomorrow, although both fall on the same UTC date.
  const LATE_EVENING = new Date("2026-07-17T21:30:00.000Z");

  it("puts a 23:45 visit under today and a 00:30 visit under tomorrow, late in the evening", async () => {
    vi.mocked(prisma.encounter.findMany).mockResolvedValueOnce([
      visit("2026-07-17T21:45:00.000Z", "Dr. Late"),
    ] as never);
    const today = await loadDailyDigest(USER, LATE_EVENING, {
      enabledItemKinds: NO_VISIT_RAIL,
    });
    expect(today.today).toEqual([
      expect.objectContaining({
        kind: "appointment",
        value: "daily.todayFact.appointment.today",
      }),
    ]);

    vi.mocked(prisma.encounter.findMany).mockResolvedValueOnce([
      visit("2026-07-17T22:30:00.000Z", "Dr. Early"),
    ] as never);
    const tomorrow = await loadDailyDigest(USER, LATE_EVENING, {
      enabledItemKinds: NO_VISIT_RAIL,
    });
    expect(tomorrow.today).toEqual([
      expect.objectContaining({
        kind: "appointment",
        value: "daily.todayFact.appointment.tomorrow",
      }),
    ]);
  });

  it("reads the same instants on a New York clock", async () => {
    const NY_USER = { ...USER, timezone: "America/New_York" } as User;
    vi.mocked(prisma.encounter.findMany).mockResolvedValueOnce([
      visit("2026-07-17T22:30:00.000Z"),
    ] as never);
    // 17:30 in New York: the 18:30 visit is still today there.
    const digest = await loadDailyDigest(NY_USER, LATE_EVENING, {
      enabledItemKinds: NO_VISIT_RAIL,
    });
    expect(digest.today[0]?.value).toBe("daily.todayFact.appointment.today");
  });

  it("renders the visit time in the profile zone and hour-cycle preference", async () => {
    const { getServerTranslator } =
      await import("@/lib/i18n/server-translator");
    const seen: Array<Record<string, unknown> | undefined> = [];
    vi.mocked(getServerTranslator).mockReturnValueOnce({
      t: (key: string, params?: Record<string, unknown>) => {
        if (key === "daily.todayFact.appointment.today") seen.push(params);
        return key;
      },
    } as never);
    vi.mocked(prisma.encounter.findMany).mockResolvedValueOnce([
      visit("2026-07-17T21:45:00.000Z", "Dr. Late"),
    ] as never);
    await loadDailyDigest(
      { ...USER, timeFormat: "H12" } as User,
      LATE_EVENING,
      { enabledItemKinds: NO_VISIT_RAIL },
    );
    expect(seen[0]).toEqual({ time: "11:45 PM", what: "Dr. Late" });
  });

  it("passes Rest Mode through, counted on the reader's own calendar", async () => {
    vi.mocked(resolveRestMode).mockResolvedValueOnce({
      active: true,
      // 22:00Z on 14 July is already 15 July in Berlin: day 3 on 17 July.
      since: "2026-07-14T22:00:00.000Z",
      episodeCount: 1,
      episodes: [],
    });
    const digest = await loadDailyDigest(USER, NOW);
    expect(digest.restMode).toEqual({ day: 3 });
    expect(digest.today[0]).toMatchObject({ kind: "rest_mode" });
  });

  it("does not read Rest Mode or the cycle while their modules are off", async () => {
    vi.mocked(resolveModuleMap).mockResolvedValueOnce({
      illness: false,
      cycle: false,
    } as never);
    const digest = await loadDailyDigest(USER, NOW);
    expect(resolveRestMode).not.toHaveBeenCalled();
    expect(readTodayCycle).not.toHaveBeenCalled();
    expect(digest.restMode).toBeNull();
  });

  it("reads the cycle once per extras cell, and again after a cycle write", async () => {
    // The digest polls every 120 s. The cycle read (the whole cycle history,
    // 90 days of day logs and wrist temperature) rides the cached cell, which
    // a cycle write hard-evicts.
    await loadDailyDigest(USER, NOW);
    await loadDailyDigest(USER, NOW);
    expect(readTodayCycle).toHaveBeenCalledTimes(1);
    invalidateUserHealthContext(USER.id);
    await loadDailyDigest(USER, NOW);
    expect(readTodayCycle).toHaveBeenCalledTimes(2);
  });

  it("reads the cycle in the profile timezone and keeps a failed read quiet", async () => {
    vi.mocked(readTodayCycle).mockRejectedValueOnce(new Error("boom"));
    const digest = await loadDailyDigest(USER, NOW);
    expect(readTodayCycle).toHaveBeenCalledWith(USER.id, "Europe/Berlin", NOW);
    expect(digest.today.some((f) => f.kind === "cycle")).toBe(false);
  });

  it("builds the deterministic lead from the vitals read when AI is off", async () => {
    vi.mocked(readDashboardSnapshotCached).mockResolvedValueOnce({
      ...SNAPSHOT,
      body: {
        ...SNAPSHOT.body,
        briefingAi: aiUnavailable("user_disabled"),
      },
    } as never);
    vi.mocked(aiCapabilityToServe).mockResolvedValue(
      aiUnavailable("user_disabled"),
    );
    vi.mocked(computeCoincidentDeviation).mockResolvedValueOnce({
      status: "ok",
      value: {
        fired: false,
        contributing: [],
        day: "2026-07-17",
        illnessExplained: false,
        vitals: [
          {
            type: "RESTING_HEART_RATE",
            value: 61,
            center: 54,
            low: 50,
            high: 58,
            outside: true,
            direction: "above",
            daysAgo: 0,
          },
        ],
      },
    } as never);
    const digest = await loadDailyDigest(USER, NOW);
    expect(digest.lead).toEqual({
      text: "daily.lead.vitalOutside.above",
      source: "signal",
    });
    expect(digest.briefingLead).toBeNull();
  });

  it("says a glucose range is the usual one for this time of day", async () => {
    // Today's glucose is held against the same hours of earlier days, so the
    // range it names is not the whole-day band shown elsewhere.
    const { getServerTranslator: real } = await vi.importActual<
      typeof import("@/lib/i18n/server-translator")
    >("@/lib/i18n/server-translator");
    const { getServerTranslator } =
      await import("@/lib/i18n/server-translator");
    vi.mocked(getServerTranslator).mockReturnValueOnce(real("en"));
    vi.mocked(readDashboardSnapshotCached).mockResolvedValueOnce({
      ...SNAPSHOT,
      body: {
        ...SNAPSHOT.body,
        briefingAi: aiUnavailable("user_disabled"),
      },
    } as never);
    vi.mocked(aiCapabilityToServe).mockResolvedValue(
      aiUnavailable("user_disabled"),
    );
    vi.mocked(computeCoincidentDeviation).mockResolvedValueOnce({
      status: "ok",
      value: {
        fired: false,
        contributing: [],
        day: "2026-07-17",
        illnessExplained: false,
        vitals: [
          {
            type: "BLOOD_GLUCOSE",
            value: 70,
            center: 86,
            low: 80,
            high: 92,
            outside: true,
            direction: "below",
            daysAgo: 0,
            basis: "sameHours",
          },
        ],
      },
    } as never);
    const digest = await loadDailyDigest(USER, NOW);
    expect(digest.lead?.source).toBe("signal");
    expect(digest.lead?.text).toMatch(/80 to 92 mg\/dL for this time of day/);
  });

  it("publishes how long the score has held", async () => {
    vi.mocked(readDashboardSnapshotCached).mockResolvedValueOnce({
      ...SNAPSHOT,
      body: {
        ...SNAPSHOT.body,
        healthScore: {
          score: 94,
          band: "GREEN",
          delta: null,
          deltaReason: "below_noise_floor",
        },
      },
    } as never);
    const rows = Array.from({ length: 22 }, (_, i) => ({
      dayKey: new Date(Date.parse("2026-07-17T12:00:00Z") - i * 86_400_000)
        .toISOString()
        .slice(0, 10),
      composite: 94,
      band: "GREEN",
      scoreVersion: 4,
      composition: ["BLOOD_PRESSURE"],
    }));
    vi.mocked(prisma.healthScoreRecord.findMany).mockResolvedValueOnce(
      rows as never,
    );
    const digest = await loadDailyDigest(USER, NOW);
    expect(digest.score?.steadyWeeks).toBe(3);
  });
});
