/**
 * Coach check-in constants shared by BOTH the server-side digest builder and
 * the client Today surface + hooks.
 *
 * They live in this tiny, dependency-free module on purpose: `digest.ts` (their
 * former home) transitively reaches the database through the milestone/streak
 * baseline engine, so importing a constant from it would drag the whole server
 * builder — and the Postgres driver — into a client bundle (a Turbopack
 * `Can't resolve 'net'/'tls'/'dns'` build failure). Keeping the constants here
 * lets the Today hero and the check-in hook import them with zero server reach.
 */

/**
 * Days after a plan's activation / last review it becomes due for a look-back.
 * One source of truth for the digest builder AND the PATCH route that re-arms it.
 */
export const COACH_CHECKIN_REVIEW_DAYS = 7;

/**
 * Closed allowlist of the check-in card's two MUTATING intents. The generic,
 * id-less ask card (`today-asks.tsx`) forwards only a single `intent` string, so the target
 * plan id is appended after the ":" — the Today handler recovers it and PATCHes
 * the existing plan-lifecycle route. "Adjust" is navigation (an `href` into the
 * coach), so it carries no plan id and never mutates.
 */
export const COACH_CHECKIN_KEEP_INTENT = "coach.checkin.keep";
export const COACH_CHECKIN_LETGO_INTENT = "coach.checkin.letGo";
export const COACH_CHECKIN_ADJUST_INTENT = "coach.checkin.adjust";
