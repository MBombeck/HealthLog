/**
 * v1.17.0 — Polar AccessLink sync.
 *
 * Pulls Nightly Recharge (→ RECOVERY_SCORE / ANS_CHARGE / HRV / RHR /
 * respiratory rate), sleep (per-stage durations on a reconstructed END-instant
 * timeline + sleep score), daily activity (steps + active energy + distance),
 * Training Load Pro (→ CARDIO_LOAD), and SpO2 (→ OXYGEN_SATURATION) for one
 * connected user, mapping each into `Measurement` rows tagged `source = POLAR`.
 *
 * Token model: Polar tokens do not expire and have no refresh path, so there is
 * no `getValidToken` refresh dance (the WHOOP shape). A revoked grant surfaces
 * as a 401 → `reauth_required` on the shared integration ledger (`polar` key),
 * exactly like Nightscout's token-rejected path.
 *
 * Isolation: the five vitals collections are settled independently
 * (`Promise.allSettled`), so a single dead collection imports the healthy four
 * and records ONE partial failure rather than blanking every collection.
 * Mirrors Oura's shipped per-collection isolation, minus the token-refresh leg
 * Polar structurally lacks (a 401 is just a per-collection failure the
 * classifier maps to `reauth_required`).
 *
 * A 403 on one collection while a sibling succeeded is a refusal, not a
 * failure (`isPolarCollectionRefusal`): the same token just worked, so the
 * account simply does not share that data type (SpO2 without the sensor,
 * cardio load without the tier). Counting it as `reauth_required` put a
 * working connection behind a "reconnect" prompt that no reconnect clears.
 * The refused names ride the wide event; the leg records success. Mirrors
 * Oura's handling of a scope the grant does not cover.
 *
 * Window contract: every hourly tick re-reads the full server-fixed window for
 * each collection — 28 days for recharge / sleep / activity / cardio-load /
 * SpO2 (there is no narrower request and no pagination on any of them). A
 * late-synced device, a re-scored night, or a HealthLog outage shorter than the
 * window all self-heal on the next tick with no cursor or watermark. History
 * older than the window is an upstream cap, not a HealthLog gap. See the
 * client's per-fetcher docstrings for the verified per-endpoint windows.
 *
 * Idempotency: each row's `externalId` is `<date>:<fieldTag>`. The shared
 * reconciler protects both external and natural identity. Polar re-scores a
 * night for a short window after the fact, so an exact re-post overwrites in
 * place (WHOOP-style re-score), not first-write-wins.
 *
 * The measurement-write tail (per-row upsert → rollup fold → status-insight
 * invalidate) mirrors the shared WHOOP / Nightscout sync tail; it is NOT a new
 * write path.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  recordSyncFailure,
  recordSyncSuccess,
  toFailureKind,
  type FailureKind,
} from "@/lib/integrations/status";
import { afterProviderWrite } from "@/lib/integrations/sync-kit/after-write";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import type { SyncWriteResult } from "@/lib/outcome/written-outcome";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import type { InsertedMeasurementArrivalRow } from "@/lib/arrivals/measurement-emit";
import {
  MeasurementReconciliationError,
  reconcileExternalMeasurement,
} from "@/lib/measurements/reconcile-external-measurement";
import {
  fetchActivities,
  fetchCardioLoads,
  fetchNightlyRecharges,
  fetchSleeps,
  fetchSpo2,
} from "./client";
import {
  mapActivity,
  mapCardioLoad,
  mapNightlyRecharge,
  mapSleep,
  mapSpo2,
  type MappedMeasurement,
} from "./map";
import {
  sweepStaleSleepSegments,
  type SleepSegmentSweep,
} from "@/lib/sleep/sweep-stale-segments";
import { getPolarConnection } from "./credentials";
import {
  PolarApiError,
  classifyPolarError,
  isPolarCollectionRefusal,
} from "./response-classifier";
import { resolveUserTimezone } from "@/lib/tz/resolver";

/** Map a Polar error onto the shared integration-ledger failure kind. */
export function classifyPolarFailure(err: unknown): FailureKind {
  return toFailureKind(classifyPolarError(err));
}

/**
 * Record a Polar vitals-leg sync failure on the shared `polar` ledger with the
 * correct classification + HTTP code. Extracted so the poll-cohort boundary can
 * record a future escape with the SAME provider-owned classification the inline
 * catch already applies.
 */
export const POLAR_LEG_VITALS = "vitals";

export async function recordPolarSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  await recordSyncFailure({
    userId,
    integration: "polar",
    leg: POLAR_LEG_VITALS,
    kind: classifyPolarFailure(err),
    message: err instanceof Error ? err.message : String(err),
    errorCode:
      err instanceof PolarApiError && err.httpStatus != null
        ? String(err.httpStatus)
        : undefined,
  });
}

/** One mapped reading with its `externalId` resolved. */
export interface PolarMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED" | null;
}

function toUpsert(
  mapped: MappedMeasurement[],
  resourcePrefix: string,
): PolarMeasurementUpsert[] {
  return mapped.map((m) => ({
    type: m.type,
    value: m.value,
    unit: m.unit,
    measuredAt: m.measuredAt,
    // Reconstructed sleep segments supply their own indexed externalId so the
    // several rows of one night stay distinct; everything else keys on
    // `<resource>:<date>:<fieldTag>` — stable across re-syncs of the same day.
    // A date-keyed row names its date (`day`): its instant is local noon in
    // the user's zone, which east of UTC+12 falls on the previous UTC date.
    // A timed row keys on its instant's UTC date, as it always has.
    externalId:
      m.externalId ??
      // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: timed rows keep their historical UTC-date externalId so re-syncs upsert (see the comment above)
      `${resourcePrefix}:${m.day ?? m.measuredAt.toISOString().slice(0, 10)}:${m.fieldTag}`,
    sleepStage: m.sleepStage ?? null,
  }));
}

/** One Polar vitals collection: its ledger name (which doubles as the
 * externalId resource prefix) and a self-contained fetch+map closure that
 * resolves to the collection's mapped upserts. Each closure owns its own client
 * call and mapper so a throw — a failing fetch OR a throwing mapper — is
 * contained to this one collection under `Promise.allSettled`. */
interface PolarCollectionSpec {
  name: string;
  collect: (token: string) => Promise<PolarMeasurementUpsert[]>;
}

/** A single collection that failed to fetch/map, carried so the caller can
 * classify + record ONE partial failure without blanking the collections that
 * did succeed. */
export interface PolarCollectionFailure {
  name: string;
  err: unknown;
}

/** The vitals leg's outcome, plus whether any collection proved the token. */
export interface PolarVitalsResult extends SyncWriteResult {
  /**
   * True when at least one collection read succeeded with the token, so a 403
   * elsewhere in this run (the workouts leg included) is a per-type refusal.
   */
  tokenProven: boolean;
}

/**
 * Sync one user's Polar data. Returns the rows written AND whether a
 * collection did not settle — the bare count used to narrow the partial away,
 * so a run whose every collection failed answered the same `0` as a quiet
 * night. A user with no Polar connection is a clean no-op (nothing imported,
 * nothing failed, no status row touched).
 *
 * The five vitals collections are settled independently: the healthy ones
 * import, a failing one is recorded as a single partial failure (no success
 * stamp), and nothing is rethrown for a fetch/map failure. The only throw that
 * escapes now is a write-path/unexpected error out of `upsertPolarMeasurements`
 * — the poll-cohort boundary records that unmarked escape once.
 */
export async function syncUserPolar(
  userId: string,
): Promise<PolarVitalsResult> {
  const conn = await getPolarConnection(userId);
  if (!conn) return { imported: 0, failed: false, tokenProven: false };
  // Date-keyed rows are anchored at local noon of their date in this zone.
  const tz = await resolveUserTimezone(userId);

  // Filled by the sleep collection's closure as it maps records; carried so the
  // caller can run the record-scoped sweep before the upsert. A collection that
  // throws pushes nothing (the fetch is its first await), so a failed sleep
  // collection leaves the sweep list empty and no rows are tombstoned.
  const sleepSweeps: SleepSegmentSweep[] = [];

  const collections: PolarCollectionSpec[] = [
    {
      name: "recharge",
      collect: async (t) =>
        (await fetchNightlyRecharges(t)).flatMap((r) =>
          toUpsert(mapNightlyRecharge(r, tz), "recharge"),
        ),
    },
    {
      name: "sleep",
      collect: async (t) => {
        const records = await fetchSleeps(t);
        const rowsOut: PolarMeasurementUpsert[] = [];
        for (const s of records) {
          const rows = toUpsert(mapSleep(s, tz), "sleep");
          rowsOut.push(...rows);
          // Night-scoped sweep entry: the reconstructed segments of this date
          // all key under `sleep:<date>:seg:` (mapper-supplied). Any live row
          // under that prefix this fetch did NOT re-produce is a re-score
          // orphan or a legacy `:seg:<tag>:<i>` indexed row — tombstoned
          // before the upsert. The prefix deliberately stays on `:seg:` — the
          // IN_BED envelope keys on its measuredAt's UTC date, which can drift
          // a calendar day from `s.date`, so a broader `sleep:<date>:` bound
          // could cross nights.
          sleepSweeps.push({
            prefix: `sleep:${s.date}:seg:`,
            keepIds: rows
              .filter((r) => r.type === "SLEEP_DURATION")
              .map((r) => r.externalId),
          });
        }
        return rowsOut;
      },
    },
    {
      name: "activity",
      collect: async (t) =>
        (await fetchActivities(t)).flatMap((a) =>
          toUpsert(mapActivity(a, tz), "activity"),
        ),
    },
    {
      name: "cardioload",
      collect: async (t) =>
        (await fetchCardioLoads(t)).flatMap((c) =>
          toUpsert(mapCardioLoad(c, tz), "cardioload"),
        ),
    },
    {
      name: "spo2",
      collect: async (t) =>
        (await fetchSpo2(t)).flatMap((s) => toUpsert(mapSpo2(s), "spo2")),
    },
  ];

  // Isolate each collection: a rejection is captured per-collection, never
  // propagated, so one dead collection no longer blanks the healthy siblings.
  const settled = await Promise.allSettled(
    collections.map((spec) => spec.collect(conn.accessToken)),
  );
  const readings: PolarMeasurementUpsert[] = [];
  const settledFailures: PolarCollectionFailure[] = [];
  settled.forEach((res, i) => {
    const spec = collections[i]!;
    if (res.status === "fulfilled") {
      readings.push(...res.value);
    } else {
      settledFailures.push({ name: spec.name, err: res.reason });
    }
  });
  const tokenProven = settled.some((res) => res.status === "fulfilled");
  const { failures, refused } = splitPolarRefusals(
    settledFailures,
    tokenProven,
  );
  if (refused.length > 0) {
    annotate({ meta: { polar_collections_refused: refused } });
  }

  // Clear whatever an earlier scoring left under the re-fetched nights before
  // the fresh set upserts (mirrors Google Health's replace-by-window order).
  // Best-effort inside the helper — a sweep failure never fails the sync.
  await sweepStaleSleepSegments(userId, "POLAR", sleepSweeps);

  let insertedSleepMeasuredAts: Date[] = [];
  const imported = await upsertPolarMeasurements(userId, readings, {
    onInserted: (rows) => {
      insertedSleepMeasuredAts = rows
        .filter((row) => row.type === "SLEEP_DURATION")
        .map((row) => row.measuredAt);
    },
  });

  // Trigger the debounced morning refresh on a last-night segment landing
  // (mirrors the Withings / WHOOP / Apple seams). Fires whether or not a
  // sibling collection failed, since the sleep readings were still imported.
  void maybeEnqueueMorningRefresh(userId, insertedSleepMeasuredAts).catch(
    () => {},
  );

  // Background-sync posture: mark the analytics cells stale (never hard-evict
  // from a poll) so the imported rows reach the cached readers. Fires on a
  // partial failure too — rows that DID land must not stay invisible for the
  // rest of the TTL window.
  if (imported > 0) {
    invalidateUserMeasurements(userId);
  }

  if (failures.length > 0) {
    // Partial failure: import what the healthy collections returned, but keep
    // the cycle honest — record ONE failure and do NOT stamp success, so the
    // freshness surface reflects that some collections are behind and the next
    // tick refetches them rather than showing green. Mirrors Oura's
    // partial-failure ledger block; the record is inline (not
    // `recordPolarSyncFailure`) because it needs the `partial sync failure
    // (<names>)` message prefix — the R6 recorder's boundary contract stays
    // frozen. No rethrow: a rethrow would suppress the cohort's users_synced /
    // reminder-satisfy accounting for a user whose data DID land.
    const firstErr = failures[0]!.err;
    const names = failures.map((f) => f.name).join(", ");
    getEvent()?.addWarning(
      `polar: ${failures.length} collection(s) failed for ${userId}: ${names}`,
    );
    await recordSyncFailure({
      userId,
      integration: "polar",
      leg: POLAR_LEG_VITALS,
      kind: classifyPolarFailure(firstErr),
      message: `partial sync failure (${names}): ${
        firstErr instanceof Error ? firstErr.message : String(firstErr)
      }`,
      errorCode:
        firstErr instanceof PolarApiError && firstErr.httpStatus != null
          ? String(firstErr.httpStatus)
          : undefined,
    });
    return { imported, failed: true, tokenProven };
  }

  await recordSyncSuccess(userId, "polar", { leg: POLAR_LEG_VITALS });
  return { imported, failed: false, tokenProven };
}

/**
 * Split a run's collection failures into the ones that count and the per-type
 * refusals (a 403 while another read proved the token). Without a proof every
 * failure counts: a 403 on every collection is the account-wide consent gap.
 */
export function splitPolarRefusals(
  failures: PolarCollectionFailure[],
  tokenProven: boolean,
): { failures: PolarCollectionFailure[]; refused: string[] } {
  if (!tokenProven) return { failures, refused: [] };
  return {
    failures: failures.filter((f) => !isPolarCollectionRefusal(f.err)),
    refused: failures
      .filter((f) => isPolarCollectionRefusal(f.err))
      .map((f) => f.name),
  };
}

/**
 * Upsert a batch of mapped Polar readings, then fold the rollup tier +
 * invalidate status-insight caches once at the end (mirrors the WHOOP /
 * Nightscout sync tail). The shared reconciler protects both external and
 * natural identity; an exact re-post overwrites in place. Best-effort on the
 * rollup fold.
 */
export async function upsertPolarMeasurements(
  userId: string,
  readings: PolarMeasurementUpsert[],
  opts: {
    onInserted?: (rows: InsertedMeasurementArrivalRow[]) => void;
  } = {},
): Promise<number> {
  if (readings.length === 0) return 0;

  let imported = 0;
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
  const insertedRows: Array<
    InsertedMeasurementArrivalRow & { externalId: string | null }
  > = [];

  const verdicts = await prisma.$transaction(
    async (tx) => {
      const outcomes = [];
      for (const r of readings) {
        const verdict = await reconcileExternalMeasurement(
          tx,
          {
            userId,
            type: r.type as MeasurementType,
            source: "POLAR",
            value: r.value,
            unit: r.unit,
            measuredAt: r.measuredAt,
            externalId: r.externalId,
            sleepStage: r.sleepStage ?? null,
          },
          { exactExternalMatch: "update" },
        );
        if (verdict.status === "failed") {
          throw new MeasurementReconciliationError(verdict);
        }
        outcomes.push(verdict);
      }
      return outcomes;
    },
    { timeout: 60_000 },
  );

  for (let index = 0; index < readings.length; index++) {
    const reading = readings[index]!;
    const verdict = verdicts[index]!;
    // Refused by the plausibility gate: nothing was written and nothing was
    // touched, so the reading counts as neither imported nor a rollup dirt
    // mark. The drop is already on the wide event.
    if (verdict.status === "rejected_range") continue;
    for (const dirty of verdict.dirtyIdentities ?? []) {
      touched.push(dirty);
    }
    const type = reading.type as MeasurementType;
    imported++;
    touched.push({ type, measuredAt: reading.measuredAt });
    if (verdict.status === "inserted") {
      insertedRows.push(verdict.row);
    }
  }

  opts.onInserted?.(insertedRows);
  await afterProviderWrite({
    userId,
    provider: "polar",
    touched,
    arrivals: { rows: insertedRows, source: "polar" },
  });

  return imported;
}
