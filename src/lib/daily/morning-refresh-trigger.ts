/**
 * The sleep-arrival trigger for the morning digest refresh.
 *
 * The nightly insight pre-pass (`insight-pregenerate`, 04:30) runs before last
 * night's sleep has synced, so the morning digest + health score reference the
 * day WITHOUT the current sleep. This trigger closes that gap the event-driven
 * way: when a completed sleep segment for LAST NIGHT lands from any sleep
 * transport (Withings sync-sleep / the WHOOP sync / the Apple-Health
 * measurement batch / Google Health / Fitbit / Oura / Polar), it enqueues a debounced
 * `morning-digest-refresh` job that re-runs the sleep-dependent generation and
 * flips the day `provisional → final`.
 *
 * There is no single canonical sleep-persist function in the tree — each
 * transport upserts through its own helper — so every write seam calls
 * `maybeEnqueueMorningRefresh` with the measuredAt of every sleep row it just
 * wrote. The debounce (queue `singletonKey` + the `User.morningDigestRefreshedOn`
 * marker) collapses the many samples of one night, and across all sources,
 * into ONE refresh per user per local morning.
 *
 * Timezone correctness is load-bearing: "last night" is judged in the user's
 * PROFILE timezone, never UTC, so a 30-day backfill re-sync never re-triggers
 * for historical nights and a sleep that is "last night" locally but a
 * different UTC date still triggers.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { resolveModuleMap } from "@/lib/modules/gate";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { enqueueMorningDigestRefresh } from "@/lib/jobs/morning-digest-refresh-shared";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";

/**
 * True when `measuredAt` belongs to "last night" for an observer in `tz`: its
 * local calendar date is today or yesterday. An older backfilled segment (local
 * date ≥ 2 days ago) returns false, so a full WHOOP / Apple / Withings re-sync
 * that replays a month of nights never re-triggers the morning refresh for a
 * historical night. A future-dated sample (clock skew) is rejected too.
 *
 * Pure + timezone-explicit so the tz-boundary cases are unit-testable without
 * touching the DB or the queue.
 */
export function isLastNightLocal(
  measuredAt: Date,
  now: Date,
  tz: string,
): boolean {
  if (measuredAt.getTime() > now.getTime()) return false;
  const todayKey = userDayKey(now, tz);
  // The calendar day before today, not the day `now − 24 h` falls on: after
  // a 23-hour day the first local hour minus 24 hours lands two days back.
  const yesterdayKey = shiftDateKey(todayKey, -1);
  const segKey = userDayKey(measuredAt, tz);
  return segKey === todayKey || segKey === yesterdayKey;
}

/**
 * Enqueue the debounced morning refresh when at least one of the just-written
 * sleep segments belongs to last night in the user's profile timezone.
 *
 * Best-effort and self-contained: every read is wrapped so a failure can never
 * fail the sleep sync that called it. Callers still `void … .catch(() => {})`
 * for defence in depth.
 *
 * Gates, in order:
 *   1. No sleep rows → nothing to do.
 *   2. `sleep` module off → the digest is always `final` (no sleep to wait
 *      for), so a refresh would be pointless; no-op.
 *   3. No segment is "last night" locally → an old backfill; no-op.
 *   4. `User.morningDigestRefreshedOn` already equals today's local date → the
 *      refresh already ran this morning; skip the enqueue (the handler
 *      re-checks the same marker, so this only saves queue churn).
 */
export async function maybeEnqueueMorningRefresh(
  userId: string,
  sleepMeasuredAts: Date[],
  now: Date = new Date(),
): Promise<void> {
  try {
    // Gate 1 — nothing to refresh on. Every early return annotates a distinct
    // `reason` so a real landing shows exactly which gate fired (the gates were
    // silent before, so a "insight stuck on the nightly stamp" report could not
    // be traced to a gate without a code change).
    if (sleepMeasuredAts.length === 0) {
      annotate({
        action: { name: "daily.morning_refresh.skipped" },
        meta: { reason: "no_sleep_rows" },
      });
      return;
    }

    const modules = await resolveModuleMap(userId);
    if (modules.sleep === false) {
      annotate({
        action: { name: "daily.morning_refresh.skipped" },
        meta: { reason: "sleep_module_off" },
      });
      return;
    }

    const tz = await resolveUserTimezone(userId);
    const todayKey = userDayKey(now, tz);
    const hasLastNight = sleepMeasuredAts.some((at) =>
      isLastNightLocal(at, now, tz),
    );
    if (!hasLastNight) {
      // The most diagnostic gate: carry the samples' resolved LOCAL dates (up
      // to 5) alongside today's key + tz, so the next real landing tells us
      // exactly why `isLastNightLocal` rejected every segment (a tz mismatch, a
      // backfill of only-old nights, or a clock-skewed future sample).
      annotate({
        action: { name: "daily.morning_refresh.skipped" },
        meta: {
          reason: "not_last_night",
          today: todayKey,
          tz,
          sample_local_dates: sleepMeasuredAts
            .slice(0, 5)
            .map((at) => userDayKey(at, tz)),
        },
      });
      return;
    }

    const localDate = todayKey;

    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { morningDigestRefreshedOn: true },
    });
    if (row?.morningDigestRefreshedOn === localDate) {
      annotate({
        action: { name: "daily.morning_refresh.skipped" },
        meta: { reason: "already_refreshed", local_date: localDate },
      });
      return;
    }

    await enqueueMorningDigestRefresh({ userId, localDate });
    annotate({
      action: { name: "daily.morning_refresh.triggered" },
      meta: {
        local_date: localDate,
        sleep_samples: sleepMeasuredAts.length,
      },
    });

    // v1.31.0 — the sleep arm of the data-arrival spine.
    //
    // Sleep gets exactly ONE seam for all seven transports, right here, because
    // the four gates above ARE the sleep salience rules: module off, no rows,
    // not-last-night (the same tz-honest recency predicate the spine's
    // classifier generalises), already-refreshed. Reaching this line means the
    // arrival is salient by construction, so the seven sleep-write call sites
    // inherit the spine untouched and nothing is duplicated.
    //
    // It still routes through `emitDataArrival` rather than enqueuing directly:
    // the classifier agreeing a second time is free, and the uniform
    // `arrival.*` annotations are what make trigger volume comparable across
    // kinds.
    const newestSleepAt = sleepMeasuredAts.reduce((a, b) =>
      b.getTime() > a.getTime() ? b : a,
    );
    void emitDataArrival({
      userId,
      kind: "sleep_night",
      newestSampleAt: newestSleepAt,
      insertedCount: sleepMeasuredAts.length,
      source: "sleep",
      now,
    }).catch(() => {});
  } catch {
    // Never let a freshness trigger fail an ingest. The next sleep landing and
    // the nightly cron are the catch-net; the digest stays honestly
    // provisional until one of them refreshes it.
  }
}
