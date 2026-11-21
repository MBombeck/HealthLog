/**
 * Cross-cutting narration blocks for the Coach snapshot: the adherence
 * storyline, changepoints and signal-trust. Best-effort + fault-isolated;
 * tiny descriptive objects attached WITHOUT a cluster registration (like
 * illness/labs/scope, the budget degrader never sheds them).
 */
import { annotate } from "@/lib/logging/context";
import {
  ADHERENCE_STORYLINE_HORIZON_DAYS,
  buildAdherenceStoryline,
} from "@/lib/insights/derived/adherence-storyline";
import {
  CHANGEPOINT_WINDOW_DAYS,
  buildChangepointSignals,
} from "@/lib/insights/derived/changepoint";
import {
  SIGNAL_TRUST_WINDOW_DAYS,
  buildSignalTrust,
} from "@/lib/insights/derived/signal-trust";
import { fitsReach, type CoachHistoryReach } from "../history-reach";
import type { CoachScope } from "../types";

/**
 * A cross-cutting narration block that throws must not vanish silently. Each of
 * these builders is additive — the snapshot is still valid without it — so the
 * catch stays, but the failure is now countable: `signalTrust` is the block that
 * tells the model HOW MUCH to trust the numbers it is about to narrate, and a
 * builder that fails to `null` is indistinguishable from a user who simply has
 * no trust caveats. Absence and failure are different things and the wide event
 * now says which one happened.
 */
function blockFailed(block: string): (err: unknown) => null {
  return (err: unknown) => {
    // Resolved before the annotate call, not inline: the free-text guard in
    // `snapshot.test.ts` reads three lines around a `name:` key and an inline
    // `err.name` there looks like an un-sanitised user string to it.
    const reason = err instanceof Error ? err.name : "unknown";
    annotate({
      action: { name: "coach.snapshot.block_failed" },
      meta: { block, reason },
    });
    return null;
  };
}

interface CrossCuttingBlocksContext {
  userId: string;
  userTz: string;
  now: Date;
  scope: CoachScope | undefined;
  reach: CoachHistoryReach;
  excludesMedications: boolean;
  snapshot: Record<string, unknown>;
}

export async function buildCrossCuttingBlocks(
  ctx: Readonly<CrossCuttingBlocksContext>,
): Promise<void> {
  const { userId, userTz, now, scope, reach, snapshot } = ctx;
  // These cross-cutting narrations belong on the BROAD Coach turn, not on a
  // narrowed single-source snapshot (the F1 tool builds + metric-page contexts
  // pass an explicit `scope.sources`). Skipping them there keeps a scoped read
  // bounded to its domain and avoids spurious recovery/vital reads.
  const isExplicitlyScoped =
    Array.isArray(scope?.sources) && scope.sources.length > 0;
  // Each of these reads its own fixed window; one that reaches past the
  // lookback limit is left out.
  const [adherenceStoryline, changepoints, signalTrust] = isExplicitlyScoped
    ? [null, null, null]
    : await Promise.all([
        ctx.excludesMedications ||
        !fitsReach(ADHERENCE_STORYLINE_HORIZON_DAYS, reach)
          ? Promise.resolve(null)
          : buildAdherenceStoryline(userId, userTz, now).catch(
              blockFailed("adherenceStoryline"),
            ),
        fitsReach(CHANGEPOINT_WINDOW_DAYS, reach)
          ? buildChangepointSignals(userId, now).catch(
              blockFailed("changepoints"),
            )
          : Promise.resolve(null),
        fitsReach(SIGNAL_TRUST_WINDOW_DAYS, reach)
          ? buildSignalTrust(userId, userTz, now).catch(
              blockFailed("signalTrust"),
            )
          : Promise.resolve(null),
      ]);
  if (adherenceStoryline) snapshot.adherenceStoryline = adherenceStoryline;
  if (changepoints && changepoints.length > 0) {
    snapshot.changepoints = changepoints;
  }
  if (signalTrust) snapshot.signalTrust = signalTrust;
}
