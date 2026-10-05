/**
 * Sleep blocks for the Coach snapshot.
 *
 * Two sections, both gated on the `sleep` source:
 *   - the v1.7.0 per-night timeline (with optional per-stage enrichment),
 *     reconstructed through the shared sleep-night helper so the Coach
 *     narrates the same nightly numbers every other sleep surface shows;
 *   - the v1.17.0 sleep-rhythm summary (sleep-debt + chronotype), built
 *     from the SAME assembler the dashboard route uses over the rhythm's
 *     own fixed trailing-42-day rows.
 *
 * Split out of `snapshot.ts`; the builder passes the rows it already
 * read plus the shared accumulators, so the emitted shape and ordering
 * are unchanged.
 */
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import {
  reconstructNights,
  sleepNeedMinutes,
} from "@/lib/insights/derived/sleep-score";
import {
  computeSleepRhythmFromNights,
  type SleepRhythmDto,
} from "@/lib/insights/derived/sleep-rhythm";
import { annotate } from "@/lib/logging/context";
import type { ReferenceMetric } from "@/lib/reference-ranges";
import { bucketWeekly, tzWeekday } from "../snapshot-series";
import type { RegisterBlock } from "../series-condense";
import type {
  CoachProvenance,
  CoachProvenanceMetric,
  CoachScopeSource,
} from "../types";

interface SleepTimelineBlockContext {
  sleepRows: SleepStageRow[];
  sourcePriorityJson: unknown;
  userTz: string;
  recentCutoff: Date;
  snapshot: Record<string, unknown>;
  metrics: Set<CoachProvenanceMetric>;
  counts: NonNullable<CoachProvenance["counts"]>;
  registerBlock: RegisterBlock;
  groundingValues: Map<ReferenceMetric, number>;
}

/**
 * ── v1.7.0 sleep block (with optional per-stage enrichment) ───────
 *
 * Sleep needs the `sleepStage` column so the Coach can narrate REM /
 * core / deep / awake minutes per night instead of a flat duration.
 * The shared `byType("SLEEP_DURATION")` rows already cover the
 * duration timeline, but they drop the stage label — so the sleep
 * branch builds its own block. Per-night stage minutes come from a
 * dedicated read of the SLEEP_DURATION rows that carry a non-null
 * stage; the duration timeline is built from the same rows summed per
 * night (one night = the sum of its per-stage rows).
 */
export function buildSleepTimelineBlock(
  ctx: Readonly<SleepTimelineBlockContext>,
): void {
  const {
    sleepRows,
    sourcePriorityJson,
    userTz,
    recentCutoff,
    snapshot,
    metrics,
    counts,
    registerBlock,
    groundingValues,
  } = ctx;
  // The SLEEP_DURATION rows (with the `sleepStage` column) are read in
  // parallel by the builder.
  if (sleepRows.length === 0) {
    annotate({
      action: { name: "coach.cluster.empty_skipped" },
      meta: { cluster: "sleep", source: "sleep" },
    });
  } else {
    // v1.11.5 — reconstruct per-night TIME-ASLEEP totals through the shared
    // helper so the Coach narrates the same nightly numbers every other
    // sleep surface shows: stages clustered into sessions, a dual-source
    // night collapsed to one canonical source, and the granular
    // CORE/DEEP/REM partition counted WITHOUT double-counting the bare
    // ASLEEP aggregate Apple Health writes alongside it. IN_BED + AWAKE are
    // excluded from the asleep total.
    const nights = reconstructSleepNights(
      sleepRows,
      userTz,
      sourcePriorityJson,
    ).filter((n) => n.asleepMinutes > 0);
    // Recent nights: asleep duration + stage breakdown when present.
    const recentNights = nights
      .filter((n) => n.measuredAt >= recentCutoff)
      .map((n) => {
        const row: Record<string, unknown> = {
          // The night's own key, the local day it ends on: the key the
          // sleep table under the answer and every sleep surface use. The
          // wake instant in UTC named the day before east of UTC, so the
          // prose and the table disagreed about which night it was.
          date: n.night,
          weekday: tzWeekday(n.measuredAt, userTz),
          minutes: Math.round(n.asleepMinutes),
        };
        const stageEntries = Object.entries(n.stages).filter(
          ([stage]) => stage !== "IN_BED" && stage !== "AWAKE",
        );
        if (stageEntries.length > 0) {
          row.stages = Object.fromEntries(
            stageEntries.map(([k, v]) => [
              k.toLowerCase(),
              Math.round(v as number),
            ]),
          );
        }
        return row;
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const olderNights = nights
      .filter((n) => n.measuredAt < recentCutoff)
      .map((n) => ({ measuredAt: n.measuredAt, value: n.asleepMinutes }));
    snapshot.sleep = {
      timeline: {
        recent: recentNights,
        weekly: bucketWeekly(olderNights, userTz),
      },
    };
    metrics.add("sleep");
    counts.sleep = sleepRows.length;
    registerBlock("sleep", "sleep", () => ({
      value: nights.map((n) => ({
        date: n.night,
        value: Math.round(n.asleepMinutes),
      })),
    }));
    // W7 grounding: recent nightly asleep duration in HOURS against the
    // AASM 7–9 h band (the reference unit is hours; the snapshot stores
    // minutes). Mean over the recent nights the block already reconstructed.
    if (recentNights.length > 0) {
      const meanMin =
        recentNights.reduce(
          (s, n) => s + (typeof n.minutes === "number" ? n.minutes : 0),
          0,
        ) / recentNights.length;
      if (meanMin > 0) {
        groundingValues.set("SLEEP_DURATION", meanMin / 60);
      }
    }
  }
}

interface SleepRhythmBlockContext {
  sleepRhythmRows: SleepStageRow[];
  sourcePriorityJson: unknown;
  userTz: string;
  ageYears: number | null;
  snapshot: Record<string, unknown>;
  metrics: Set<CoachProvenanceMetric>;
  registerBlock: (key: string, source: CoachScopeSource) => void;
}

/**
 * ── v1.17.0 sleep-rhythm block (sleep-debt + chronotype) ──────────
 *
 * The two server-authoritative timing signals the Sleep page + the
 * dashboard summary render — the outstanding sleep-debt balance and the MCTQ
 * chronotype band + social jetlag. Built from the SAME assembler the
 * dashboard route uses (`reconstructNights` → `computeSleepRhythmFromNights`),
 * over the rhythm's OWN fixed trailing-42-day rows, so the coach quotes the
 * exact debt + band the page shows regardless of the coach's narration
 * window. ONE ENGINE: this never recomputes sleep-debt or chronotype inline —
 * the math lives in `sleep-debt.ts` / `chronotype.ts`, reached through the
 * assembler. The `needMinutes` is the SAME age-resolved need the derived
 * block + Sleep Score read (`sleepNeedMinutes(ageYears)`), and the
 * `sourcePriorityJson` is the one already loaded for the per-stage sleep
 * block — no extra read beyond the rhythm rows.
 *
 * LEARNING-GATE HONESTY: both signals carry a calm `partial` / `learning`
 * state below their night thresholds. The chronotype `band` is emitted ONLY
 * when the state is `ready` — a learning chronotype is surfaced as
 * "still calibrating", never asserted as a band the data can't support.
 */
export function buildSleepRhythmBlock(
  ctx: Readonly<SleepRhythmBlockContext>,
): void {
  const {
    sleepRhythmRows,
    sourcePriorityJson,
    userTz,
    ageYears,
    snapshot,
    metrics,
    registerBlock,
  } = ctx;
  const rhythm: SleepRhythmDto = computeSleepRhythmFromNights(
    reconstructNights(sleepRhythmRows, userTz, sourcePriorityJson),
    sleepNeedMinutes(ageYears),
  );
  const chronotypeReady = rhythm.chronotype.state === "ready";
  snapshot.sleepRhythm = {
    sleepDebt: {
      state: rhythm.sleepDebt.state,
      debtMinutes: rhythm.sleepDebt.debtMinutes,
      needMinutes: rhythm.sleepDebt.needMinutes,
    },
    chronotype: {
      state: rhythm.chronotype.state,
      // Only assert a band + social jetlag once the chronotype is `ready`.
      // A `learning` chronotype carries no band the data supports — the
      // model treats it as "still calibrating", never a typed assertion.
      band: chronotypeReady ? rhythm.chronotype.band : null,
      socialJetlagMinutes: chronotypeReady
        ? rhythm.chronotype.socialJetlagMinutes
        : null,
    },
  };
  metrics.add("sleep");
  registerBlock("sleepRhythm", "sleep");
}
