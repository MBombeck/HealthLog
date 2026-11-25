/**
 * The ingest-side half of the app's plausibility domain.
 *
 * `VALUE_RANGES` in `@/lib/measurements/value-ranges` is the band the
 * application declares a metric can occupy — PULSE 20–300, WEIGHT 1–500,
 * SLEEP_DURATION 0–1440 minutes. Every path a person can drive enforces it:
 * the measurement routes, the batch endpoint, the CSV and Apple-export
 * importers, MCP, Telegram. The provider sync writers did not. They took the
 * number the remote handed over and wrote it, so a decode slip or a glitched
 * device landed a row the application itself calls impossible, and every mean,
 * median and personal band downstream digested it as a reading.
 *
 * `isPlausibleMetricValue` (in `value-domain.ts`) already answers the question
 * for the READ side, which is where the damage surfaced first. This module is
 * the same question asked one layer earlier, at the point of writing, so the
 * row never lands. The two ends share the one predicate on purpose: a band the
 * reader hides but the writer accepts is a row that exists and cannot be seen,
 * which is the worse of the two failures.
 *
 * ## Disposition: drop, and say so
 *
 * An out-of-band incoming value is DROPPED. Not clamped (a clamp invents a
 * reading nobody took), not stored-and-flagged (a quarantined row is still a
 * row, and every consumer would need to learn the flag), not fatal to the
 * batch (one glitched sample must not strand the sync's other readings behind
 * a held watermark). Absence reads as absence: the sample is simply not part
 * of the record.
 *
 * A silent drop, though, is indistinguishable from a provider that sent
 * nothing — so every drop is tallied onto the ambient wide event under
 * {@link RANGE_REJECTED_META_KEY}, with the metric type, the provider, and the
 * direction it broke the band in. Counts only. The value itself is a health
 * reading and never enters the log line; the direction plus the metric's own
 * declared bound is what a diagnosis actually needs.
 *
 * ## Why meta and not `action`
 *
 * A wide event holds exactly ONE action, and `setAction` replaces it. A drop
 * happens in the middle of a sync whose action is decided at the end, so an
 * `action` set here is either clobbered a moment later (the drop vanishes) or,
 * on the paths that annotate no terminal action, relabels an otherwise
 * successful sync as a rejection. Meta accumulates, survives every later
 * `setAction`, and is the shape a dashboard can sum. One warning per provider
 * per event rides along so the drop also lifts the event's level to `warn`
 * rather than hiding inside a green line.
 */
import { annotate, getEvent } from "@/lib/logging/context";
import { isPlausibleMetricValue } from "@/lib/measurements/value-domain";
import { VALUE_RANGES } from "@/lib/measurements/value-ranges";
import { ownValue } from "@/lib/own-key";

/**
 * Stable meta key the tally lands under. Pinned so dashboards can count it
 * across providers without knowing which one wrote the event.
 */
export const RANGE_REJECTED_META_KEY = "measurement.range_rejected";

/** Which edge of the declared band the value broke, or that it was not a number. */
export type RangeRejectionDirection = "below_min" | "above_max" | "not_finite";

/** One refused reading, reduced to the facts that carry no health value. */
export interface MeasurementRangeRejection {
  /** `MeasurementType` of the refused reading. */
  type: string;
  direction: RangeRejectionDirection;
}

/** One (provider, metric, direction) cell of the event's running tally. */
export interface RangeRejectionBucket {
  source: string;
  type: string;
  direction: RangeRejectionDirection;
  count: number;
}

/** The pinned meta shape written under {@link RANGE_REJECTED_META_KEY}. */
export interface RangeRejectionTally {
  total: number;
  buckets: RangeRejectionBucket[];
}

/**
 * Classify a candidate write against the metric's declared band.
 *
 * Returns `null` when the value may be written. A type with no declared range
 * passes — an absent range is an absent fact, never a guessed one, and the
 * same asymmetry the read side uses (`isPlausibleMetricValue`). A non-finite
 * value never passes, whatever the type: NaN is not an input to anything.
 */
export function classifyRangeRejection(
  type: string,
  value: number,
): MeasurementRangeRejection | null {
  if (isPlausibleMetricValue(type, value)) return null;
  if (!Number.isFinite(value)) return { type, direction: "not_finite" };
  const range = ownValue(VALUE_RANGES, type);
  // `isPlausibleMetricValue` only answers false for a finite value when the
  // type HAS a range, so the lookup cannot miss here.
  return {
    type,
    direction: value < range!.min ? "below_min" : "above_max",
  };
}

function readTally(): RangeRejectionTally {
  const existing = getEvent()?.toJSON().meta?.[RANGE_REJECTED_META_KEY];
  if (
    existing !== null &&
    typeof existing === "object" &&
    Array.isArray((existing as RangeRejectionTally).buckets)
  ) {
    return existing as RangeRejectionTally;
  }
  return { total: 0, buckets: [] };
}

/**
 * Fold refusals onto the ambient wide event.
 *
 * Merges with whatever the event already carries, so a provider that gates
 * several batches (or reconciles row by row) accumulates instead of
 * overwriting. Outside a wide-event context this is a no-op — the caller still
 * drops the row, it simply has nowhere to report.
 */
export function recordRangeRejections(
  source: string,
  rejections: readonly MeasurementRangeRejection[],
): void {
  if (rejections.length === 0) return;
  const evt = getEvent();
  if (!evt) return;

  const tally = readTally();
  const firstForSource = !tally.buckets.some((b) => b.source === source);

  for (const rejection of rejections) {
    const bucket = tally.buckets.find(
      (b) =>
        b.source === source &&
        b.type === rejection.type &&
        b.direction === rejection.direction,
    );
    if (bucket) bucket.count += 1;
    else
      tally.buckets.push({
        source,
        type: rejection.type,
        direction: rejection.direction,
        count: 1,
      });
    tally.total += 1;
  }

  tally.buckets.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.type.localeCompare(b.type) ||
      a.direction.localeCompare(b.direction),
  );

  annotate({ meta: { [RANGE_REJECTED_META_KEY]: tally } });
  if (firstForSource) {
    evt.addWarning(
      `${source}: refused reading(s) outside the declared plausibility range — ` +
        `dropped, see meta.${RANGE_REJECTED_META_KEY}`,
    );
  }
}

/**
 * Keep the rows whose value sits inside the metric's declared band; tally and
 * drop the rest.
 *
 * `select` exists because the sync writers carry their own row shapes and none
 * of them is worth reshaping at the call site: the gate reads the two fields
 * it needs and returns the caller's own objects untouched.
 */
export function dropImplausibleMeasurements<T>(
  source: string,
  rows: readonly T[],
  select: (row: T) => { type: string; value: number },
): T[] {
  const kept: T[] = [];
  const rejections: MeasurementRangeRejection[] = [];
  for (const row of rows) {
    const { type, value } = select(row);
    const rejection = classifyRangeRejection(type, value);
    if (rejection) rejections.push(rejection);
    else kept.push(row);
  }
  recordRangeRejections(source, rejections);
  return kept;
}
