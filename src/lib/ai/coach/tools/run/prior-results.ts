/**
 * Which earlier result tables a turn may name and show again, under the
 * same gates and lookback limit a fresh read passes.
 */
import { resolveModuleMap } from "@/lib/modules/gate";
import { admitCoachSources, coachExclusions } from "@/lib/ai/coach/scope-gate";
import type { CoachPrefs } from "@/lib/validations/coach-prefs";
import type {
  CoachResultPeriod,
  CoachScope,
  CoachScopeSource,
  CoachScopeWindow,
  CoachStepDomain,
} from "@/lib/ai/coach/types";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import { resolveTableRange } from "@/lib/ai/coach/results/metric-table-tool";
import type { PriorResultTurn } from "@/lib/ai/coach/results/refs";
import {
  exceedsReach,
  isBounded,
  withinReach,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";

/**
 * True when the snapshot builder admitted `metric` for this account: the
 * resolved scope it pins on every snapshot is the source set left after the
 * module switches and the person's own exclusions. The table tool reads
 * rows the builder does not, so it asks the builder's gate first rather
 * than keeping a second copy of it.
 */
export function scopeAdmits(
  sections: Record<string, unknown>,
  metric: CoachScopeSource,
): boolean {
  const scope = sections.scope as { sources?: unknown } | undefined;
  return Array.isArray(scope?.sources) && scope.sources.includes(metric);
}

/**
 * The earlier tables a turn may name and show again: those whose metric the
 * same gate would read now. With a conversation scope that is the scope's
 * sources less the person's exclusions and switched-off modules; without
 * one, every metric not excluded. The exclusion is the snapshot's own
 * (`coachExclusions`, `admitCoachSources`), so a metric the person excluded
 * after a table was stored is neither listed for the model nor sent to it.
 * Tables of other domains (labs) answer to their module when read.
 *
 * The lookback limit applies the same way: a table whose range reaches past
 * it (stored before the limit was set or narrowed) is not listed, because
 * its line hands the model the window and the row count of history the
 * Coach may no longer read. `show_result` refuses it on the same test.
 */
export async function admittedPriorResults(args: {
  userId: string;
  prefs: Pick<CoachPrefs, "excludeMetrics">;
  scope: CoachScope | undefined;
  reach: CoachHistoryReach;
  prior: readonly PriorResultTurn[];
}): Promise<PriorResultTurn[]> {
  if (args.prior.length === 0) return [];
  const excluded = coachExclusions(
    args.prefs,
    await resolveModuleMap(args.userId),
  );
  const scoped =
    args.scope?.sources && args.scope.sources.length > 0
      ? admitCoachSources(args.scope.sources, excluded)
      : null;
  const admits = (domain: CoachStepDomain) =>
    !isCoachScopeSource(domain) ||
    (scoped
      ? scoped.has(domain)
      : admitCoachSources([domain], excluded).size > 0);
  return args.prior
    .map((turn) => ({
      ...turn,
      results: turn.results.filter(
        (meta) =>
          admits(meta.source.domain) &&
          tableRangeWithinReach(
            meta.source.window,
            meta.source.period ?? "current",
            args.reach,
          ),
      ),
    }))
    .filter((turn) => turn.results.length > 0);
}

/** True for a step domain the snapshot scope gates (a metric, not labs). */
export function isCoachScopeSource(
  domain: CoachStepDomain,
): domain is CoachScopeSource {
  return Object.hasOwn(COACH_SOURCE_MEASUREMENT_TYPES, domain);
}

/**
 * True when a table's whole range lies inside the lookback limit. An earlier
 * period needs twice its window (previous) or a year more (a year ago), so a
 * range either fits with room to spare or does not fit at all; the UTC day
 * edges are close enough.
 */
export function tableRangeWithinReach(
  window: CoachScopeWindow,
  period: CoachResultPeriod,
  reach: CoachHistoryReach,
  now: Date = new Date(),
): boolean {
  if (!isBounded(reach)) return true;
  if (exceedsReach(window, reach)) return false;
  const range = resolveTableRange({ window, period, timeZone: "UTC", now });
  return withinReach(range.from, reach, now);
}
