import { readDailyBriefing } from "@/lib/ai/briefing-blocks";

/**
 * v1.28.30 — does a cached comprehensive payload actually carry a daily
 * briefing?
 *
 * Shared by the generator's content-hash gate and the POST route's 24 h
 * short-circuit: a fresh-but-briefingless cache must not satisfy a
 * briefing-expecting caller for the rest of the day (the "one silent
 * nightly failure + 24 h cache = a full day without a briefing" chain).
 * Unparseable text counts as briefingless — regeneration repairs it, and
 * so does a briefing that fails the shared reader (`readDailyBriefing`).
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
