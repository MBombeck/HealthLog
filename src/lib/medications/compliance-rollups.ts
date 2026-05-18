/**
 * v1.4.39 W-MED — persistent medication-compliance rollup tier.
 *
 * Replaces the unbounded `MedicationIntakeEvent.findMany` walk on
 * `/api/medications/intake?scope=compliance` with a ledger keyed
 * `(userId, medicationId, day)` where `day` is `YYYY-MM-DD` anchored
 * to the user's IANA timezone.
 *
 * Write hooks fire from every `MedicationIntakeEvent` mutation site
 * (create / update / delete / bulk import) plus the reminder-worker's
 * mint path that creates `takenAt:null` rows on RED-phase reminders.
 * Reads collapse the trailing N-day window into a single bounded
 * `findMany` against `medication_compliance_rollups`; the route-level
 * coverage probe falls back to live + fires a boot backfill when a
 * user has intake events but zero rollup rows.
 *
 * Audit anchor: `.planning/round-v1438-perf-analysis.md` §2.5 + §5 P4.
 */
import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  userDayKey,
} from "@/lib/tz/format";

/**
 * pg-boss queue name for the boot-time medication compliance backfill.
 * Mirrors the `rollup-full-backfill` v1.4.35.1 pattern: discovery is
 * idempotent across reboots and the worker upserts every
 * `(user, medication, day)` row for the trailing window.
 */
export const MEDICATION_COMPLIANCE_BACKFILL_QUEUE =
  "medication-compliance-full-backfill";

/** Worker concurrency cap — backfill stays serial to spare the pool. */
export const MEDICATION_COMPLIANCE_BACKFILL_CONCURRENCY = 1;

/** Trailing window the boot backfill folds per uncovered user. */
export const MEDICATION_COMPLIANCE_BACKFILL_DAYS = 90;

/** Payload `boss.send` carries onto the backfill queue. */
export interface MedicationComplianceBackfillPayload {
  userId: string;
  /** Wall-clock kick-off for debugging only. */
  enqueuedAt: string;
}

/** Reader-result row shape — matches `buildComplianceBuckets` output. */
export interface ComplianceBucket {
  /** YYYY-MM-DD in the user's tz. */
  date: string;
  scheduled: number;
  taken: number;
}

/**
 * Prisma client surface the helpers accept. Either the regular
 * `prisma` singleton or a `$transaction(tx)` argument — both expose
 * the `medicationIntakeEvent.findMany` + `medicationComplianceRollup.*`
 * methods we touch.
 */
type PrismaLike = typeof prisma | Prisma.TransactionClient;

/**
 * Compute the wall-clock components of `date` interpreted in `tz`.
 * Same shape as the cadence helper's `wallClockInTz`, lifted here so
 * the compliance module doesn't depend on a sibling-folder helper.
 */
function wallClockInTz(
  date: Date,
  tz: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
  };
}

/**
 * UTC offset (in minutes) of `tz` at the given instant. Positive east
 * of UTC. Honours DST via `Intl.DateTimeFormat`.
 */
function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const asIfUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    hour,
    Number(get("minute")),
    Number(get("second")),
  );
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

/**
 * The UTC instant corresponding to local-midnight on `dayKey` in `tz`.
 * Two-pass convergence handles DST transitions correctly.
 */
function startOfDayUtcInTz(dayKey: string, tz: string): Date {
  const [yearStr, monthStr, dayStr] = dayKey.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  let guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  for (let i = 0; i < 2; i++) {
    const offsetMin = tzOffsetMinutes(guess, tz);
    guess = new Date(
      Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMin * 60_000,
    );
  }
  return guess;
}

/**
 * Resolve a safe tz string — fall back to the server default when the
 * supplied value is missing or not an IANA zone the host recognises.
 */
function safeTimezone(tz: string | null | undefined): string {
  if (tz && isValidTimezone(tz)) return tz;
  return DEFAULT_TIMEZONE;
}

/**
 * Convert a `scheduledFor` UTC instant to the user's `YYYY-MM-DD`
 * day-key. Re-exposed so the write-hook caller can derive the same
 * `dayKey` the rollup row is anchored on.
 */
export function dayKeyForScheduledFor(
  scheduledFor: Date,
  tz: string | null | undefined,
): string {
  return userDayKey(scheduledFor, safeTimezone(tz));
}

/**
 * Recompute the rollup row for one `(userId, medicationId, dayKey)`
 * tuple. Reads every `MedicationIntakeEvent` whose `scheduledFor` lands
 * in `[startOfDayInTz, startOfNextDayInTz)` then upserts the
 * `medication_compliance_rollups` row.
 *
 * The hook is idempotent: re-running for the same key produces the
 * same row. When the day window holds zero events the row is deleted
 * so the read path returns the trailing-window zero-default rather
 * than a stale stub.
 *
 * `tx` accepts the `prisma.$transaction(tx)` client argument when the
 * parent write is transactional — passing the transaction client keeps
 * the rollup write inside the same transactional boundary.
 */
export async function recomputeMedicationComplianceForDay(
  userId: string,
  medicationId: string,
  dayKey: string,
  tz: string | null | undefined,
  tx?: PrismaLike,
): Promise<void> {
  const client = (tx ?? prisma) as PrismaLike;
  const safeTz = safeTimezone(tz);
  const start = startOfDayUtcInTz(dayKey, safeTz);
  const end = new Date(start.getTime() + 86_400_000);
  // Re-derive end via the day-after boundary to honour DST 23 / 25-hour
  // days. `start + 86_400_000` is correct for non-transition days; on
  // a fall-back day we add one calendar day in the local zone.
  const nextDayKey = (() => {
    const [y, m, d] = dayKey.split("-").map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const probeNext = new Date(probe.getTime() + 86_400_000);
    const parts = wallClockInTz(probeNext, safeTz);
    return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  })();
  const dstSafeEnd = startOfDayUtcInTz(nextDayKey, safeTz);
  const windowEnd = dstSafeEnd.getTime() > start.getTime() ? dstSafeEnd : end;

  // v1.4.39 hotfix (QA F-H-02): atomic upsert closes the race window
  // between the prior `SELECT … aggregate then UPSERT` pattern. Two
  // concurrent writes for the same (user, medication, day) used to
  // interleave A-SELECT → B-SELECT → B-UPSERT (correct) → A-UPSERT
  // (stale N-1). The INSERT … SELECT re-aggregates inside the upsert
  // statement so each write commits with a snapshot taken after the
  // prior commit released its row lock; the trailing DELETE handles
  // the "all events for the day were removed" case in the same shot.
  //
  // Both statements key on (user_id, medication_id, day) so they
  // serialise behind the row lock the rollup table's primary key
  // provides. The DELETE runs second so it cannot clobber a row the
  // INSERT just wrote — when the day still has events the
  // `WHERE NOT EXISTS` predicate matches zero rows.
  await client.$executeRaw`
    WITH aggregate AS (
      SELECT
        COUNT(*)::int                                                    AS scheduled,
        SUM(CASE WHEN "skipped" THEN 0 WHEN "taken_at" IS NOT NULL THEN 1 ELSE 0 END)::int AS taken,
        SUM(CASE WHEN "skipped" THEN 1 ELSE 0 END)::int                  AS skipped
      FROM "medication_intake_events"
      WHERE "user_id"        = ${userId}
        AND "medication_id"  = ${medicationId}
        AND "scheduled_for" >= ${start}
        AND "scheduled_for" <  ${windowEnd}
    )
    INSERT INTO "medication_compliance_rollups"
      ("user_id", "medication_id", "day", "scheduled", "taken", "skipped", "computed_at")
    SELECT
      ${userId},
      ${medicationId},
      ${dayKey},
      aggregate.scheduled,
      aggregate.taken,
      aggregate.skipped,
      NOW()
    FROM aggregate
    WHERE aggregate.scheduled > 0
    ON CONFLICT ("user_id", "medication_id", "day") DO UPDATE
      SET "scheduled"   = EXCLUDED."scheduled",
          "taken"       = EXCLUDED."taken",
          "skipped"     = EXCLUDED."skipped",
          "computed_at" = EXCLUDED."computed_at"
  `;
  await client.$executeRaw`
    DELETE FROM "medication_compliance_rollups"
    WHERE "user_id"       = ${userId}
      AND "medication_id" = ${medicationId}
      AND "day"           = ${dayKey}
      AND NOT EXISTS (
        SELECT 1
        FROM "medication_intake_events"
        WHERE "user_id"        = ${userId}
          AND "medication_id"  = ${medicationId}
          AND "scheduled_for" >= ${start}
          AND "scheduled_for" <  ${windowEnd}
      )
  `;
}

/**
 * Convenience hook for write-paths that have the `scheduledFor`
 * instant in hand. Derives `dayKey` in the user's tz then dispatches
 * to `recomputeMedicationComplianceForDay`. Best-effort: surfaces
 * failures through `annotate` + `console.error` so a silent populator
 * regression shows up in ops without blocking the parent write.
 */
export async function recomputeMedicationComplianceForEvent(input: {
  userId: string;
  medicationId: string;
  scheduledFor: Date;
  tz: string | null | undefined;
  tx?: PrismaLike;
}): Promise<void> {
  const dayKey = dayKeyForScheduledFor(input.scheduledFor, input.tz);
  try {
    await recomputeMedicationComplianceForDay(
      input.userId,
      input.medicationId,
      dayKey,
      input.tz,
      input.tx,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    annotate({
      meta: {
        medication_compliance_rollup_failed: true,
        medication_compliance_rollup_error: message,
      },
    });
    console.error(
      "[medication-compliance-rollups] recompute failed:",
      message,
    );
  }
}

/**
 * Read trailing `days` of compliance buckets for the user, oldest day
 * first. Returns the same `{date, scheduled, taken}` shape the legacy
 * `buildComplianceBuckets` helper produced so the route swap is
 * byte-identical.
 *
 * Days without a rollup row land as zero-filled buckets. The caller's
 * cache wrapper carries the user-tz in its key so a tz change forces
 * a fresh read.
 */
export async function readMedicationCompliance(
  userId: string,
  days: number,
  tz: string | null | undefined,
  now: Date = new Date(),
): Promise<ComplianceBucket[]> {
  const safeTz = safeTimezone(tz);

  // Build the expected day-key window oldest → newest so the response
  // is sorted and zero-filled regardless of which days hold rollups.
  const todayKey = userDayKey(now, safeTz);
  const expectedKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const probe = new Date(now.getTime() - i * 86_400_000);
    expectedKeys.push(userDayKey(probe, safeTz));
  }
  // Guard against a DST day-of-the-year landing the loop on the same
  // dayKey twice — dedup by Map insertion order.
  const dedup = new Set<string>();
  const orderedKeys: string[] = [];
  for (const key of expectedKeys) {
    if (!dedup.has(key)) {
      dedup.add(key);
      orderedKeys.push(key);
    }
  }
  // Always include today even if the trailing window dropped it (e.g.
  // days===1 on a DST boundary). Cheap defensive insert.
  if (!dedup.has(todayKey)) {
    orderedKeys.push(todayKey);
  }

  const oldestKey = orderedKeys[0];
  const newestKey = orderedKeys[orderedKeys.length - 1];

  const rows = await prisma.medicationComplianceRollup.findMany({
    where: {
      userId,
      day: { gte: oldestKey, lte: newestKey },
    },
    select: { day: true, scheduled: true, taken: true, skipped: true },
  });

  // Fold per-medication rows into one per-day total. The legacy route
  // shape was aggregated across all the user's medications; preserving
  // that surface keeps the front-end byte-stable.
  const totals = new Map<string, { scheduled: number; taken: number }>();
  for (const key of orderedKeys) {
    totals.set(key, { scheduled: 0, taken: 0 });
  }
  for (const row of rows) {
    const bucket = totals.get(row.day);
    if (!bucket) continue;
    bucket.scheduled += row.scheduled;
    bucket.taken += row.taken;
  }

  return orderedKeys.map((date) => {
    const bucket = totals.get(date) ?? { scheduled: 0, taken: 0 };
    return { date, scheduled: bucket.scheduled, taken: bucket.taken };
  });
}

/**
 * Returns true when the rollup tier covers every day inside the
 * trailing `days` window that has at least one intake event. Coverage
 * is full when the count of DISTINCT rolled days equals the count of
 * DISTINCT days that hold a `medication_intake_events` row in window —
 * partial coverage (boot backfill mid-fold on a multi-medication
 * account) returns false so the route falls through to the legacy
 * aggregator instead of serving zero-filled tiles for un-rolled days.
 *
 * v1.4.39 hotfix (QA F-H-01): the previous "any row exists" probe
 * could short-circuit to the rollup path while only the first few days
 * had been backfilled, exposing zero-filled tiles for the un-rolled
 * days until the boot fold completed.
 */
export async function hasMedicationComplianceCoverage(
  userId: string,
  days: number,
  tz: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  const safeTz = safeTimezone(tz);
  const oldestKey = userDayKey(
    new Date(now.getTime() - (days - 1) * 86_400_000),
    safeTz,
  );
  const oldestStart = startOfDayUtcInTz(oldestKey, safeTz);

  // Single SQL aggregate: count DISTINCT rolled days vs DISTINCT
  // event-days in window. The event side is anchored on the same
  // user-tz day-key (`to_char(... AT TIME ZONE $tz, 'YYYY-MM-DD')`) so
  // the comparison stays apples-to-apples even on DST boundaries.
  const result = await prisma.$queryRaw<
    Array<{ rolled_days: bigint; event_days: bigint }>
  >`
    SELECT
      (
        SELECT COUNT(DISTINCT "day")::bigint
        FROM "medication_compliance_rollups"
        WHERE "user_id" = ${userId}
          AND "day" >= ${oldestKey}
      ) AS rolled_days,
      (
        SELECT COUNT(DISTINCT to_char("scheduled_for" AT TIME ZONE ${safeTz}, 'YYYY-MM-DD'))::bigint
        FROM "medication_intake_events"
        WHERE "user_id" = ${userId}
          AND "scheduled_for" >= ${oldestStart}
      ) AS event_days
  `;
  if (result.length === 0) return true;
  const { rolled_days, event_days } = result[0];
  const rolled = Number(rolled_days);
  const events = Number(event_days);
  // Zero events in window → trivially covered (the read path produces
  // a zero-filled trailing window from the empty rollup table).
  if (events === 0) return true;
  return rolled >= events;
}

/**
 * Full-fold helper. Walks every `(medicationId, day)` pair the user
 * has logged across the trailing `days` window and upserts each
 * rollup row. The boot-time backfill worker calls this once per
 * uncovered user; the route's lazy fallback enqueues it when the
 * coverage probe returns false.
 *
 * Bounded SQL: one `DISTINCT (medicationId, dayKey)` $queryRaw scan
 * over the trailing window, then one upsert per row. The dayKey is
 * computed in Postgres via `to_char(... AT TIME ZONE $tz)` so we
 * don't have to ship millions of rows back to Node.
 */
export async function recomputeUserMedicationCompliance(
  userId: string,
  days: number = MEDICATION_COMPLIANCE_BACKFILL_DAYS,
  tz: string | null | undefined = null,
): Promise<{ rowsUpserted: number; durationMs: number }> {
  const startedAt = Date.now();
  const safeTz = safeTimezone(tz);

  const now = new Date();
  const oldestKey = userDayKey(
    new Date(now.getTime() - (days - 1) * 86_400_000),
    safeTz,
  );
  const oldestStart = startOfDayUtcInTz(oldestKey, safeTz);

  // Distinct (medication_id, dayKey) pairs the user has any intake
  // event for inside the trailing window. `to_char(... AT TIME ZONE
  // $tz)` keeps the day-bucket on the user's wall-clock.
  const pairs = await prisma.$queryRaw<
    Array<{ medication_id: string; day: string }>
  >`
    SELECT DISTINCT
      "medication_id",
      to_char("scheduled_for" AT TIME ZONE ${safeTz}, 'YYYY-MM-DD') AS "day"
    FROM "medication_intake_events"
    WHERE "user_id" = ${userId}
      AND "scheduled_for" >= ${oldestStart}
  `;

  let rowsUpserted = 0;
  for (const pair of pairs) {
    await recomputeMedicationComplianceForDay(
      userId,
      pair.medication_id,
      pair.day,
      safeTz,
    );
    rowsUpserted += 1;
  }

  return { rowsUpserted, durationMs: Date.now() - startedAt };
}

/**
 * Fire-and-forget warm-up — kept around for symmetry with
 * `ensureUserRollupsFresh` even though the on-write hook fully owns
 * coverage in steady state. The route currently doesn't call this
 * directly; the coverage-probe + boot-backfill cascade handles the
 * cold-mount case.
 */
export async function ensureUserMedicationComplianceFresh(
  userId: string,
  days: number = MEDICATION_COMPLIANCE_BACKFILL_DAYS,
  tz: string | null | undefined = null,
): Promise<{ recomputed: boolean }> {
  try {
    if (await hasMedicationComplianceCoverage(userId, days, tz)) {
      return { recomputed: false };
    }
    await recomputeUserMedicationCompliance(userId, days, tz);
    return { recomputed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    annotate({
      meta: {
        medication_compliance_rollup_refresh_failed: true,
        medication_compliance_rollup_refresh_error: message,
      },
    });
    console.error(
      "[medication-compliance-rollups] ensure-fresh failed:",
      message,
    );
    return { recomputed: false };
  }
}

/**
 * v1.4.39 hotfix (QA F-SEC-M-01) — user-scoped enqueue helper for the
 * request-path coverage-miss fallback.
 *
 * Mirrors `ensureUserMoodRollupsFresh`: the route fires this when its
 * coverage probe returned false so the caller's account picks up a
 * targeted boot-backfill job, instead of running a cluster-wide
 * `LEFT JOIN` over `medication_intake_events × medication_compliance_rollups`
 * on every authenticated coverage-miss request. The cluster-wide scan
 * was a soft DoS amplifier — an authenticated user iterating
 * coverage-miss requests could drive a multi-tenant table scan on
 * every hit.
 *
 * The boot-time discovery helper below stays cluster-wide (it runs
 * once per worker boot, not per request).
 */
export async function enqueueUserMedicationComplianceBackfill(
  userId: string,
): Promise<{ enqueued: boolean; error: string | null }> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: false, error: null };
  }
  try {
    const payload: MedicationComplianceBackfillPayload = {
      userId,
      enqueuedAt: new Date().toISOString(),
    };
    const jobId = await boss.send(
      MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
      payload,
      {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        singletonKey: `medication-compliance-boot-backfill|${userId}`,
      },
    );
    return { enqueued: jobId !== null && jobId !== undefined, error: null };
  } catch (err) {
    return {
      enqueued: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Boot-time enqueue helper — mirrors v1.4.35.1
 * `enqueueBootTimeRollupBackfill`. Finds users with intake events but
 * zero compliance-rollup coverage for the trailing window and enqueues
 * one full-fold per account onto `MEDICATION_COMPLIANCE_BACKFILL_QUEUE`.
 *
 * Idempotent across reboots: once an account has at least one rollup
 * row inside the trailing window the discovery query drops them.
 * pg-boss `singletonKey` coalesces duplicate sends.
 */
export async function enqueueBootTimeMedicationComplianceBackfill(): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // Trailing window cutoff for the existence probe — `scheduled_for`
    // older than this is not what the read path consults.
    const cutoff = new Date(
      Date.now() - MEDICATION_COMPLIANCE_BACKFILL_DAYS * 86_400_000,
    );
    const users = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT mie."user_id" AS id
      FROM "medication_intake_events" mie
      LEFT JOIN "medication_compliance_rollups" r
        ON r."user_id" = mie."user_id"
       AND r."medication_id" = mie."medication_id"
      WHERE mie."scheduled_for" >= ${cutoff}
        AND r."day" IS NULL
    `;

    if (users.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { id } of users) {
      const payload: MedicationComplianceBackfillPayload = {
        userId: id,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
        payload,
        {
          retryLimit: 3,
          retryDelay: 60,
          retryBackoff: true,
          singletonKey: `medication-compliance-boot-backfill|${id}`,
        },
      );
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
