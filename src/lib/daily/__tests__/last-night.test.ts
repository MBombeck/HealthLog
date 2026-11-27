/**
 * The digest reads last night by the one rule (`resolveLastNight`), over the
 * same night the morning reads (`readLastNight`), so its `sleepPending` and
 * phase cannot disagree with the morning beside it.
 *
 * The digest used to decide "in" from a rolling 24-hour window since the
 * newest sleep row (`daysAgo === 0`). A night that ended 23 h 40 min ago is
 * yesterday's, but the window called it last night: the digest settled the
 * day while the morning still waited for tonight's sleep.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: { measurement: { findMany } } }));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn().mockResolvedValue(null),
}));

import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { lastNightFromSnapshot, readLastNight } from "@/lib/daily/last-night";
import { buildDailyDigest, type DailyDigestInput } from "@/lib/daily/digest";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

const t = getServerTranslator("en").t;
const TZ = "Europe/Berlin";
// 09:10 local on 2026-07-16.
const NOW = new Date("2026-07-16T07:10:00.000Z");
const TODAY = "2026-07-16";
const MIN = 60_000;

afterEach(() => {
  __resetAllCachesForTests();
});

function snapshotWithSleep(lastSeenAt: Date, daysAgo: number) {
  return {
    tiles: {
      lastSeenByType: {
        SLEEP_DURATION: { lastSeenAt: lastSeenAt.toISOString(), daysAgo },
      },
      summaries: { SLEEP_DURATION: { latest: 430, avg30: 445 } },
    },
  } as unknown as Parameters<typeof lastNightFromSnapshot>[0]["snapshot"];
}

function digestInput(
  lastNight: DailyDigestInput["lastNight"],
): DailyDigestInput {
  return {
    now: NOW,
    ai: DIGEST_AI_AVAILABLE,
    todayEndExclusive: new Date("2026-07-16T22:00:00.000Z"),
    modules: {},
    enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS],
    score: null,
    briefing: null,
    medsToday: {
      activeCount: 0,
      scheduledToday: 0,
      takenToday: 0,
      skippedToday: 0,
      nextDueAt: null,
      nextDueOverdue: false,
      nextDueMedicationName: null,
      nextDueMedicationId: null,
    },
    lastNight,
    syncIssues: [],
    preventiveDue: [],
    coachPlans: [],
    tensionWindow: null,
    todayLocalDate: TODAY,
    dismissedItemKeys: new Set<string>(),
  };
}

describe("last night in the digest", () => {
  it("waits for tonight when the newest night woke 23 h 40 min ago", () => {
    // Woke 09:30 yesterday: inside the rolling window, outside today.
    const wokeAt = new Date(NOW.getTime() - (23 * 60 + 40) * MIN);
    const { lastNight } = lastNightFromSnapshot({
      snapshot: snapshotWithSleep(wokeAt, 0),
      todayKey: TODAY,
      sleepOn: true,
      morningRefreshedToday: false,
      night: { night: "2026-07-15", asleepMinutes: 430 },
    });

    expect(lastNight.sleep).toBeNull();
    expect(lastNight.sleepPending).toBe(true);

    const digest = buildDailyDigest(digestInput(lastNight), t);
    expect(digest.sleepPending).toBe(true);
    expect(digest.phase).toBe("provisional");
  });

  it("counts the night read even when the snapshot still shows yesterday's row", () => {
    // The snapshot is cached apart from the night: its newest row is still
    // yesterday's, while the night read already has this morning's.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * MIN);
    const { lastNight } = lastNightFromSnapshot({
      snapshot: snapshotWithSleep(yesterday, 1),
      todayKey: TODAY,
      sleepOn: true,
      morningRefreshedToday: false,
      night: { night: TODAY, asleepMinutes: 455 },
    });

    expect(lastNight.sleepPending).toBe(false);
    expect(lastNight.sleep?.minutes).toBe(455);

    const digest = buildDailyDigest(digestInput(lastNight), t);
    expect(digest.sleepPending).toBe(false);
    expect(digest.phase).toBe("final");
  });

  it("never takes the snapshot's newest row for last night", () => {
    // A nap at 13:00 today is the snapshot's newest sleep row. Its calendar
    // day is today, but it is no night: last night is the night read.
    const nap = new Date("2026-07-16T11:00:00.000Z");
    const { lastNight } = lastNightFromSnapshot({
      snapshot: snapshotWithSleep(nap, 0),
      todayKey: TODAY,
      sleepOn: true,
      morningRefreshedToday: false,
      night: { night: "2026-07-15", asleepMinutes: 430 },
    });
    expect(lastNight.sleep).toBeNull();
    expect(lastNight.latestNightDay).toBe("2026-07-15");
  });
});

describe("readLastNight", () => {
  const row = (iso: string, value: number, timeZone: string | null = null) => ({
    value,
    measuredAt: new Date(iso),
    sleepStage: "ASLEEP",
    source: "APPLE_HEALTH",
    deviceType: null,
    timeZone,
  });

  it("passes over a nap and reads the main night", async () => {
    findMany.mockResolvedValueOnce([
      row("2026-07-15T05:00:00.000Z", 420),
      // A 40-minute nap at 13:00 local, after last night's.
      row("2026-07-16T11:20:00.000Z", 40),
    ]);
    // The nap counts in its day's total, but its day has no main sleep.
    expect(await readLastNight("u1", TZ, TODAY, NOW)).toEqual({
      night: "2026-07-15",
      asleepMinutes: 420,
    });
  });

  it("files a night slept abroad under its own zone's wake day", async () => {
    // Woke 06:30 in Tokyo on the 16th: 23:30 on the 15th in Berlin, the
    // profile zone, whose calendar would call it yesterday's night.
    findMany.mockResolvedValueOnce([
      row("2026-07-15T21:30:00.000Z", 430, "Asia/Tokyo"),
    ]);
    expect(await readLastNight("u1", TZ, TODAY, NOW)).toEqual({
      night: TODAY,
      asleepMinutes: 430,
    });
  });

  it("reads once per user and day: the morning and the digest share the cell", async () => {
    findMany.mockResolvedValue([row("2026-07-16T05:00:00.000Z", 400)]);
    const first = await readLastNight("u1", TZ, TODAY, NOW);
    const second = await readLastNight("u1", TZ, TODAY, NOW);
    expect(second).toEqual(first);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
