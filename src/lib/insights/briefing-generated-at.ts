/**
 * When the cached briefing's content was written, as opposed to when the
 * cache row was last touched.
 *
 * `User.insightsCachedAt` moves on every warm, including the content-hash
 * short-circuit that keeps yesterday's text and only refreshes the stamp.
 * A "is this briefing from today?" check read off that column therefore
 * passed for text written the day before. The moment the content itself was
 * produced rides inside the cached payload instead, written only where new
 * text is written: a full generation (the warm and the on-demand route) and
 * the daily paragraph re-roll. The plain stamp refresh leaves it alone.
 *
 * A payload without the field predates it, and its age is unknown: the
 * readers treat it as not from today, which is the safe side (the hero falls
 * back to its own lead and a warm is asked for).
 */

/** The top-level key on the cached insight payload. */
export const BRIEFING_GENERATED_AT_KEY = "briefingGeneratedAt";

/** The payload with the generation moment set. */
export function withBriefingGeneratedAt<T extends object>(
  payload: T,
  at: Date,
): T & { [BRIEFING_GENERATED_AT_KEY]: string } {
  return { ...payload, [BRIEFING_GENERATED_AT_KEY]: at.toISOString() };
}

/**
 * The generation moment of a cached payload (an object or its stored JSON
 * text), or null when it carries none or does not parse.
 */
export function readBriefingGeneratedAt(payload: unknown): string | null {
  let value: unknown = payload;
  if (typeof payload === "string") {
    try {
      value = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object") return null;
  const at = (value as Record<string, unknown>)[BRIEFING_GENERATED_AT_KEY];
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
}
