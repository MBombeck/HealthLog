/**
 * The digest reads last night by the morning's rule (`resolveLastNight`), so
 * its `sleepPending` and phase cannot disagree with the morning beside it.
 *
 * The digest used to decide "in" from a rolling 24-hour window since the
 * newest sleep row (`daysAgo === 0`). A night that ended 23 h 40 min ago is
 * yesterday's, but the window called it last night: the digest settled the
 * day while the morning still waited for tonight's sleep.
 */
import { afterEach, describe, expect, it } from "vitest";

import { __resetAllCachesForTests, caches } from "@/lib/cache/server-cache";
import {
  lastNightFromSnapshot,
  morningExtrasCacheKey,
  peekMorningSleepScore,
} from "@/lib/daily/last-night";
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
      tz: TZ,
      todayKey: TODAY,
      sleepOn: true,
      morningRefreshedToday: false,
      sleepScore: null,
    });

    expect(lastNight.sleep).toBeNull();
    expect(lastNight.sleepPending).toBe(true);

    const digest = buildDailyDigest(digestInput(lastNight), t);
    expect(digest.sleepPending).toBe(true);
    expect(digest.phase).toBe("provisional");
  });

  it("counts the sleep score's night even when the snapshot still shows yesterday's row", () => {
    // The snapshot is cached apart from the sleep score: its newest row is
    // still yesterday's, while the score already describes tonight's night.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * MIN);
    const { lastNight } = lastNightFromSnapshot({
      snapshot: snapshotWithSleep(yesterday, 1),
      tz: TZ,
      todayKey: TODAY,
      sleepOn: true,
      morningRefreshedToday: false,
      sleepScore: {
        score: 84,
        band: "green",
        night: TODAY,
        asleepMinutes: 455,
      },
    });

    expect(lastNight.sleepPending).toBe(false);
    expect(lastNight.sleep?.minutes).toBe(455);

    const digest = buildDailyDigest(digestInput(lastNight), t);
    expect(digest.sleepPending).toBe(false);
    expect(digest.phase).toBe("final");
  });

  it("reads the sleep score from the morning's own cell, never computing one", () => {
    const modules = { sleep: true, recovery: true };
    expect(peekMorningSleepScore("u1", TODAY, modules)).toBeNull();

    const sleepScore = {
      score: 84,
      band: "green" as const,
      night: TODAY,
      asleepMinutes: 455,
    };
    caches.analytics.set(morningExtrasCacheKey("u1", TODAY, modules), {
      vitals: [],
      illnessExplained: false,
      readiness: null,
      sleepScore,
      deviceScores: [],
    });

    expect(peekMorningSleepScore("u1", TODAY, modules)).toEqual(sleepScore);
    // Another day's cell is not today's.
    expect(peekMorningSleepScore("u1", "2026-07-17", modules)).toBeNull();
    // With sleep off there is no night to read.
    expect(
      peekMorningSleepScore("u1", TODAY, { sleep: false, recovery: true }),
    ).toBeNull();
  });
});
