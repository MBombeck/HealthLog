/**
 * The anti-storm core of the arrival spine: a pure, timezone-honest recency
 * classifier that runs AT THE SEAM, before anything is enqueued.
 *
 * This is the one guardrail the whole spine rests on. Every ingest path in the
 * product is also a BACKFILL path: a ten-year Apple Health export, a WHOOP
 * re-sync after a token refresh, a 30-day catch-up after downtime, a `stats:`
 * overwrite storm from the iOS client. Without a recency test at the seam,
 * those would each turn into thousands of queued jobs and, downstream, provider
 * calls. With it, they emit exactly zero events: every sample fails the test
 * and is annotated, never enqueued.
 *
 * It generalizes `isLastNightLocal` (`@/lib/daily/morning-refresh-trigger`),
 * the predicate the S4 sleep trigger has already proven against real backfills,
 * to every arrival kind. Pure and timezone-explicit — no DB, no ambient clock —
 * so the timezone-boundary cases are unit-testable directly.
 */
import { userDayKey } from "@/lib/tz/format";
import { addDays } from "@/lib/cycle/day-math";
import type { ArrivalKind } from "./types";

/**
 * What the seam decided about a candidate arrival.
 *
 * - `salient` — new data from today or yesterday (locally); enqueue.
 * - `backfill` — historical or future-dated data; annotate and drop.
 * - `noop` — the write landed no new rows; annotate and drop.
 */
export type ArrivalClassification = "salient" | "backfill" | "noop";

export interface ClassifyArrivalInput {
  kind: ArrivalKind;
  /** The newest sample the write actually inserted. */
  newestSampleAt: Date;
  /** Rows INSERTED — an upsert that only updated values must pass 0 here. */
  insertedCount: number;
  now: Date;
  /** The user's PROFILE timezone. Never the server's, never UTC. */
  tz: string;
}

/**
 * Classify a candidate arrival. Deterministic and total — every input lands in
 * exactly one of the three buckets.
 *
 * Ordering matters:
 *
 * 1. `insertedCount <= 0` → `noop`. A pure re-sync or a `stats:` overwrite
 *    changed values but landed no new reading. Value changes already refresh
 *    the cards through `@/lib/insights/status-invalidation`; the spine reacts
 *    to NEW data only, so it must not fire here.
 * 2. Future-dated sample → `backfill`. Clock skew on a device, not news.
 *    Rejected the same way `isLastNightLocal` rejects it.
 * 3. Local calendar day older than yesterday → `backfill`. This is the test
 *    that makes a mass import free. "Older than yesterday" (rather than
 *    "older than today") is deliberate: a sleep night, and a late-evening
 *    workout synced after midnight, both belong to yesterday locally while
 *    still being the freshest thing the user has.
 * 4. Otherwise → `salient`.
 *
 * Kind is carried for readability and future per-kind rules, but every kind
 * shares the recency test today. The one per-kind refinement the spec calls for
 * — `weight` is salient only as the FIRST reading of the local day — is NOT
 * decided here: it needs a lookup, and the seam must stay free of reads. The
 * worker enforces it structurally instead, via the `ArrivalReaction` unique row
 * on `[userId, kind, localDate]`; a second weigh-in enqueues one cheap job that
 * de-duplicates against that row and fans nothing out.
 */
export function classifyArrival(
  input: ClassifyArrivalInput,
): ArrivalClassification {
  const { newestSampleAt, insertedCount, now, tz } = input;

  if (!Number.isFinite(insertedCount) || insertedCount <= 0) return "noop";
  if (
    !(newestSampleAt instanceof Date) ||
    Number.isNaN(newestSampleAt.getTime())
  )
    return "noop";

  if (newestSampleAt.getTime() > now.getTime()) return "backfill";

  const todayKey = userDayKey(now, tz);
  const yesterdayKey = addDays(todayKey, -1);
  const sampleKey = userDayKey(newestSampleAt, tz);

  if (sampleKey !== todayKey && sampleKey !== yesterdayKey) return "backfill";

  return "salient";
}
