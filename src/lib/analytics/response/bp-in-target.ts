/**
 * The blood-pressure in-target block of the default analytics body: the
 * reporting-window percentages against the user's effective targets, and
 * the envelopes the Health Score grades against the clinical band.
 */
import type { SessionUser } from "@/lib/auth/session-user";
import { resolveEffectiveBpTargets } from "@/lib/analytics/effective-range";
import { bpTargetsEqual, getBpTargets } from "@/lib/analytics/bp-targets";
import {
  computeBpInTargetFastPath,
  type BpInTargetEnvelope,
} from "@/lib/analytics/bp-in-target-fast-path";
import { deriveBpWindow90 } from "@/lib/analytics/window-confidence";
import type { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";

type Coverage = Awaited<ReturnType<typeof probeRollupCoverage>>;

export async function readBpInTargetBlock(
  user: SessionUser,
  coverage: Coverage,
  userTz: string,
) {
  // BP in-target percentage (auto-calculated from date of birth)
  let bpInTargetPct: number | null = null;
  let bpInTargetPct7d: number | null = null;
  let bpInTargetPct30d: number | null = null;
  let bpInTargetPctAllTime: number | null = null;
  /**
   * Period-aligned prior-window
   * pcts so the BD-Zielbereich tile's comparison-overlay caption
   * stops mismatching its math with its label. The tile's
   * `compareDelta` is `last30Days - priorMonth` (or `… - priorYear`)
   * matching the user's `comparisonBaseline` selection, never
   * `last30Days - allTime` (the v1.4.22 A2 shortcut).
   */
  let bpInTargetPctPriorMonth: number | null = null;
  let bpInTargetPctPriorYear: number | null = null;
  // 90-day pair count + effective label span for the tile's
  // thin-data gate. Surfaced so the BD-Zielbereich tile renders "collecting
  // data" until the window holds enough readings, with a dynamic span label.
  let bpInTargetCount90: number | null = null;
  let bpInTargetSpanDays90: number | null = null;
  // Hold the current + prior-week BP envelopes so the shared
  // Health-Score input builder grades the pillar off the identical shape the
  // dashboard snapshot uses (one builder, no per-surface assembly drift).
  // The graded score + prior-week BP figures the score consumes are read off
  // these envelopes inside `buildHealthScoreBpInputs`.
  let bpEnvelope: BpInTargetEnvelope | null = null;
  let bpEnvelopePriorWeek: BpInTargetEnvelope | null = null;
  let bpEnvelopePriorTwoWeeks: BpInTargetEnvelope | null = null;
  const bpTargets = resolveEffectiveBpTargets(
    {
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      heightCm: user.heightCm ?? null,
    },
    user.thresholdsJson,
  );
  const clinicalBpTargets = getBpTargets(user.dateOfBirth);
  if (bpTargets) {
    const now = new Date();
    // Probe-gated dispatcher replaces the inline chunked
    // read. When BOTH BP types have DAY-bucket coverage the helper
    // pairs the per-day MEAN SYS + MEAN DIA from `measurement_rollups`
    // and counts in-target days against the five reporting windows,
    // skipping the heavy 365-day chunked walk against `measurements`.
    // Falls back to the legacy `computeBpInTargetWindows` over a
    // chunked read when coverage is partial so a brand-new account
    // (no buckets yet) still sees per-event numbers. The helper emits
    // a `path: "rollup" | "live"` annotate so prod logs prove which
    // branch fired. See `bp-in-target-fast-path.ts` for the
    // documented per-day-mean approximation.
    //
    // Two parallel runs: one anchored at `now` for the
    // standard windows, one anchored at `now - 7d` so the Health-Score
    // helper has a real prior-week BP pct to feed into its previous-
    // window snapshot. The two probes share the coverage map and the
    // same rollup / live branch decision; the extra call is one extra
    // pair of `readRollupBuckets` reads on the rollup path and is a
    // no-op when the user has no BP rows at all.
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const [windows, windowsPriorWeek, windowsPriorTwoWeeks] = await Promise.all(
      [
        computeBpInTargetFastPath({
          userId: user.id,
          targets: bpTargets,
          now,
          coverage,
          // Cross-tz runtime guard. The helper falls back
          // to the live SQL path when the user is more than 3 hours
          // from UTC, where the rollup table's UTC-midnight day-key
          // would slip a calendar day relative to the live aggregator's
          // window cuts.
          userTz,
        }),
        computeBpInTargetFastPath({
          userId: user.id,
          targets: bpTargets,
          now: sevenDaysAgo,
          coverage,
          userTz,
        }),
        computeBpInTargetFastPath({
          userId: user.id,
          targets: bpTargets,
          now: fourteenDaysAgo,
          coverage,
          userTz,
        }),
      ],
    );
    // The pillar is graded against the CLINICAL band even when the user
    // keeps a personal target (that band is the number's identity; the
    // personal one is displayed beside it and scores nothing). So when the
    // two differ we re-run the whole helper against the clinical targets
    // and the score comes from that second run.
    //
    // The "why this number" basis rides the same envelope, so it
    // is the same run, the same representative pair and the same ceilings
    // by construction. Assign envelopes WHOLE here; picking `graded.score`
    // off one run and a basis off the other would let the popover explain
    // a number nobody is looking at, and it would look correct in review.
    if (bpTargetsEqual(bpTargets, clinicalBpTargets)) {
      bpEnvelope = windows;
      bpEnvelopePriorWeek = windowsPriorWeek;
      bpEnvelopePriorTwoWeeks = windowsPriorTwoWeeks;
    } else if (clinicalBpTargets) {
      [bpEnvelope, bpEnvelopePriorWeek, bpEnvelopePriorTwoWeeks] =
        await Promise.all([
          computeBpInTargetFastPath({
            userId: user.id,
            targets: clinicalBpTargets,
            now,
            coverage,
            userTz,
          }),
          computeBpInTargetFastPath({
            userId: user.id,
            targets: clinicalBpTargets,
            now: sevenDaysAgo,
            coverage,
            userTz,
          }),
          computeBpInTargetFastPath({
            userId: user.id,
            targets: clinicalBpTargets,
            now: fourteenDaysAgo,
            coverage,
            userTz,
          }),
        ]);
    }
    // The BD-Zielbereich headline standardises on the
    // trailing-90-day window (labelled "· 90 T" in the tile). All-time
    // remains carried below for the BP detail page's long view only.
    bpInTargetPct = windows.last90Days?.pct ?? null;
    bpInTargetPct7d = windows.last7Days?.pct ?? null;
    bpInTargetPct30d = windows.last30Days?.pct ?? null;
    bpInTargetPctAllTime = windows.allTime?.pct ?? null;
    bpInTargetPctPriorMonth = windows.priorMonth?.pct ?? null;
    bpInTargetPctPriorYear = windows.priorYear?.pct ?? null;
    // Count + effective span for the BD-Zielbereich tile's
    // confidence gate (thin-data → "collecting data"; dynamic span label).
    // Shared helper keeps this identical to the dashboard snapshot.
    const bpWindow = deriveBpWindow90(
      windows.last90Days,
      windows.last90EarliestAt,
      now,
    );
    bpInTargetCount90 = bpWindow.count;
    bpInTargetSpanDays90 = bpWindow.spanDays;
  }
  return {
    bpInTargetPct,
    bpInTargetPct7d,
    bpInTargetPct30d,
    bpInTargetPctAllTime,
    bpInTargetPctPriorMonth,
    bpInTargetPctPriorYear,
    bpInTargetCount90,
    bpInTargetSpanDays90,
    bpEnvelope,
    bpEnvelopePriorWeek,
    bpEnvelopePriorTwoWeeks,
    clinicalBpTargets,
  };
}
