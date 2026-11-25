import { readDailyBriefing } from "@/lib/ai/briefing-blocks";
import { readBriefingGeneratedAt } from "@/lib/insights/briefing-generated-at";
import { userDayKey } from "@/lib/tz/format";

/**
 * v1.28.30 — does a cached comprehensive payload actually carry a daily
 * briefing?
 *
 * Shared by the generator's content-hash gate and the freshness rule below:
 * a fresh-but-briefingless cache must not satisfy a briefing-expecting
 * caller for the rest of the day (the "one silent nightly failure + 24 h
 * cache = a full day without a briefing" chain). Unparseable text counts as
 * briefingless — regeneration repairs it, and so does a briefing that fails
 * the shared reader (`readDailyBriefing`).
 *
 * Lives in its own leaf module (no provider-tree imports) so the route
 * can consume it without pulling the whole generation pipeline into its
 * bundle, and tests that mock `comprehensive-generate` keep the real
 * implementation.
 */
export function cachedPayloadCarriesBriefing(
  cachedText: string | null | undefined,
): boolean {
  if (!cachedText) return false;
  try {
    const parsed = JSON.parse(cachedText) as Record<string, unknown> | null;
    // A briefing the card cannot render is no briefing: counting it as one
    // let an unchanged snapshot keep re-stamping a malformed block forever.
    return readDailyBriefing(parsed?.dailyBriefing).state === "valid";
  } catch {
    return false;
  }
}

/** Whether a generation moment falls on today's calendar day in `timezone`. */
function generatedOnLocalToday(
  generatedAt: string | null,
  timezone: string,
  now: Date,
): boolean {
  return (
    generatedAt !== null &&
    userDayKey(new Date(generatedAt), timezone) === userDayKey(now, timezone)
  );
}

/** How long a cache write counts as current at most. */
const BRIEFING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The one rule for "the cached briefing is today's, for this reader": the
 * read-only advisor read decides on it whether to ask for a warm, and the
 * generating POST whether it may short-circuit. The two used to decide
 * separately, and the read looked only at timestamps and the language tag,
 * so a cached block the card could not render counted as fresh there and
 * no warm was asked for; the card sat on "No briefing yet" until the next
 * day.
 *
 * Current means all of: the slot is in the reader's language (an untagged
 * row predates the tag and counts as matching), it was written within the
 * last 24 h, its text was generated on the reader's calendar day (a warm
 * that only re-stamps yesterday's text moves `insightsCachedAt` but not the
 * generation moment), and it carries a briefing the shared reader accepts.
 */
export function cachedBriefingIsCurrent(args: {
  cachedText: string | null | undefined;
  cachedAt: Date | null | undefined;
  cachedLocale: string | null | undefined;
  locale: string;
  timezone: string;
  now: Date;
}): boolean {
  const { cachedText, cachedAt, cachedLocale, locale, timezone, now } = args;
  if (!cachedText || !cachedAt) return false;
  if (cachedLocale != null && cachedLocale !== locale) return false;
  if (now.getTime() - cachedAt.getTime() >= BRIEFING_CACHE_TTL_MS) {
    return false;
  }
  return (
    generatedOnLocalToday(readBriefingGeneratedAt(cachedText), timezone, now) &&
    cachedPayloadCarriesBriefing(cachedText)
  );
}
