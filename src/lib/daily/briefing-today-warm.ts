/**
 * Ask for a briefing written today, at the two moments the rule "a signal
 * of the day rests on today's readings" needs one.
 *
 *   - The day has no briefing yet. The nightly warm runs at 04:30 in Berlin,
 *     which is the previous evening in Los Angeles and the middle of the day
 *     in Seoul; a briefing written then is from an earlier day on the
 *     reader's calendar, and is not served. The first read of the reader's
 *     day asks for one.
 *   - A signal metric got its first reading of the day after the briefing
 *     was written. The briefing is otherwise only written at the nightly
 *     warm, the post-sleep morning refresh or a day-old page open, so a
 *     morning blood pressure or weigh-in would never become a signal.
 *
 * Both are read off the snapshot every surface already reads (the dashboard,
 * iOS, the digest and the morning push), so no write path needs a hook. Each
 * reason is claimed once per user per local day in a Postgres bucket (and
 * remembered in-process, so a claimed reason costs no query on later reads);
 * a newly claimed reason enqueues one today warm. What that warm may spend is
 * bounded where every forced warm is bounded: the singleton window, the
 * failure backoff, the daily forced-warm cap, and the generation's
 * content-hash gate, which writes no new text without new data.
 */
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { userDayKey } from "@/lib/tz/format";
import { SIGNAL_READING_TYPE } from "@/lib/daily/briefing-today";
import { enqueueTodayBriefingWarm } from "@/lib/jobs/insight-pregenerate-shared";

/** A claim outlives the longest local day (a 25 h DST day) with margin. */
const CLAIM_WINDOW_MS = 36 * 60 * 60 * 1000;

/** In-process memory of claimed reasons, so a claimed one costs no query. */
const claimed = new Map<string, true>();
const CLAIMED_MAX = 10_000;

export interface TodayWarmInput {
  userId: string;
  locale: Locale;
  timezone: string;
  /** When the cached briefing's text was generated, or null when unknown. */
  generatedAt: string | null;
  /** The newest reading of a measurement type (ISO), or null when none. */
  lastSeenAt: (type: string) => string | null;
  now: Date;
}

/**
 * Why a briefing for today is due, if it is: `day` when no briefing was
 * written today, `reading:<TYPE>` for each signal reading type measured
 * today after the briefing was written. Empty when the briefing already
 * covers the day.
 */
export function todayWarmReasons(input: TodayWarmInput): string[] {
  const today = userDayKey(input.now, input.timezone);
  const generatedMs =
    input.generatedAt === null ? null : Date.parse(input.generatedAt);
  const reasons: string[] = [];
  if (
    generatedMs === null ||
    userDayKey(new Date(generatedMs), input.timezone) !== today
  ) {
    reasons.push("day");
  }
  for (const type of new Set(Object.values(SIGNAL_READING_TYPE))) {
    const at = input.lastSeenAt(type);
    if (at === null) continue;
    const atMs = Date.parse(at);
    if (userDayKey(new Date(atMs), input.timezone) !== today) continue;
    if (generatedMs !== null && atMs <= generatedMs) continue;
    reasons.push(`reading:${type}`);
  }
  return reasons;
}

/** Claim a reason for the day; true only for the first claim. */
async function claimOnce(key: string): Promise<boolean> {
  if (claimed.has(key)) return false;
  if (claimed.size >= CLAIMED_MAX) claimed.clear();
  claimed.set(key, true);
  try {
    const result = await checkRateLimit(key, 1, CLAIM_WINDOW_MS);
    return result.allowed;
  } catch {
    // A failed claim asks again on a later read rather than never.
    claimed.delete(key);
    return false;
  }
}

/**
 * Enqueue a today warm when a reason is due and not yet claimed today.
 * Fire-and-forget from the read path: it never throws and never delays the
 * read beyond the claim query.
 */
export async function requestTodayBriefingWarm(
  input: TodayWarmInput,
): Promise<void> {
  const reasons = todayWarmReasons(input);
  if (reasons.length === 0) return;
  const today = userDayKey(input.now, input.timezone);
  const fresh: string[] = [];
  for (const reason of reasons) {
    if (await claimOnce(`briefing-today:${input.userId}:${today}:${reason}`)) {
      fresh.push(reason);
    }
  }
  if (fresh.length === 0) return;
  annotate({
    action: { name: "daily.briefing.today_warm_requested" },
    meta: { reasons: fresh.join(","), timezone: input.timezone },
  });
  await enqueueTodayBriefingWarm({
    userId: input.userId,
    locale: input.locale,
    // Nobody waits on a burst of readings when the day simply has no
    // briefing yet; a reading waits out its burst so one warm reads it all.
    immediate: fresh.every((reason) => reason === "day"),
  });
}

/** Test seam: forget the in-process claims. */
export function __resetTodayWarmClaimsForTests(): void {
  claimed.clear();
}
