/**
 * Per-type HealthKit arrival ledger (v1.42, #1173).
 *
 * The batch route records, per measurement type it received, when the type
 * last arrived, under which `syncTrigger`, and when it last brought a new or
 * updated sample (as opposed to duplicates only). The Apple Health card reads
 * it to show which types are actually flowing. A scoped ingest credential
 * does not write it, the same rule as `lastSyncedAt`.
 *
 * Sample time (`max(measuredAt)`, what the freshness list showed before) and
 * arrival time are different questions. A type the phone only hands over
 * when someone taps "Sync all" can carry a reading from this morning and
 * still never have arrived in the background; only the arrival time and the
 * trigger that carried it can show that.
 */
import type { MeasurementType, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { logCaught } from "@/lib/logging/signal";
import {
  WORKOUT_FRESHNESS_TYPE,
  type MetricFreshnessEntry,
} from "./sync-verdict";

export type HealthKitSyncTrigger =
  "foreground" | "background" | "push" | "manual";

const TRIGGERS: ReadonlySet<string> = new Set<HealthKitSyncTrigger>([
  "foreground",
  "background",
  "push",
  "manual",
]);

/** What one batch did for one type. */
export interface HealthKitTypeArrival {
  /** Entries of this type the batch accepted (inserted, updated or duplicate). */
  accepted: number;
  /** Entries of this type that were inserted or updated. */
  newSamples: number;
}

/**
 * One statement for the whole batch (`unnest` over at most a few dozen
 * types). `last_received_at` and `last_trigger` describe the latest batch
 * that carried the type, so they are overwritten; `last_new_sample_at` only
 * moves when this batch brought something new, so a duplicates-only re-send
 * keeps the earlier date standing.
 *
 * Best effort: the ledger is a diagnostic beside rows that are already
 * written, so a failure here leaves a `warn` line and never fails the ingest.
 */
export async function recordHealthKitTypeArrivals(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    counts: ReadonlyMap<MeasurementType, HealthKitTypeArrival>;
    trigger: HealthKitSyncTrigger | null;
    at?: Date;
  },
): Promise<void> {
  const types: string[] = [];
  const brought: boolean[] = [];
  for (const [type, arrival] of input.counts) {
    if (arrival.accepted <= 0) continue;
    types.push(type);
    brought.push(arrival.newSamples > 0);
  }
  if (types.length === 0) return;
  // An ISO string cast in SQL, not a JS `Date`: a Date parameter is
  // serialised in the process's local zone and these are zone-less UTC
  // columns (same reasoning as the access-token sunset in refresh-token.ts).
  const at = (input.at ?? new Date()).toISOString();
  try {
    await tx.$executeRaw`
      INSERT INTO "healthkit_type_syncs"
        ("user_id", "type", "last_received_at", "last_trigger", "last_new_sample_at")
      SELECT ${input.userId}, u.t::"measurement_type",
             ${at}::timestamptz AT TIME ZONE 'UTC', ${input.trigger},
             CASE WHEN u.n THEN ${at}::timestamptz AT TIME ZONE 'UTC' END
      FROM unnest(${types}::text[], ${brought}::boolean[]) AS u(t, n)
      ON CONFLICT ("user_id", "type") DO UPDATE SET
        "last_received_at" = EXCLUDED."last_received_at",
        "last_trigger" = EXCLUDED."last_trigger",
        "last_new_sample_at" = COALESCE(
          EXCLUDED."last_new_sample_at",
          "healthkit_type_syncs"."last_new_sample_at"
        )
    `;
  } catch (error) {
    logCaught("healthkit.type_sync.record_failed", error, {
      types: types.length,
    });
  }
}

/** One type's arrival facts, as the Apple Health status read serves them. */
export interface HealthKitTypeArrivalRecord {
  lastReceivedAt: string;
  lastTrigger: HealthKitSyncTrigger | null;
  lastNewSampleAt: string | null;
}

/**
 * Every recorded type for one account, keyed by `MeasurementType`. A stored
 * trigger outside the known set (none is written, but the column is text)
 * reads as null rather than reaching the client as an unknown label.
 */
export async function getHealthKitTypeArrivals(
  userId: string,
): Promise<Map<string, HealthKitTypeArrivalRecord>> {
  const rows = await prisma.healthKitTypeSync.findMany({
    where: { userId },
    select: {
      type: true,
      lastReceivedAt: true,
      lastTrigger: true,
      lastNewSampleAt: true,
    },
  });
  const out = new Map<string, HealthKitTypeArrivalRecord>();
  for (const row of rows) {
    out.set(row.type, {
      lastReceivedAt: row.lastReceivedAt.toISOString(),
      lastTrigger:
        row.lastTrigger && TRIGGERS.has(row.lastTrigger)
          ? (row.lastTrigger as HealthKitSyncTrigger)
          : null,
      lastNewSampleAt: row.lastNewSampleAt?.toISOString() ?? null,
    });
  }
  return out;
}

/**
 * The newest instant Apple Health data is known to have reached the account:
 * the live-batch stamp, the per-type arrival ledger, or — for rows that came
 * any other way, such as the export.zip import — the newest stored sample.
 * Null only when none of the three holds anything, which is the one case the
 * status may honestly call "waiting for first data".
 */
export function newestAppleHealthDataAt(
  lastSyncedAt: string | null,
  arrivals: Map<string, HealthKitTypeArrivalRecord> | null,
  samples: readonly { lastSeenAt: string }[],
): string | null {
  let newest: number | null = null;
  const consider = (value: string | null | undefined) => {
    if (!value) return;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  };
  consider(lastSyncedAt);
  for (const arrival of arrivals?.values() ?? []) {
    consider(arrival.lastReceivedAt);
  }
  for (const sample of samples) consider(sample.lastSeenAt);
  return newest === null ? null : new Date(newest).toISOString();
}

/** A freshness entry with the arrival facts beside the newest sample. */
export interface HealthKitFreshnessEntry extends MetricFreshnessEntry {
  /** When a live sync last carried this type; null when none has. */
  lastReceivedAt?: string | null;
  /** The trigger of that sync; null when absent or not reported. */
  lastTrigger?: HealthKitSyncTrigger | null;
  /** When a live sync last brought a new or updated sample of it. */
  lastNewSampleAt?: string | null;
}

/**
 * Lay the arrival ledger over the per-type freshness entries. Every
 * measurement type gets the three fields, null when no live sync has carried
 * it yet (a type that so far came only from the export import, or from before
 * the ledger existed). The `WORKOUTS` entry is left without them: workouts
 * arrive through their own batch route, which the ledger does not cover, and
 * "not received yet" would be false. A null ledger (the read failed) leaves
 * every entry as it was rather than claiming nothing arrived.
 */
export function withHealthKitArrivals(
  entries: readonly MetricFreshnessEntry[],
  arrivals: ReadonlyMap<string, HealthKitTypeArrivalRecord> | null,
): HealthKitFreshnessEntry[] {
  if (!arrivals) return [...entries];
  return entries.map((entry) => {
    if (entry.type === WORKOUT_FRESHNESS_TYPE) return entry;
    const arrival = arrivals.get(entry.type);
    return {
      ...entry,
      lastReceivedAt: arrival?.lastReceivedAt ?? null,
      lastTrigger: arrival?.lastTrigger ?? null,
      lastNewSampleAt: arrival?.lastNewSampleAt ?? null,
    };
  });
}
