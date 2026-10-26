/**
 * The vocabulary of the native batch ingest (`POST /api/measurements/batch`):
 * what one posted entry carries, what the ingest answers for it, and the two
 * small rules more than one stage needs.
 *
 * The wire schema itself stays in the route, which owns the contract; the
 * entry type here is what that schema parses to, and the route assigns one to
 * the other so the compiler holds them together.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { HealthKitRequestSyncTrigger } from "@/lib/integrations/healthkit-type-sync";
import { getUnitForType, VALUE_RANGES } from "@/lib/validations/measurement";
import type { DeviceType } from "@/lib/validations/source-priority";

/** One HealthKit sample (or `stats:` aggregate) as the route parsed it. */
export interface BatchIngestEntry {
  hkIdentifier: string;
  value: number;
  unit: string;
  startDate: string;
  endDate: string;
  sleepStage?: number;
  categoryValue?: number;
  valueMin?: number;
  valueMax?: number;
  externalId: string;
  externalSourceVersion?: string;
  source?: "APPLE_HEALTH" | "MANUAL";
  deviceType?: DeviceType | null;
}

/** The parsed request: the entries and the client's declared wake reason. */
export interface BatchIngestInput {
  user: { id: string; timezone: string | null };
  /** A narrow single-purpose Bearer (a bridge), not the native client. */
  scoped: boolean;
  /**
   * The bridge token that carried the batch, set exactly when `scoped`: each
   * row it writes points at it (`Measurement.ingestTokenId`, #1272).
   */
  ingestTokenId: string | null;
  entries: BatchIngestEntry[];
  syncTrigger: HealthKitRequestSyncTrigger | undefined;
  ipAddress: string | null;
}

/**
 * Per-entry outcome the iOS client uses to advance its sync cursor.
 * `inserted` and `duplicate` both indicate the row landed (or was
 * already present), so the client can checkpoint past them. `updated`
 * is the per-day-aggregate overwrite path: when the iOS client re-posts
 * a `stats:*` cumulative row (Steps, Active Energy, Sleep Duration,
 * Walking/Running Distance, Flights Climbed — see issue #213) for a day
 * we already have, the server overwrites the row's `value` rather than
 * dropping the new payload as a duplicate. Sample-class rows (every
 * other HK metric) keep the strict `duplicate` semantics because each
 * sample is a canonical, immutable reading. `skipped` is a validation no-op;
 * `failed` is a hard database verdict and must not be checkpointed as landed.
 */
export type EntryStatus =
  "inserted" | "updated" | "duplicate" | "skipped" | "failed";

export interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
  /**
   * Only on a `value_out_of_range` skip: the value after conversion into the
   * stored unit, which is what the band was checked against.
   */
  convertedValue?: number;
  /** Only on a `value_out_of_range` skip: the band applied, in the stored unit. */
  range?: { min: number; max: number; unit: string };
}

/** An entry that passed the first pass, with the row it becomes. */
export interface PreparedEntry {
  index: number;
  entry: BatchIngestEntry;
  row: Prisma.MeasurementCreateManyInput;
}

// Issue #213 — `stats:*` externalIds carry per-day cumulative
// totals that the iOS HealthKit observer re-posts as the day progresses.
// Treating those as immutable duplicates freezes the day's tile at the
// first-sync value. Sample-class externalIds (every other prefix) keep
// the strict insert-only contract.
const STATS_EXTERNAL_ID_PREFIX = "stats:";

export function isStatsExternalId(
  externalId: string | null | undefined,
): boolean {
  return (
    typeof externalId === "string" &&
    externalId.startsWith(STATS_EXTERNAL_ID_PREFIX)
  );
}

/**
 * The `value_out_of_range` skip, with what a client needs to say which limit
 * applied. The value is the entry's own reading after conversion, handed back
 * to the account that sent it; a fraction sent where a percent was expected
 * shows up here as a converted value a hundred times too small or too large.
 */
export function outOfRangeResult(
  index: number,
  type: string,
  convertedValue: number,
): EntryResult {
  const band = VALUE_RANGES[type];
  return {
    index,
    status: "skipped",
    reason: "value_out_of_range",
    ...(Number.isFinite(convertedValue) ? { convertedValue } : {}),
    ...(band
      ? { range: { min: band.min, max: band.max, unit: getUnitForType(type) } }
      : {}),
  };
}
