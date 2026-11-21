/**
 * v1.11.4 — per-night sleep aggregation (iOS #1, HIGH).
 *
 * `SLEEP_DURATION` is stored in MINUTES, one row per sleep STAGE per
 * night (IN_BED / AWAKE / ASLEEP / REM / CORE / DEEP) since v1.4.23. The
 * value is NOT cumulative — a single stage row carries only that stage's
 * minutes. Every "last night's sleep" surface therefore has to SUM the
 * stage rows belonging to one night before it shows a headline number;
 * reading the single most-recent row gives one stage, not the night.
 *
 * This helper is the one shared place that turns the raw per-stage rows
 * into per-night totals. The headline "time asleep" is light(CORE) +
 * deep + REM; IN_BED and AWAKE are excluded from the asleep total,
 * matching the AASM convention.
 *
 * Granular-over-bare (v1.11.5)
 * ----------------------------
 * Apple Health writes BOTH an unspecified `ASLEEP` AGGREGATE row AND the
 * granular `CORE` / `DEEP` / `REM` breakdown for the SAME sleep period. The
 * granular rows partition the same time the aggregate covers, so counting
 * bare-ASLEEP together with the granular rows ~doubles the night. We therefore
 * prefer the granular partition: when ANY granular stage (CORE / DEEP / REM)
 * is present for a session we drop the redundant bare `ASLEEP` aggregate (and
 * any stage-less row) EVERYWHERE — the asleep total, the per-stage `stages`
 * breakdown, and the hypnogram `segments` list — so none of those views holds
 * the granular set plus its ~equal bare twin. The bare `ASLEEP` aggregate (or
 * a stage-less legacy / manual row) is the session's only asleep signal when
 * no granular stage exists. WHOOP never emits a bare `ASLEEP` aggregate (its
 * stage map writes CORE / DEEP / REM / AWAKE / IN_BED only — see
 * `whoop/client.ts`), so this gate is Apple-Health-only in practice.
 *
 * Night grouping
 * --------------
 * A "night" is one SLEEP SESSION, not a calendar day. `measuredAt` is the
 * stage segment's END instant (`apple-health-mapping.ts` sets
 * `takenAt = endDate`), and a device writes one row per stage segment, so a
 * normal overnight sleep (asleep before local midnight) spreads its segments
 * across BOTH sides of midnight. Keying each segment by its own calendar day
 * would split one physical night into two partial nights and undercount the
 * "last night" headline.
 *
 * Instead we cluster the segments into sessions by time gap: sort by
 * `measuredAt`, and start a new session whenever the gap from the previous
 * segment exceeds `SESSION_GAP_MS` (3 h). Stage segments inside one sleep
 * session are contiguous (minutes to ~2 h apart), so a > 3 h gap reliably
 * marks the boundary between a daytime nap and the overnight session, or
 * between two genuine sessions in one day — they stay separable. The gap is
 * measured on the absolute UTC instant, so it is immune to DST shifts.
 *
 * Each session is keyed by the LOCAL WAKE DAY — `userDayKey` of the session's
 * LAST row end over every writer, in the user's timezone. This matches the
 * Apple Health convention (a sleep session is attributed to the date you wake
 * up) and keeps the keying tz/DST-correct because it runs on the real instant.
 *
 * Naps vs the main night
 * ----------------------
 * `reconstructSleepNights` MERGES every session that lands on the same wake
 * day under one key so the headline "time asleep" for a day is the day's
 * total. `reconstructSleepSessions` keeps each session SEPARATE, and
 * `pickMainNightAndNaps` applies the convention the UI needs: the MAIN night
 * is the main sleep with the most asleep minutes (normally the overnight
 * block), and every other session on the same wake day is a NAP, surfaced
 * separately and never folded into the main night's headline. A session is
 * a nap rather than a main sleep when it is short and centred in the daytime
 * (`isDaytimeNap`), so a day with an afternoon nap and no recorded night has
 * no main night at all, rather than the nap standing in for one.
 *
 * Writer de-dup
 * -------------
 * A user paired to more than one sleep source (e.g. WHOOP + Apple Health)
 * gets per-stage rows for the SAME night from each source. Summing them all
 * would ~double the night total. Before summing a session we collapse it to
 * ONE writer. A "writer" is `(source, deviceType)` — finer than `source`
 * because several HealthKit writer apps land behind the SAME
 * `source = APPLE_HEALTH` (the watch's granular stages, the phone's coarse
 * in-bed detection, a wearable vendor app's re-export). Keying the collapse
 * on source alone blends those writers into one bucket: the phone's
 * awake/in-bed blocks inflate the night's awake total and sit on top of the
 * watch's hypnogram. Rows without a `deviceType` collapse per source exactly
 * as before, so legacy rows and single-writer sources are unaffected.
 *
 * The pick is per-night by STAGE RICHNESS first: the writer carrying the
 * most distinct granular stages (CORE / DEEP / REM) wins, so a coarse
 * awake/asleep-only export can never mask a writer that knows the night's
 * phases. Among equally rich writers the user's `sleep` source-priority
 * ladder decides (`DEFAULT_SOURCE_PRIORITY.sleep` = WHOOP > APPLE_HEALTH >
 * WITHINGS), then most asleep minutes, then a stable key tiebreak. Only the
 * winning writer's segments are summed — writers are never blended within a
 * session, mirroring the per-(type, day) collapse the rest of the v1.11.x
 * numeric surfaces apply.
 *
 * One exception: `inBedMinutes` ("Zeit im Bett") derives from the UNION
 * of the IN_BED spans across ALL writers in the session, not from the
 * winner alone. The common pairing is a watch that knows the stages but
 * writes no IN_BED row and a phone whose bedtime detection writes only
 * the long IN_BED window — the watch wins the night on richness, and a
 * winner-only in-bed figure would shrink to nothing exactly when the
 * stage data is best. Overlapping spans from two writers are merged
 * interval-union style so a doubled export never double-counts.
 * `stages.IN_BED` IS that same number — one quantity, one computation —
 * so the stage legend can never contradict the headline. The asleep
 * total, `awakeMinutes` and every OTHER entry of the `stages` map stay
 * winner-only — blending the phone's coarse AWAKE blocks into the
 * watch's night was the original inflated-awake bug this collapse
 * exists to prevent.
 *
 * Overlap within one writer
 * -------------------------
 * A device can write the SAME period twice: an original envelope and a
 * corrected one, same start, later end, distinct external ids. Both rows
 * survive the writer collapse (they ARE the same writer), and adding both
 * minute counts reports the night twice — the shape that made one night's
 * in-bed legend read 20 h against a 10 h headline. Every per-stage total
 * is therefore the measure of the UNION of that stage's spans, not the sum
 * of the rows (`mergeOverlappingSegments`). Stages merge independently: a
 * CORE span overlapping a DEEP span is a contest over what the minute WAS,
 * and the writer collapse above is this file's one mechanism for that
 * contest. The invariant that falls out and holds for every session: no
 * stage total can exceed the union envelope of that stage's own spans, so
 * none can exceed the session's envelope either.
 *
 * Unit
 * ----
 * Totals are returned in MINUTES — the canonical `SLEEP_DURATION` unit
 * (`getUnitForType` → "minutes") — so the existing web consumers that
 * already treat the summary as minutes (e.g. the insights overview's
 * `formatHoursMinutes`) keep working unchanged; they now average per-
 * night totals instead of per-stage rows, which is strictly more
 * correct. Callers that want hours convert at the edge (`/ 60`).
 */
import type { MeasurementSource, SleepStage } from "@/generated/prisma/client";
import {
  asleepMidpointMinutes,
  isDaytimeNap,
  sessionZoneOf,
  wakeDayOf,
} from "./sleep-session-clock";
import { summarize, type DataSummary } from "@/lib/analytics/trends";
import {
  getDeviceTypeLadder,
  getSourceLadder,
  parseSourcePriority,
} from "@/lib/validations/source-priority";

/**
 * The GRANULAR asleep stages (iOS 16+ `asleepCore` / `asleepDeep` /
 * `asleepREM`). A bare `ASLEEP` row is the iOS 15- `asleepUnspecified`
 * AGGREGATE — Apple Health writes BOTH the unspecified aggregate AND the
 * granular breakdown for the SAME period, so keeping bare-ASLEEP alongside the
 * granular rows ~doubles the night. The granular rows partition the same time
 * the aggregate covers, so when any granular stage is present for a session we
 * keep ONLY the granular stages and drop the bare aggregate; the bare row is
 * the asleep signal only when no granular stage exists. WHOOP never writes a
 * bare `ASLEEP` aggregate (see `whoop/client.ts` `SLEEP_STAGE_MAP`).
 */
const GRANULAR_ASLEEP_STAGES: ReadonlySet<SleepStage> = new Set<SleepStage>([
  "REM",
  "CORE",
  "DEEP",
]);

/**
 * Every stage that counts as asleep: the granular partition plus the bare
 * `ASLEEP` aggregate. A stage-less row counts as asleep too, but it has no
 * stage to list. The sleep list's SQL session cut splices this list, so the
 * two decide "does this session hold sleep?" from one definition.
 */
export const ASLEEP_STAGES: readonly SleepStage[] = [
  "ASLEEP",
  ...GRANULAR_ASLEEP_STAGES,
];

/**
 * True when any row in the set carries a GRANULAR asleep stage
 * (CORE / DEEP / REM). When this holds, the bare `ASLEEP` aggregate (and any
 * stage-less row) is the redundant unspecified twin of the granular partition
 * and must be dropped from EVERY downstream view — the asleep total, the
 * per-stage `stages` map, and the hypnogram `segments` list — so none of them
 * double-counts the same period.
 */
function sawGranularStage(rows: readonly SleepStageRow[]): boolean {
  for (const r of rows) {
    const stage = r.sleepStage;
    // A zero-minute granular row partitions nothing: it must not strip the
    // bare aggregate that does carry the night.
    if (stage != null && GRANULAR_ASLEEP_STAGES.has(stage) && r.value > 0)
      return true;
  }
  return false;
}

/**
 * A stage row is a redundant bare-asleep aggregate (must be dropped) when the
 * session/night ALSO carries a granular CORE/DEEP/REM partition. Only the bare
 * `ASLEEP` aggregate and stage-less (`null`) rows are redundant — IN_BED /
 * AWAKE and the granular stages themselves are always kept.
 */
function isRedundantBareAsleep(
  stage: SleepStage | null,
  sawGranular: boolean,
): boolean {
  return sawGranular && (stage === "ASLEEP" || stage == null);
}

/**
 * Sum a set of stage rows into time-asleep minutes WITHOUT double-counting a
 * bare `ASLEEP` aggregate against the granular CORE/DEEP/REM rows it overlaps.
 * IN_BED + AWAKE are never asleep; a stage-less (`null`) row is the night's
 * total only when no granular stage is present.
 *
 * Each stage contributes the measure of the UNION of its own spans
 * (`mergeOverlappingSegments`), so a period a device re-exported under a
 * corrected row is counted once — the headline cannot drift away from the
 * per-stage legend that sums the same merged spans.
 */
function asleepMinutesOf(rows: readonly SleepStageRow[]): number {
  let granular = 0;
  let fallback = 0;
  let sawGranular = false;
  for (const seg of mergeOverlappingSegments(rows.map(segmentOf))) {
    const stage = seg.stage;
    if (stage != null && GRANULAR_ASLEEP_STAGES.has(stage)) {
      granular += seg.minutes;
      if (seg.minutes > 0) sawGranular = true;
    } else if (stage === "ASLEEP" || stage == null) {
      // Bare unspecified aggregate (`ASLEEP`) or a stage-less legacy/manual
      // row — only used when no granular stage carries the night.
      fallback += seg.minutes;
    }
    // IN_BED / AWAKE never count toward asleep.
  }
  return sawGranular ? granular : fallback;
}

/**
 * Total minutes covered by the UNION of the IN_BED spans across EVERY
 * writer in a session ("Zeit im Bett"). Each IN_BED row resolves to the
 * absolute span `[measuredAt − value·60_000, measuredAt]`; overlapping
 * spans (the same window exported by two writers) merge before summing
 * so a doubled export never double-counts the night. Returns `null`
 * when no IN_BED row exists anywhere in the session — the caller keeps
 * the "no in-bed signal" semantics. Deliberately NOT winner-scoped: the
 * stage-rich watch usually writes no IN_BED row while the phone writes
 * only the envelope, and the headline must keep both facets.
 */
function inBedEnvelopeMinutes(rows: readonly SleepStageRow[]): number | null {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const r of rows) {
    if (r.sleepStage !== "IN_BED") continue;
    const minutes = Number.isFinite(r.value) ? r.value : 0;
    const end = r.measuredAt.getTime();
    intervals.push({ start: end - minutes * 60_000, end });
  }
  if (intervals.length === 0) return null;
  intervals.sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = intervals[0].start;
  let curEnd = intervals[0].end;
  for (let i = 1; i < intervals.length; i++) {
    const { start, end } = intervals[i];
    if (start <= curEnd) {
      if (end > curEnd) curEnd = end;
    } else {
      total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    }
  }
  total += curEnd - curStart;
  return Math.round(total / 60_000);
}

/**
 * Gap (ms) between consecutive stage segments that starts a new sleep
 * session. Stage segments within one night are contiguous (minutes to a
 * couple of hours apart); a > 3 h gap separates a nap from the overnight
 * block, or two genuine sessions in one day. The sleep list pages its
 * nights in SQL with the same cut (`sleepNightPage` in the measurements
 * list route), so this is the one value both read.
 */
export const SESSION_GAP_MS = 3 * 60 * 60 * 1000;

export {
  MAIN_SLEEP_MIN_MINUTES,
  NIGHT_WINDOW_END_MINUTES,
  NIGHT_WINDOW_START_MINUTES,
  asleepMidpointMinutes,
  isDaytimeNap,
  sessionZoneOf,
} from "./sleep-session-clock";

export interface SleepStageRow {
  value: number;
  measuredAt: Date;
  sleepStage: SleepStage | null;
  /**
   * Ingest source of the stage row. Used to collapse a multi-source night
   * (e.g. WHOOP + Apple Health) to one canonical source before summing.
   * Optional so legacy callers and fixtures that don't carry a source still
   * type-check (a missing source is treated as a single anonymous source —
   * the de-dup is a no-op for single-source nights).
   */
  source?: MeasurementSource | null;
  /**
   * Device-type tag of the stage row (`Measurement.deviceType`, v1.4.25).
   * Distinguishes WRITERS behind one source: several HealthKit apps
   * write sleep under `source = APPLE_HEALTH` (watch granular stages, phone
   * coarse in-bed, vendor-app re-exports), and collapsing on source alone
   * blends them. Optional — callers that don't select the column (and every
   * row stored before v1.4.25) collapse per source exactly as before.
   */
  deviceType?: string | null;
  /**
   * The IANA zone the row was taken in (iOS #181); null or absent reads
   * the row in the profile zone. Optional so callers that do not select the
   * column file every night by the profile zone, as before.
   */
  timeZone?: string | null;
}

/** One reconstructed night: the asleep total + the per-stage breakdown. */
export interface SleepNight {
  /** Wake-day key (YYYY-MM-DD) in the user's timezone. */
  night: string;
  /** Latest stage instant in the night — the night's representative timestamp. */
  measuredAt: Date;
  /** Time asleep in minutes = CORE + DEEP + REM, or bare ASLEEP when granular stages are absent. */
  asleepMinutes: number;
  /**
   * In-bed minutes when an IN_BED row exists ANYWHERE in the night's
   * sessions, else null. Union envelope across ALL writers — not
   * winner-scoped like `asleepMinutes` / `stages` / `awakeMinutes` —
   * so a stage-rich watch winning the night never erases the phone's
   * in-bed window. See the module doc's writer-de-dup exception.
   */
  inBedMinutes: number | null;
  /** Awake-in-bed minutes when an AWAKE row exists, else null. */
  awakeMinutes: number | null;
  /**
   * Per-stage minutes for the night. Every entry is the measure of the
   * UNION of that stage's spans, never the raw row sum, so a re-exported
   * period is counted once. Stages other than IN_BED come from the winning
   * writer only; `stages.IN_BED` is the all-writer envelope and therefore
   * always equals `inBedMinutes`.
   */
  stages: Partial<Record<SleepStage, number>>;
  /**
   * Non-null when two writer buckets reported clearly different asleep
   * totals for the night's MAIN session — the same-wake-day main sleep with
   * the most asleep minutes, normally the overnight block (see
   * `pickMainNightAndNaps` and `sessionSourceDiscrepancy`). Sessions never cross-compare: a nap's
   * writers are not measured against the overnight's. Observational only —
   * the served `asleepMinutes` stays the winning writer's total; the
   * annotation lets the UI mark the number with a discreet
   * "sources disagree" hint.
   */
  sourceDiscrepancy: SleepSourceDiscrepancy | null;
  /**
   * The night's MAIN session alone, chosen by the nap convention
   * (`pickMainNightAndNaps`: the main sleep with the most asleep minutes, the
   * one `sourceDiscrepancy` reads), its wake instant and its own asleep
   * minutes. A nap on the same wake day is in the night's totals but not
   * here, so a reader that places the night on the clock (the sleep midpoint)
   * is not dragged into the afternoon by it. Null when no session carries
   * asleep minutes, and on a day whose only sleep is daytime naps.
   */
  mainSession: {
    end: Date;
    asleepMinutes: number;
    /** The zone the session's clock reads in (its own, or the profile's). */
    timeZone: string;
  } | null;
}

/** Sentinel for rows that carry no source — collapses to one bucket. */
const NO_SOURCE = "__none__";

/**
 * Sources whose per-segment stage ORDER is synthesised, not measured. WHOOP's
 * v2 API exposes only per-stage duration totals (no onset timestamps), so the
 * ingest mapper reconstructs a contiguous timeline in a fixed physiological
 * order (`whoop/client.ts` + `polar/client.ts` `mapSleep`, both via the shared
 * `reconstructContiguousSleepTimeline` builder). A session won by such a source
 * carries `reconstructed: true` so the UI labels it as an approximate layout.
 * Apple Health / Oura / Withings / Fitbit all store a real per-segment series
 * and stay off this set.
 */
const RECONSTRUCTED_TIMELINE_SOURCES: ReadonlySet<string> = new Set<string>([
  "WHOOP",
  "POLAR",
]);

/**
 * Separator between the source and device-type parts of a writer key.
 * The unit-separator character (U+241F) cannot appear in a
 * `MeasurementSource` enum literal or a device-type tag, so the
 * split-back is unambiguous.
 */
const WRITER_KEY_SEP = "\u241F";

/**
 * Writer-bucket key of a stage row: the source, refined by the device-type
 * tag when one is stored. Two HealthKit writer apps behind the same
 * `APPLE_HEALTH` source (watch vs phone) land in DIFFERENT buckets so the
 * coarse writer's awake/in-bed blocks never blend into the granular
 * writer's night. Rows without a device-type keep the bare source as their
 * key — single-writer sources and legacy rows collapse exactly as before.
 */
function writerKeyOf(r: SleepStageRow): string {
  const src = r.source ?? NO_SOURCE;
  const dev = r.deviceType;
  return dev ? `${src}${WRITER_KEY_SEP}${dev}` : src;
}

/** The source part of a writer key (for ladder ranking + display). */
function sourceOfWriterKey(key: string): string {
  const i = key.indexOf(WRITER_KEY_SEP);
  return i === -1 ? key : key.slice(0, i);
}

/** The device part of a writer key; legacy/bare writers rank as unknown. */
function deviceOfWriterKey(key: string): string {
  const i = key.indexOf(WRITER_KEY_SEP);
  return i === -1 ? "unknown" : key.slice(i + WRITER_KEY_SEP.length);
}

/**
 * Thresholds for the per-session source-discrepancy annotation. Two writer
 * buckets "clearly disagree" on a night only when the spread of their asleep
 * totals exceeds BOTH gates — an absolute floor (small deltas are ordinary
 * sensor variance) and a relative one (a 50-minute delta matters on a
 * 2-hour nap, not on a 10-hour night).
 */
const DISCREPANCY_MIN_DELTA_MINUTES = 45;
const DISCREPANCY_MIN_RATIO = 0.2;

/**
 * OBSERVATIONAL annotation: two writer buckets reported clearly different
 * asleep totals for the same session. Purely additive — it never changes
 * which writer wins the night or what total is served; it only surfaces
 * that a non-winning bucket disagreed, so the UI can show a discreet
 * "sources disagree" marker where the number renders.
 */
export interface SleepSourceDiscrepancy {
  /** max − min asleep minutes across the disagreeing writer buckets. */
  deltaMinutes: number;
  /** Every writer bucket with an asleep total, most asleep minutes first. */
  sources: {
    source: string;
    deviceType: string | null;
    asleepMinutes: number;
  }[];
}

/**
 * Compare the per-writer asleep totals of ONE session and flag a clear
 * disagreement. Buckets follow the same `(source, deviceType)` writer key
 * the dedup collapse uses, and each bucket's total applies the same
 * granular-over-bare rule as the served number, so the comparison is
 * apples-to-apples. Source-less legacy rows are skipped (a bucket the UI
 * cannot label is not a nameable second opinion), as are buckets with no
 * asleep minutes at all (an IN_BED/AWAKE-only phone writer makes no claim
 * about the asleep total). Returns null when fewer than two buckets carry
 * an asleep total or the spread stays inside the thresholds.
 */
function sessionSourceDiscrepancy(
  rows: readonly SleepStageRow[],
): SleepSourceDiscrepancy | null {
  const rowsByWriter = new Map<string, SleepStageRow[]>();
  for (const r of rows) {
    if (r.source == null) continue;
    const key = writerKeyOf(r);
    const list = rowsByWriter.get(key) ?? [];
    list.push(r);
    rowsByWriter.set(key, list);
  }
  if (rowsByWriter.size < 2) return null;
  const buckets: SleepSourceDiscrepancy["sources"] = [];
  for (const [key, writerRows] of rowsByWriter) {
    const asleepMinutes = asleepMinutesOf(writerRows);
    if (asleepMinutes <= 0) continue;
    buckets.push({
      source: sourceOfWriterKey(key),
      deviceType: writerRows[0].deviceType ?? null,
      asleepMinutes,
    });
  }
  if (buckets.length < 2) return null;
  buckets.sort(
    (a, b) =>
      b.asleepMinutes - a.asleepMinutes || (a.source < b.source ? -1 : 1),
  );
  const max = buckets[0].asleepMinutes;
  const min = buckets[buckets.length - 1].asleepMinutes;
  const delta = max - min;
  if (delta <= DISCREPANCY_MIN_DELTA_MINUTES) return null;
  if (delta <= max * DISCREPANCY_MIN_RATIO) return null;
  return { deltaMinutes: delta, sources: buckets };
}

/**
 * Count of DISTINCT granular stages (CORE / DEEP / REM) in a row set — the
 * stage-richness score of a writer's night. 3 = full hypnogram, 0 = coarse
 * (bare ASLEEP / AWAKE / IN_BED only).
 */
function granularStageCount(rows: readonly SleepStageRow[]): number {
  const seen = new Set<SleepStage>();
  for (const r of rows) {
    const stage = r.sleepStage;
    if (stage != null && GRANULAR_ASLEEP_STAGES.has(stage)) seen.add(stage);
  }
  return seen.size;
}

/**
 * Pick the one canonical WRITER for a session. STAGE RICHNESS wins first:
 * the writer carrying the most distinct granular stages (CORE / DEEP / REM)
 * always beats a coarser one, so neither a parallel coarse export of the
 * same night (e.g. Apple Health's AWAKE/ASLEEP blocks alongside WHOOP's
 * per-stage rows) nor a second writer app behind the same source (the
 * phone's in-bed detection next to the watch's stages) can mask the
 * fullest hypnogram available for the night. Among equally rich writers
 * the user's `sleep` source-priority ladder decides (lowest ladder index =
 * highest priority), then the `SLEEP_DURATION` device-type ladder decides
 * between writers behind that same source. Writers absent from both ladders
 * fall back to "most asleep minutes", then a stable key tiebreak.
 * Single-writer (or source-less) sessions resolve to that one bucket with no
 * work.
 */
function pickSessionWriter(
  rows: SleepStageRow[],
  sleepLadder: readonly MeasurementSource[],
  deviceLadder: readonly string[],
): string {
  // Group rows by writer, then sum each writer's asleep minutes with the
  // granular-over-bare rule so a writer that stores BOTH a bare ASLEEP
  // aggregate and the granular breakdown is not over-weighted in the tiebreak.
  const rowsByWriter = new Map<string, SleepStageRow[]>();
  for (const r of rows) {
    const key = writerKeyOf(r);
    const list = rowsByWriter.get(key) ?? [];
    list.push(r);
    rowsByWriter.set(key, list);
  }
  const asleepByWriter = new Map<string, number>();
  for (const [key, writerRows] of rowsByWriter) {
    const minutes = asleepMinutesOf(writerRows);
    if (minutes > 0) asleepByWriter.set(key, minutes);
  }
  // No asleep minutes anywhere (IN_BED / AWAKE only) — fall back to the set
  // of all present writers so the session still resolves to a single bucket.
  let writers =
    asleepByWriter.size > 0
      ? [...asleepByWriter.keys()]
      : [...rowsByWriter.keys()];
  // Three gates, in this order:
  //   1. granular PRESENCE — writers carrying any granular stage eliminate
  //      coarse ASLEEP-only writers (a phone aggregate must not mask a
  //      watch's hypnogram), coarse survives only when nobody is granular;
  //   2. timeline shape — see below;
  //   3. max distinct-stage COUNT among the survivors.
  const richnessOf = new Map<string, number>();
  let maxRichness = 0;
  for (const key of writers) {
    const score = granularStageCount(rowsByWriter.get(key) ?? []);
    richnessOf.set(key, score);
    if (score > maxRichness) maxRichness = score;
  }
  if (maxRichness > 0) {
    writers = writers.filter((key) => (richnessOf.get(key) ?? 0) > 0);
  }
  // Timeline gate — BETWEEN granular presence and the max-richness count.
  // A writer whose stage rows carry ≥2 distinct measuredAt instants has
  // real per-segment timing; a summary-shaped writer stamps every stage
  // total on one instant (WHOOP's stage_summary stamps everything on the
  // sleep END), and the hypnogram would reconstruct its "segments" as
  // five spans all touching the night's right edge. When at least one
  // timeline writer covers the session, summary-only writers are out of
  // the running BEFORE the richness count — WHOOP's guaranteed full-house
  // stage count must not eliminate a partial but genuinely-timed Apple
  // night. A summary-only writer still wins nights nobody else recorded.
  const distinctInstantsOf = (writerRows: readonly SleepStageRow[]): number =>
    new Set(writerRows.map((r) => r.measuredAt.getTime())).size;
  const timelineWriters = writers.filter(
    (key) => distinctInstantsOf(rowsByWriter.get(key) ?? []) > 1,
  );
  if (timelineWriters.length > 0) {
    writers = timelineWriters;
  }
  // Richness gate among the survivors: most distinct granular stages wins.
  let maxTimedRichness = 0;
  for (const key of writers) {
    const score = richnessOf.get(key) ?? 0;
    if (score > maxTimedRichness) maxTimedRichness = score;
  }
  if (maxTimedRichness > 0) {
    writers = writers.filter((key) => richnessOf.get(key) === maxTimedRichness);
  }
  if (writers.length <= 1) return writers[0] ?? NO_SOURCE;

  const rankOf = (key: string): number => {
    const i = sleepLadder.indexOf(sourceOfWriterKey(key) as MeasurementSource);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const deviceRankOf = (key: string): number => {
    const i = deviceLadder.indexOf(deviceOfWriterKey(key));
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return writers.sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    const da = deviceRankOf(a);
    const db = deviceRankOf(b);
    if (da !== db) return da - db;
    // Neither (or both) on both ladders — most asleep minutes wins, then key.
    const ma = asleepByWriter.get(a) ?? 0;
    const mb = asleepByWriter.get(b) ?? 0;
    if (ma !== mb) return mb - ma;
    return a < b ? -1 : 1;
  })[0];
}

/**
 * Group raw per-stage rows into per-night totals. Stages are clustered into
 * sleep SESSIONS by time gap (a > `SESSION_GAP_MS` gap starts a new session),
 * each session keyed by the LOCAL WAKE DAY of its last segment, then collapsed
 * to ONE source via the user's `sleep` priority ladder before summing.
 *
 * Pure — the caller does the bounded DB read. `priorityJson` is the user's
 * persisted `sourcePriorityJson` (or null for the defaults). Nights are
 * returned sorted ascending by key so the last element is the most recent
 * night.
 */
export function reconstructSleepNights(
  rows: SleepStageRow[],
  tz: string,
  priorityJson: unknown = null,
): SleepNight[] {
  if (rows.length === 0) return [];
  const resolvedPriority = parseSourcePriority(priorityJson);
  const sleepLadder = getSourceLadder(resolvedPriority, "sleep");
  const deviceLadder = getDeviceTypeLadder(resolvedPriority, "SLEEP_DURATION");

  // Cluster into sessions by the gap between a segment's START and the latest
  // END seen so far in the current session. `measuredAt` is the segment END;
  // the segment START is `end − value minutes`. A new session begins only when
  // the next segment STARTS more than SESSION_GAP_MS after the running end —
  // so a single long stage block (a 4 h CORE) does NOT split a night, and two
  // sources' interleaved/overlapping rows for the same night stay together
  // (their gap is ≤ 0). Gaps are absolute-time, so the clustering is DST-immune.
  // Sort by START so contiguous segments compare end-to-start in order.
  const startOf = (r: SleepStageRow): number =>
    r.measuredAt.getTime() - (Number.isFinite(r.value) ? r.value : 0) * 60_000;
  const sorted = [...rows].sort((a, b) => startOf(a) - startOf(b));
  const sessions: SleepStageRow[][] = [];
  let current: SleepStageRow[] = [];
  let sessionEnd = Number.NEGATIVE_INFINITY;
  for (const r of sorted) {
    const start = startOf(r);
    const end = r.measuredAt.getTime();
    if (current.length > 0 && start - sessionEnd > SESSION_GAP_MS) {
      sessions.push(current);
      current = [];
      sessionEnd = Number.NEGATIVE_INFINITY;
    }
    current.push(r);
    if (end > sessionEnd) sessionEnd = end;
  }
  if (current.length > 0) sessions.push(current);

  // Two sessions can land on the same wake day (e.g. a genuine overnight plus
  // a same-day nap); collect each session's canonical-writer rows under one
  // wake-day key. The rows are grouped PER SESSION (not flattened) so the
  // granular-over-bare gate and the asleep total are decided per session — a
  // bare-only nap keeps its minutes even when the overnight session is
  // granular (the v1.11.5 merged-night nap under-count fix). The FULL
  // session row set rides along because the in-bed envelope spans every
  // writer, not just the winner (see the module doc's writer-de-dup
  // exception).
  const byNight = new Map<
    string,
    Array<{ pool: SleepStageRow[]; all: SleepStageRow[] }>
  >();
  for (const session of sessions) {
    const canonical = pickSessionWriter(session, sleepLadder, deviceLadder);
    const kept = session.filter((r) => writerKeyOf(r) === canonical);
    const pool = kept.length > 0 ? kept : session;
    // The wake day is the session's latest row end (Apple Health attributes
    // a session to the morning you wake up), over every writer.
    const key = wakeDayOf(session, tz);
    const list = byNight.get(key) ?? [];
    list.push({ pool, all: session });
    byNight.set(key, list);
  }

  const nights: SleepNight[] = [];
  for (const [night, nightSessions] of byNight) {
    let inBed = 0;
    let awake = 0;
    let sawInBed = false;
    let sawAwake = false;
    let asleep = 0;
    // `nightSessions` and each session pool are non-empty by construction: a
    // key is only added with a `pool` that has ≥ 1 row (the source-filter falls
    // back to the full session when the canonical filter empties it), so
    // `nightSessions[0].pool[0]` is safe. Unlike `reconstructSleepSessions`,
    // this function never applies the granular-over-bare filter to the indexed
    // pool, so it cannot empty the array here. Keep that invariant on future
    // edits.
    let latest = nightSessions[0].pool[0].measuredAt;
    const stages: Partial<Record<SleepStage, number>> = {};
    // MAIN session of the night = the main sleep (not a daytime nap) with
    // the most asleep minutes (same per-session asleep total the headline
    // sums; tie → later wake instant), exactly as `pickMainNightAndNaps`. Its FULL raw row set (every writer,
    // pre-collapse) feeds the night's source-discrepancy annotation —
    // per session, so a nap's writers never cross-compare against the
    // overnight block's.
    let mainSessionRows: SleepStageRow[] | null = null;
    let mainSessionAsleep = 0;
    let mainSessionEnd = Number.NEGATIVE_INFINITY;
    for (const { pool: sessionRows, all } of nightSessions) {
      // In-bed: union envelope across ALL writers in the session (sessions
      // are > 3 h apart, so per-session envelopes never overlap and summing
      // them per wake day is exact).
      const envelope = inBedEnvelopeMinutes(all);
      if (envelope !== null) {
        inBed += envelope;
        sawInBed = true;
        // ONE quantity, ONE computation: `stages.IN_BED` IS the in-bed
        // envelope, so the legend can never contradict the headline. The
        // per-stage loop below skips IN_BED entirely for that reason.
        stages.IN_BED = (stages.IN_BED ?? 0) + envelope;
      }
      // v1.11.5 — decide the granular-over-bare gate PER SESSION. A granular
      // overnight does not strip a bare-only nap's minutes, and the per-stage
      // `stages` map drops the redundant bare ASLEEP aggregate only for the
      // session that also carries the granular partition.
      const sawGranular = sawGranularStage(sessionRows);
      // Asleep total: sum per session so a granular overnight + a bare-only
      // nap both contribute (the merged-night nap under-count fix).
      const sessionAsleep = asleepMinutesOf(sessionRows);
      asleep += sessionAsleep;
      let sessionEnd = Number.NEGATIVE_INFINITY;
      for (const r of sessionRows) {
        if (r.measuredAt.getTime() > latest.getTime()) latest = r.measuredAt;
        if (r.measuredAt.getTime() > sessionEnd)
          sessionEnd = r.measuredAt.getTime();
      }
      // Per-stage totals come from the OVERLAP-MERGED spans, never from the
      // raw row sum: a device that re-exports a period it already wrote (a
      // corrected envelope — same start, later end, fresh external id) would
      // otherwise have both rows added and report the period twice. The
      // granular-over-bare filter runs first, so `stages` is never the
      // granular set PLUS its ~equal bare twin. IN_BED is skipped — it is the
      // envelope, already carried above from the same union as `inBedMinutes`.
      const merged = mergeOverlappingSegments(
        sessionRows
          .filter((r) => !isRedundantBareAsleep(r.sleepStage, sawGranular))
          .map(segmentOf),
      );
      for (const seg of merged) {
        const stage = seg.stage;
        if (stage == null || stage === "IN_BED") continue;
        stages[stage] = (stages[stage] ?? 0) + seg.minutes;
        if (stage === "AWAKE") {
          awake += seg.minutes;
          sawAwake = true;
        }
      }
      if (
        sessionAsleep > 0 &&
        !isDaytimeNap(
          sessionAsleep,
          asleepMidpointMinutes(
            new Date(sessionEnd),
            sessionAsleep,
            sessionZoneOf(all, tz),
          ),
        ) &&
        (sessionAsleep > mainSessionAsleep ||
          (sessionAsleep === mainSessionAsleep && sessionEnd > mainSessionEnd))
      ) {
        mainSessionAsleep = sessionAsleep;
        mainSessionEnd = sessionEnd;
        mainSessionRows = all;
      }
    }
    nights.push({
      night,
      measuredAt: latest,
      asleepMinutes: asleep,
      inBedMinutes: sawInBed ? inBed : null,
      awakeMinutes: sawAwake ? awake : null,
      stages,
      sourceDiscrepancy: mainSessionRows
        ? sessionSourceDiscrepancy(mainSessionRows)
        : null,
      mainSession:
        mainSessionRows && mainSessionAsleep > 0
          ? {
              end: new Date(mainSessionEnd),
              asleepMinutes: mainSessionAsleep,
              timeZone: sessionZoneOf(mainSessionRows, tz),
            }
          : null,
    });
  }
  return nights.sort((a, b) => (a.night < b.night ? -1 : 1));
}

/**
 * One reconstructed sleep SEGMENT — a single stage row resolved to its
 * absolute start / end span. `start = measuredAt − value·60_000` because
 * `measuredAt` is the segment END instant (`apple-health-mapping.ts` sets
 * `takenAt = endDate`). Used by the hypnogram view to lay each stage onto
 * a clock-time lane.
 */
export interface SleepSegment {
  stage: SleepStage | null;
  /** Absolute segment start instant (end − duration). */
  start: Date;
  /** Absolute segment end instant (= the stored `measuredAt`). */
  end: Date;
  /** Duration in minutes (= the stored `value`). */
  minutes: number;
}

/**
 * One reconstructed sleep SESSION — a contiguous block of segments (no
 * gap > `SESSION_GAP_MS`) collapsed to ONE canonical source. This is the
 * unit the hypnogram renders and the nap convention separates (main night
 * vs nap). Distinct from `SleepNight`, which merges same-wake-day sessions
 * under one key for the headline number.
 */
export interface SleepSession {
  /**
   * Wake-day key (YYYY-MM-DD) of the session's last segment, in that row's
   * own zone when it has one, in the user tz otherwise.
   */
  night: string;
  /** The zone the session is read in when it is not the profile zone. */
  timeZone: string | null;
  /** The canonical ingest source whose segments were kept (null = none). */
  source: MeasurementSource | null;
  /** Session start instant — earliest segment start. */
  start: Date;
  /** Session end instant — latest segment end (the wake instant). */
  end: Date;
  /** Time asleep in minutes (granular-over-bare rule). */
  asleepMinutes: number;
  /**
   * In-bed minutes when an IN_BED row exists anywhere in the session,
   * else null. Union envelope across ALL writers (not just the
   * canonical one) — see the module doc's writer-de-dup exception.
   */
  inBedMinutes: number | null;
  /** Awake-in-bed minutes when an AWAKE segment exists, else null. */
  awakeMinutes: number | null;
  /**
   * Per-stage minutes for the session. Every entry is the measure of the
   * UNION of that stage's spans, never the raw row sum, so a corrected
   * re-export of a period is counted once. Stages other than IN_BED come
   * from the canonical writer only; `stages.IN_BED` is the all-writer
   * envelope and therefore always equals `inBedMinutes`.
   */
  stages: Partial<Record<SleepStage, number>>;
  /**
   * Count of AWAKE segments between the first and last asleep segment —
   * the mid-sleep awakenings (a leading / trailing AWAKE before sleep
   * onset or after final wake is not an awakening). Computed from the
   * canonical source's segments only.
   */
  awakenings: number;
  /**
   * The canonical source's segments, sorted by start, for the hypnogram.
   * Overlapping spans of the same stage are merged, so a corrected
   * re-export never draws a second bar across the night it revises.
   */
  segments: SleepSegment[];
  /**
   * `true` when the winning writer's stage ORDER is synthesised rather than
   * measured. WHOOP's v2 API returns only per-stage duration totals — no onset
   * timestamps — so the server reconstructs a contiguous timeline in a fixed
   * physiological order (`whoop/client.ts` `mapSleep`). The segment positions
   * are then approximate, not measured, and the UI / iOS must label the night
   * as an approximate layout (never present it as measured stage timing).
   * Sources that store a real per-segment series (Apple Health, Withings,
   * Fitbit) stay `false`.
   */
  reconstructed: boolean;
  /**
   * Non-null when two writer buckets reported clearly different asleep
   * totals for this session (see `sessionSourceDiscrepancy`). Observational
   * only — the served `asleepMinutes` stays the winning writer's total; the
   * annotation lets the UI mark the number with a discreet
   * "sources disagree" hint.
   */
  sourceDiscrepancy: SleepSourceDiscrepancy | null;
  /**
   * `true` when the session is a daytime nap rather than a main sleep
   * (`isDaytimeNap`). Decided here, once, so the nap convention, the sleep
   * score and every list read the same answer.
   */
  daytimeNap: boolean;
}

/** Resolve a stage row to its absolute span (start = end − duration). */
function segmentOf(r: SleepStageRow): SleepSegment {
  const minutes = Number.isFinite(r.value) ? r.value : 0;
  const end = r.measuredAt;
  const start = new Date(end.getTime() - minutes * 60_000);
  return { stage: r.sleepStage, start, end, minutes };
}

/** Map key for stage-less (`null`) spans — they group among themselves. */
const NULL_STAGE_KEY = "__null_stage__";

/**
 * Merge the spans of ONE stage that genuinely OVERLAP into their interval
 * union. A device re-exporting a period it already wrote (a corrected
 * envelope: same start, later end, fresh external id) lands as a SECOND row
 * describing the SAME minutes, and adding both minute counts reports the
 * night twice. The union is the only defensible total for two spans that
 * describe one period, and it needs no arbitration — both rows say the same
 * thing about the contested minute.
 *
 * Overlap is STRICT (`start < runningEnd`): two spans that merely TOUCH
 * (`start === runningEnd`) describe consecutive periods, so they stay two
 * segments — their union already equals their sum, and coalescing them would
 * silently drop one mid-sleep awakening from `countAwakenings`.
 *
 * A group of exactly one span is returned VERBATIM, so a well-formed night
 * (no overlap anywhere) keeps the stored per-row minutes bit-for-bit and only
 * a genuinely doubled export is rewritten.
 */
function mergeStageSpans(spans: readonly SleepSegment[]): SleepSegment[] {
  if (spans.length <= 1) return [...spans];
  const sorted = [...spans].sort(
    (a, b) =>
      a.start.getTime() - b.start.getTime() ||
      a.end.getTime() - b.end.getTime(),
  );
  const out: SleepSegment[] = [];
  let group: SleepSegment[] = [sorted[0]];
  let groupEnd = sorted[0].end.getTime();
  const flush = (): void => {
    if (group.length === 1) {
      out.push(group[0]);
      return;
    }
    const start = group[0].start;
    out.push({
      stage: group[0].stage,
      start,
      end: new Date(groupEnd),
      minutes: (groupEnd - start.getTime()) / 60_000,
    });
  };
  for (let i = 1; i < sorted.length; i++) {
    const span = sorted[i];
    if (span.start.getTime() < groupEnd) {
      group.push(span);
      if (span.end.getTime() > groupEnd) groupEnd = span.end.getTime();
    } else {
      flush();
      group = [span];
      groupEnd = span.end.getTime();
    }
  }
  flush();
  return out;
}

/**
 * Collapse a segment list so no two segments of the SAME stage overlap,
 * returning the result sorted by start. Stages are merged INDEPENDENTLY —
 * a CORE span overlapping a DEEP span is left alone, because that is not a
 * doubled export but a contest over what the minute WAS, and the file already
 * owns one mechanism for that contest: `pickSessionWriter` collapses the
 * session to a single writer before anything is summed. Arbitrating across
 * stages here would also destroy the summary-shaped writers on purpose:
 * WHOOP / Polar stamp every stage total on the sleep END instant, so their
 * stage spans nest inside one another by design and their union is one
 * stage's length, not the night.
 *
 * The consequence is the invariant this function exists to guarantee: every
 * stage total is the MEASURE OF THE UNION of that stage's spans, so no stage
 * total can exceed the session's own envelope.
 */
function mergeOverlappingSegments(
  segments: readonly SleepSegment[],
): SleepSegment[] {
  const byStage = new Map<string, SleepSegment[]>();
  for (const seg of segments) {
    const key = seg.stage ?? NULL_STAGE_KEY;
    const list = byStage.get(key) ?? [];
    list.push(seg);
    byStage.set(key, list);
  }
  const out: SleepSegment[] = [];
  for (const list of byStage.values()) out.push(...mergeStageSpans(list));
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Count mid-sleep awakenings from a session's segments. An AWAKE segment
 * counts only when it sits BETWEEN the first and last asleep segment — a
 * leading AWAKE before sleep onset or a trailing AWAKE after the final
 * wake is settling-in / lie-in, not a fragmentation event. IN_BED is
 * ignored entirely.
 */
function countAwakenings(segments: readonly SleepSegment[]): number {
  const sorted = [...segments].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  const isAsleep = (s: SleepSegment): boolean =>
    s.stage != null &&
    (GRANULAR_ASLEEP_STAGES.has(s.stage) || s.stage === "ASLEEP");
  let firstAsleep = -1;
  let lastAsleep = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (isAsleep(sorted[i])) {
      if (firstAsleep === -1) firstAsleep = i;
      lastAsleep = i;
    }
  }
  if (firstAsleep === -1 || lastAsleep <= firstAsleep) return 0;
  let count = 0;
  for (let i = firstAsleep + 1; i < lastAsleep; i++) {
    if (sorted[i].stage === "AWAKE") count += 1;
  }
  return count;
}

/**
 * Reconstruct per-SESSION sleep blocks from raw per-stage rows. Unlike
 * `reconstructSleepNights` (which merges same-wake-day sessions under one
 * key for the single headline number), this returns EACH session
 * separately so a caller can render the night's hypnogram and surface a
 * daytime nap as its own block. Every session is collapsed to ONE
 * canonical source via the user's `sleep` priority ladder, so two sources'
 * timelines never overlay.
 *
 * Pure — the caller does the bounded DB read. Sessions are returned sorted
 * ascending by start, so the last element is the most recent session.
 */
export function reconstructSleepSessions(
  rows: SleepStageRow[],
  tz: string,
  priorityJson: unknown = null,
): SleepSession[] {
  if (rows.length === 0) return [];
  const resolvedPriority = parseSourcePriority(priorityJson);
  const sleepLadder = getSourceLadder(resolvedPriority, "sleep");
  const deviceLadder = getDeviceTypeLadder(resolvedPriority, "SLEEP_DURATION");

  const startOf = (r: SleepStageRow): number =>
    r.measuredAt.getTime() - (Number.isFinite(r.value) ? r.value : 0) * 60_000;
  const sorted = [...rows].sort((a, b) => startOf(a) - startOf(b));
  const rawSessions: SleepStageRow[][] = [];
  let current: SleepStageRow[] = [];
  let sessionEnd = Number.NEGATIVE_INFINITY;
  for (const r of sorted) {
    const start = startOf(r);
    const end = r.measuredAt.getTime();
    if (current.length > 0 && start - sessionEnd > SESSION_GAP_MS) {
      rawSessions.push(current);
      current = [];
      sessionEnd = Number.NEGATIVE_INFINITY;
    }
    current.push(r);
    if (end > sessionEnd) sessionEnd = end;
  }
  if (current.length > 0) rawSessions.push(current);

  const sessions: SleepSession[] = [];
  for (const session of rawSessions) {
    const canonical = pickSessionWriter(session, sleepLadder, deviceLadder);
    const kept = session.filter((r) => writerKeyOf(r) === canonical);
    const pool = kept.length > 0 ? kept : session;
    // v1.11.5 — drop the redundant bare ASLEEP aggregate (and stage-less
    // rows) from the hypnogram segments AND the per-stage breakdown when the
    // session also carries the granular CORE/DEEP/REM partition, so the
    // hypnogram never draws a double-height ASLEEP lane on top of the
    // granular stages and the `stages` map is the granular set OR the bare
    // aggregate, never both.
    const sawGranular = sawGranularStage(pool);
    // Overlapping spans of ONE stage merge into their union before anything
    // is drawn or summed: a corrected re-export (same start, later end, fresh
    // external id) must not paint a second bar over the night it revises, nor
    // add its minutes on top of the row it supersedes. Returned sorted by
    // start, as the hypnogram expects.
    const segments = mergeOverlappingSegments(
      pool
        .filter((r) => !isRedundantBareAsleep(r.sleepStage, sawGranular))
        .map(segmentOf),
    );

    // The granular-over-bare filter can empty a non-empty pool (a session whose
    // only rows are the redundant bare ASLEEP aggregate / stage-less twins of a
    // granular partition that did not survive into this pool). A session with no
    // renderable/scorable segment contributes nothing — skip it before indexing
    // `segments[0]`. This keeps `reconstructSleepSessions` total: it must NEVER
    // throw on a shape the dedup empties, so `GET /api/sleep/night` (and every
    // other consumer) returns a valid empty night, never a 500.
    if (segments.length === 0) continue;

    let awake = 0;
    let sawAwake = false;
    const stages: Partial<Record<SleepStage, number>> = {};
    // In-bed: union envelope across ALL writers in the RAW session — the
    // canonical (winning) writer often carries no IN_BED row at all (a
    // watch's stage export) while the losing writer holds the night's
    // only in-bed window (the phone's bedtime detection). ONE quantity,
    // ONE computation: `stages.IN_BED` IS that envelope, so the legend can
    // never contradict the headline — which is why the per-stage loop
    // below must skip IN_BED instead of adding the winner's own spans on
    // top of it. The hypnogram `segments` stay winner-only.
    const inBedEnvelope = inBedEnvelopeMinutes(session);
    if (inBedEnvelope !== null) stages.IN_BED = inBedEnvelope;
    let earliest = segments[0].start;
    let latest = segments[0].end;
    for (const seg of segments) {
      if (seg.start.getTime() < earliest.getTime()) earliest = seg.start;
      if (seg.end.getTime() > latest.getTime()) latest = seg.end;
      const stage = seg.stage;
      // IN_BED is skipped here — it is the session ENVELOPE, filled in below
      // from the very computation `inBedMinutes` reports, so the two can never
      // disagree.
      if (stage == null || stage === "IN_BED") continue;
      stages[stage] = (stages[stage] ?? 0) + seg.minutes;
      if (stage === "AWAKE") {
        awake += seg.minutes;
        sawAwake = true;
      }
    }
    const asleep = asleepMinutesOf(pool);
    const canonicalSource = sourceOfWriterKey(canonical);
    const zone = sessionZoneOf(session, tz);
    sessions.push({
      night: wakeDayOf(session, tz),
      // The session's own zone when its rows carry one; null means the
      // profile zone (the night was not slept elsewhere, or not marked).
      timeZone: zone === tz ? null : zone,
      source:
        canonicalSource === NO_SOURCE
          ? null
          : (canonicalSource as MeasurementSource),
      start: earliest,
      end: latest,
      asleepMinutes: asleep,
      inBedMinutes: inBedEnvelope,
      awakeMinutes: sawAwake ? awake : null,
      stages,
      awakenings: countAwakenings(segments),
      segments,
      // The winning writer's stage order is synthetic when its source
      // reconstructs the timeline (WHOOP). The UI labels such a night as an
      // approximate layout; a real-series source (Apple/Withings/Fitbit) is
      // measured.
      reconstructed: RECONSTRUCTED_TIMELINE_SOURCES.has(canonicalSource),
      // Compared across the RAW session (every writer, pre-collapse) so a
      // losing bucket's disagreement is visible; the served totals above
      // stay winner-only.
      sourceDiscrepancy: sessionSourceDiscrepancy(session),
      daytimeNap: isDaytimeNap(
        asleep,
        asleepMidpointMinutes(latest, asleep, zone),
      ),
    });
  }
  return sessions.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Apply the NAP convention to a wake-day's sessions. The MAIN night is the
 * main-sleep session (see `isDaytimeNap`) with the most asleep minutes,
 * normally the overnight block; every other scorable session on the same wake
 * day is a nap, surfaced separately and never folded into the main night's
 * headline. A day whose only sleep is daytime naps has no main night: `main`
 * is null and the naps are all there is.
 *
 * Returns the main session plus the naps (sorted by start). When the input
 * holds sessions across multiple wake days, only the sessions matching the
 * main session's wake day (or, without one, the latest session's) are
 * considered naps — call once per wake day, or pass a single wake day's
 * sessions.
 */
export function pickMainNightAndNaps(sessions: readonly SleepSession[]): {
  main: SleepSession | null;
  naps: SleepSession[];
} {
  const scorable = sessions.filter((s) => s.asleepMinutes > 0);
  if (scorable.length === 0) return { main: null, naps: [] };
  // Main = most asleep minutes among the main sleeps; tie-break on the later
  // end (overnight wins).
  const main =
    scorable
      .filter((s) => !s.daytimeNap)
      .sort((a, b) => {
        if (b.asleepMinutes !== a.asleepMinutes)
          return b.asleepMinutes - a.asleepMinutes;
        return b.end.getTime() - a.end.getTime();
      })[0] ?? null;
  const day =
    main?.night ??
    scorable.reduce((a, b) => (b.end.getTime() > a.end.getTime() ? b : a))
      .night;
  const naps = scorable
    .filter((s) => s !== main && s.night === day)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return { main, naps };
}

/** One wake day resolved into its main night and that day's naps. */
export interface SleepDaySplit {
  /** Wake-day key (YYYY-MM-DD) in the user's timezone. */
  night: string;
  /**
   * The main sleep (see `pickMainNightAndNaps`), or null on a day whose only
   * sleep is daytime naps.
   */
  main: SleepSession | null;
  /** Every other scorable session on the same wake day, sorted by start. */
  naps: SleepSession[];
}

/**
 * Run the NAP convention across a whole span of sessions: group them by wake
 * day and apply `pickMainNightAndNaps` to each day.
 *
 * This exists so every surface that needs "which session was the night?" over
 * more than one day asks the SAME question the single-day surfaces ask, rather
 * than growing its own idea of a night. There is exactly one nap classifier in
 * this codebase and it is `pickMainNightAndNaps`; this is its multi-day form.
 *
 * Days whose sessions carry no asleep minutes are dropped; a day of naps
 * alone is kept with `main` null. The result is sorted ascending by wake day.
 */
export function separateNightsAndNaps(
  sessions: readonly SleepSession[],
): SleepDaySplit[] {
  const byDay = new Map<string, SleepSession[]>();
  for (const session of sessions) {
    const list = byDay.get(session.night);
    if (list) list.push(session);
    else byDay.set(session.night, [session]);
  }
  const days: SleepDaySplit[] = [];
  for (const [night, daySessions] of byDay) {
    const { main, naps } = pickMainNightAndNaps(daySessions);
    if (!main && naps.length === 0) continue;
    days.push({ night, main, naps });
  }
  return days.sort((a, b) => a.night.localeCompare(b.night));
}

/**
 * A wake day's sleep total, the one definition every reader states: the main
 * night plus every nap of the day. It equals `SleepNight.asleepMinutes` for
 * the same rows (both sum each session's canonical-writer asleep minutes),
 * which is what the series, the sleep score and the composition read; the
 * main night alone stays available as `main.asleepMinutes` /
 * `SleepNight.mainSession`. A day of naps alone totals its naps, not 0.
 */
export function daySleepMinutes(day: {
  main: SleepSession | null;
  naps: readonly SleepSession[];
}): number {
  return (
    (day.main?.asleepMinutes ?? 0) +
    day.naps.reduce((sum, nap) => sum + nap.asleepMinutes, 0)
  );
}

export interface SleepNightSummary {
  /**
   * A `DataSummary` whose every value is a per-night TIME-ASLEEP total
   * (minutes). Drop-in replacement for the per-stage `summaries.
   * SLEEP_DURATION` the slim slice produced. Null when no night has any
   * asleep minutes in the supplied rows.
   */
  summary: DataSummary;
  /** The most recent night (for the dashboard/series headline), or null. */
  latestNight: SleepNight | null;
}

/**
 * Reconstruct nights from raw rows and summarise the per-night asleep
 * totals. Nights with zero asleep minutes are dropped (an IN_BED-only or
 * AWAKE-only fragment is not a scorable night). The returned `summary`
 * uses one DataPoint per night so `summarize()`'s windowed avg7 / avg30
 * become "average nightly sleep over the trailing N days".
 */
export function summarizeSleepNights(
  rows: SleepStageRow[],
  tz: string,
  priorityJson: unknown = null,
): SleepNightSummary {
  return summarizeNights(reconstructSleepNights(rows, tz, priorityJson));
}

/**
 * `summarizeSleepNights` over nights already reconstructed, for a reader
 * that gets them from the chunked Postgres walk (`readSleepNights`) instead
 * of holding the stage rows itself.
 */
export function summarizeNights(all: readonly SleepNight[]): SleepNightSummary {
  const nights = all.filter((n) => n.asleepMinutes > 0);
  const dataPoints = nights.map((n) => ({
    date: n.measuredAt,
    value: n.asleepMinutes,
  }));
  return {
    summary: summarize(dataPoints),
    latestNight: nights.length > 0 ? nights[nights.length - 1] : null,
  };
}
