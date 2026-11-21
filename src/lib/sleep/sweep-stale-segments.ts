/**
 * Session-scoped sweep of stale sleep-segment rows.
 *
 * Wearables re-score a night after the fact (WHOOP re-scores, Withings
 * re-aggregates, Oura revises the hypnogram, Polar re-settles the stage
 * totals). Before the stable-externalId fix, a re-scored night minted FRESH
 * segment externalIds (positional indexes renumbered, boundaries shifted), so
 * the upsert inserted a second set of rows next to the first and the
 * night-total silently double-counted. The externalIds are stable now, but two
 * classes of orphans remain: rows a re-score genuinely dropped (a segment that
 * no longer exists in the fresh scoring) and every legacy row still keyed on
 * the old volatile format. This sweep clears both, so the id change self-heals
 * without a migration — the same posture as Google Health's
 * `replaceStaleGoogleHealthSleep`, expressed as an externalId-prefix bound
 * instead of a time-window bound because these integrations key every segment
 * row under a per-session externalId prefix.
 *
 * Safety contract (pinned by `__tests__/sweep-stale-segments.test.ts`):
 *   - Bounded to the sessions of THIS fetch — each entry sweeps only rows whose
 *     `externalId` starts with that one session's prefix. Never a blanket
 *     delete.
 *   - LIVE rows only (`deletedAt: null`), `SLEEP_DURATION` only, one source.
 *   - The fresh id set (`keepIds`) is never touched; an entry with no fresh ids
 *     is skipped entirely (a mapper hiccup must not wipe a night).
 *   - Soft-delete (`deletedAt = now`), never a hard remove.
 *   - Best-effort: a failed sweep warns and moves on — it never fails the
 *     user's sync. The session stays inside the integration's re-fetch window,
 *     so the next tick retries the sweep.
 */
import type { MeasurementSource } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { getEvent } from "@/lib/logging/context";

/** One just-fetched sleep session: its externalId prefix + the fresh ids. */
export interface SleepSegmentSweep {
  /**
   * The session-scoped externalId prefix (e.g. `<sleep-uuid>:` for WHOOP,
   * `withings:sleep:<user>:<sessionId>:` for Withings). Every live
   * `SLEEP_DURATION` row under it that is not in `keepIds` is considered a
   * re-score orphan or a legacy-format duplicate.
   */
  prefix: string;
  /** The fresh externalIds this fetch produced for the session — never swept. */
  keepIds: string[];
}

/**
 * Soft-delete every live `SLEEP_DURATION` row of `source` whose externalId
 * falls under one of the given session prefixes but was not re-produced by
 * this fetch. Returns the number of rows tombstoned.
 */
export async function sweepStaleSleepSegments(
  userId: string,
  source: MeasurementSource,
  sessions: SleepSegmentSweep[],
): Promise<number> {
  let removed = 0;
  for (const s of sessions) {
    // An empty prefix would unbound the sweep to the whole source; an empty
    // keep-set means this fetch produced nothing for the session (unscored /
    // mapper hiccup) — in both cases deleting would be data loss, so skip.
    if (!s.prefix || s.keepIds.length === 0) continue;
    try {
      const res = await prisma.measurement.updateMany({
        where: {
          userId,
          source,
          type: "SLEEP_DURATION",
          deletedAt: null,
          externalId: { startsWith: s.prefix, notIn: s.keepIds },
        },
        data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
      });
      removed += res.count;
    } catch (err) {
      getEvent()?.addWarning(
        `${source.toLowerCase()}: stale sleep-segment sweep failed for prefix ${s.prefix}: ${err}`,
      );
    }
  }
  // A tombstoned segment changes the nights the cached reads hold. The sweep
  // does not know how far back the swept rows reach, so every cached block
  // goes; it removes rows only when a session was re-scored, which is rare.
  if (removed > 0) invalidateUserMeasurements(userId);
  return removed;
}
