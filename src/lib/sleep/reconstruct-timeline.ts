/**
 * Shared reconstructed-sleep-timeline builder.
 *
 * Some wearables (WHOOP v2, Polar) expose only per-stage DURATION totals for a
 * night — no per-stage onset timestamps and no hypnogram endpoint. Stamping
 * every stage total on the one sleep-END instant collapses the hypnogram into
 * overlapping spans that all touch the night's right edge. Since the API never
 * carries an order, both vendors RECONSTRUCT an ordered, contiguous timeline:
 * lay the stages back-to-back from sleep ONSET in a fixed physiological order,
 * emitting one timed row per segment with `measuredAt = that segment's END`.
 *
 * The ORDER is synthetic, so every laid segment is flagged `reconstructed:
 * true`; the night DTO advertises it and the UI labels such a night as an
 * approximate layout, never as measured stage timing. The flag is not stored;
 * the reader recognises the layout by its shape instead (every stage once,
 * back to back, in `LAID_OUT_STAGE_ORDER`: `sleep/stage-timeline.ts`).
 *
 * This helper is the single source of the algorithm; each vendor `mapSleep`
 * keeps only its field-name → tuple normalisation (ms vs sec, source field
 * names) so the segment shape and externalId scheme can never drift between the
 * two synthetic-timeline vendors. Oura's measured 5-min hypnogram is a
 * different algorithm and does NOT use this helper.
 */

/** The sleep-row shape both vendor mappers emit. Kept structurally identical to
 * each vendor's local `MappedMeasurement`; the helper returns rows assignable to
 * either. */
export interface ReconstructedSleepRow {
  type: "SLEEP_DURATION";
  value: number;
  unit: "minutes";
  measuredAt: Date;
  fieldTag: string;
  externalId?: string;
  sleepStage: "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED";
  reconstructed?: boolean;
}

/** One asleep/awake stage to lay onto the reconstructed timeline. `durationMs`
 * is the stage total in milliseconds; non-positive or non-finite durations are
 * skipped. */
export interface ReconstructedStage {
  durationMs: number | null | undefined;
  stage: "CORE" | "DEEP" | "REM" | "AWAKE";
  fieldTag: string;
}

/** Optional single IN_BED envelope row over the whole sleep window. The in-bed
 * reader consumes the union envelope, so this stays one row stamped at the
 * sleep END (`measuredAt`) — NOT a placed segment. */
export interface ReconstructedInBed {
  durationMs: number | null | undefined;
  /** Sleep END instant; the in-bed reader resolves the span back to its window. */
  measuredAt: Date;
  fieldTag: string;
}

export interface ReconstructTimelineOptions {
  /** Sleep ONSET instant; the contiguous walk starts here. */
  startMs: number;
  /** Stages to lay out; laid in `LAID_OUT_STAGE_ORDER` whatever their order here. */
  stages: ReadonlyArray<ReconstructedStage>;
  /** Optional IN_BED envelope row. */
  inBed?: ReconstructedInBed;
  /**
   * Builds the externalId for a laid segment so the several rows of one night
   * stay distinct under `userId_type_source_externalId`. Called with the
   * segment's fieldTag ONLY — the builder emits at most one segment per stage,
   * so the tag alone is unique within a night. A positional index was
   * deliberately dropped from the key: it skipped zero-duration stages, so a
   * 0↔positive flip on a vendor re-score renumbered every following stage,
   * minted fresh externalIds, and the upsert double-counted the night instead
   * of overwriting (the Google Health v1.28.18 bug class).
   */
  externalIdFor: (fieldTag: string) => string;
}

/**
 * The one order a reconstructed timeline is laid in: a settling-in AWAKE
 * block, then CORE → DEEP → REM. The builder lays its stages in this order
 * whatever order the caller lists them in, and the night reader recognises
 * a laid-out night by it (`sleep/stage-timeline.ts` `hasStageTimeline`), so
 * the two cannot drift apart.
 */
export const LAID_OUT_STAGE_ORDER: ReadonlyArray<ReconstructedStage["stage"]> =
  ["AWAKE", "CORE", "DEEP", "REM"];

const MS_TO_MIN = 1 / 60_000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Lay the asleep/awake stages contiguously from `startMs` in
 * `LAID_OUT_STAGE_ORDER`,
 * emitting one timed `SLEEP_DURATION` row per stage (`measuredAt` = that
 * segment's END), each flagged `reconstructed: true` and keyed by a
 * stage-tagged externalId. Appends a single IN_BED envelope row when `inBed`
 * is provided.
 */
export function reconstructContiguousSleepTimeline(
  opts: ReconstructTimelineOptions,
): ReconstructedSleepRow[] {
  const { startMs, stages, inBed, externalIdFor } = opts;
  const out: ReconstructedSleepRow[] = [];

  const ordered = [...stages].sort(
    (a, b) =>
      LAID_OUT_STAGE_ORDER.indexOf(a.stage) -
      LAID_OUT_STAGE_ORDER.indexOf(b.stage),
  );
  let cursor = startMs;
  for (const { durationMs, stage, fieldTag } of ordered) {
    if (
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0
    ) {
      continue;
    }
    const segEnd = cursor + durationMs;
    out.push({
      type: "SLEEP_DURATION",
      value: round2(durationMs * MS_TO_MIN),
      unit: "minutes",
      measuredAt: new Date(segEnd),
      fieldTag,
      externalId: externalIdFor(fieldTag),
      sleepStage: stage,
      reconstructed: true,
    });
    cursor = segEnd;
  }

  if (
    inBed &&
    typeof inBed.durationMs === "number" &&
    Number.isFinite(inBed.durationMs) &&
    inBed.durationMs > 0
  ) {
    out.push({
      type: "SLEEP_DURATION",
      value: round2(inBed.durationMs * MS_TO_MIN),
      unit: "minutes",
      measuredAt: inBed.measuredAt,
      fieldTag: inBed.fieldTag,
      sleepStage: "IN_BED",
    });
  }

  return out;
}
