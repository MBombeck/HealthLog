/**
 * The one rule that tells a night's recorded stage order from its stage
 * totals, read by the night reader (`analytics/sleep-night.ts`). It sits
 * beside the builder that lays totals out (`reconstruct-timeline.ts`), so the
 * order the builder writes and the order this rule recognises are one
 * constant.
 */
import type { SleepStage } from "@/generated/prisma/client";
import { LAID_OUT_STAGE_ORDER } from "@/lib/sleep/reconstruct-timeline";

/** The part of a sleep segment the rule reads. */
export interface StageSpan {
  stage: SleepStage | null;
  start: Date;
  end: Date;
}

/**
 * Slack for comparing span edges. Stage minutes are stored rounded to two
 * decimals, so a span's derived start (`end − minutes`) can sit a fraction of
 * a second off the edge it was laid against.
 */
const SPAN_EDGE_TOLERANCE_MS = 60_000;

/**
 * Whether a writer's spans describe the ORDER the stages came in, or only how
 * long each one lasted. This is the one rule every surface reads — the night
 * DTO's `reconstructed` flag (web hypnogram, iOS), the awakenings count, and
 * the writer pick of a night two sources describe — and it is decided from
 * the shape of the spans, never from the source's name, so a new integration
 * that ships totals is caught without being listed anywhere.
 *
 * Two shapes carry totals and no order:
 *   - every stage stamped on one instant: the stage totals all end (or all
 *     start) together, so the spans nest inside each other against one edge
 *     (Garmin's daily sleep summary, Oura's stage-total fallback, WHOOP rows
 *     written before its timeline backfill);
 *   - the ingest builder's layout of totals (WHOOP, Polar via
 *     `reconstructContiguousSleepTimeline`): three or more spans, each stage
 *     exactly once, back to back, in `LAID_OUT_STAGE_ORDER`. A measured
 *     night alternates through its cycles, so it repeats stages.
 *
 * IN_BED is the night's envelope, not a stage of it, and zero-length spans
 * carry nothing, so both are left out. One span has no order to get wrong and
 * reads as a timeline; no span at all is not one.
 *
 * The limit: a measured session that happens to run AWAKE → CORE → DEEP →
 * REM once each, back to back, has the layout's shape and is read as totals.
 * The cost is a note instead of a chart for that one session; the other way
 * round draws an order nobody measured. Two spans are never read as a layout,
 * so a partial measured night stays a timeline.
 */
export function hasStageTimeline(segments: readonly StageSpan[]): boolean {
  const staged = segments
    .filter(
      (s) => s.stage !== "IN_BED" && s.end.getTime() - s.start.getTime() > 0,
    )
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (staged.length === 0) return false;
  if (staged.length === 1) return true;
  const spread = (values: number[]): number =>
    Math.max(...values) - Math.min(...values);
  if (spread(staged.map((s) => s.end.getTime())) <= SPAN_EDGE_TOLERANCE_MS) {
    return false;
  }
  if (spread(staged.map((s) => s.start.getTime())) <= SPAN_EDGE_TOLERANCE_MS) {
    return false;
  }
  if (staged.length < 3) return true;
  let previousRank = -1;
  for (let i = 0; i < staged.length; i++) {
    const rank = LAID_OUT_STAGE_ORDER.indexOf(
      staged[i].stage as (typeof LAID_OUT_STAGE_ORDER)[number],
    );
    // A stage off the layout's list, a repeat, or a step back: measured.
    if (rank <= previousRank) return true;
    previousRank = rank;
    if (i === 0) continue;
    const gap = staged[i].start.getTime() - staged[i - 1].end.getTime();
    if (Math.abs(gap) > SPAN_EDGE_TOLERANCE_MS) return true;
  }
  return false;
}
