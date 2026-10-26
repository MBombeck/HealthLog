import { annotate } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { resolveModuleMap } from "@/lib/modules/gate";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import { readMessageResults } from "@/lib/ai/coach/persistence";
import type { CoachResultTable, CoachScope } from "@/lib/ai/coach/types";
import { summariseTable } from "@/lib/ai/coach/results/metric-table-tool";
import {
  formatPriorResultRef,
  resolvePriorResultRef,
} from "@/lib/ai/coach/results/refs";
import { isCoachDomainWithheld } from "@/lib/ai/coach/results/domain-module";
import {
  COACH_RESULT_COLUMN_KEYS,
  COACH_RESULT_TITLE_KEYS,
  COACH_RESULT_UI_KEYS,
  coachDomainLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import {
  buildDistributionTable,
  deriveChartSpec,
} from "@/lib/ai/coach/results/chart-spec";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveIntlLocale } from "@/lib/format-locale";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { showResultArgsSchema, SHOW_RESULT_TOOL_NAME } from "../definitions";
import { OUTSIDE_REACH_REASON } from "../availability";
import {
  isCoachScopeSource,
  scopeAdmits,
  tableRangeWithinReach,
} from "./prior-results";
import { badArgs, limitWindow } from "./shared";
import type { CoachToolResult, CoachToolTurnContext } from "./types";

/**
 * A table shown again, with the chart its `view` asks for. No view: the chart
 * the server picks for any table. `table`: no chart. `chart`: a day table
 * becomes how often each range came up (a histogram); any other table, or a
 * day table with too few values, keeps the chart the server picks. The model
 * then reads the summary of what is shown.
 */
function withResultView(
  shown: CoachResultTable,
  view: "table" | "chart" | undefined,
  locale: Locale,
): CoachResultTable {
  // The view is this showing's alone, never the stored copy's.
  const { view: _stored, ...table } = shown;
  if (view === "table") {
    // The table shows first; the chart stays for the toggle and the chip
    // back to it.
    const chart = deriveChartSpec(table);
    return chart
      ? { ...table, chart, chartKind: chart.kind, view: "table" }
      : { ...table, chart: null, chartKind: null };
  }
  if (view === "chart") {
    const { t } = getServerTranslator(locale);
    const distribution = buildDistributionTable(table, {
      localeTag: resolveIntlLocale(locale),
      title: t(COACH_RESULT_TITLE_KEYS.distribution, {
        metric: t(coachDomainLabelKey(table.source.domain)),
      }),
      range: t(COACH_RESULT_COLUMN_KEYS.range),
      count: t(COACH_RESULT_COLUMN_KEYS.count),
      bin: (from, to, unit) =>
        t(COACH_RESULT_UI_KEYS.histogramBin, { from, to, unit }),
    });
    if (distribution) return distribution;
  }
  const chart = deriveChartSpec(table);
  return { ...table, chart, chartKind: chart?.kind ?? null };
}

/**
 * `show_result` — an earlier table of THIS conversation, shown again. The
 * name resolves only against the tables the turn's own conversation holds
 * (`turn.priorResults`), and the values come through the owner- and
 * conversation-narrowed read, so a name from anywhere else is an unknown
 * result, never a lookup.
 */
export async function showResult(
  userId: string,
  rawArgs: unknown,
  sharedScope: CoachScope | undefined,
  turn: CoachToolTurnContext | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = showResultArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs(SHOW_RESULT_TOOL_NAME, parsed.error);
  const target = turn
    ? resolvePriorResultRef(parsed.data.ref, turn.priorResults)
    : null;
  if (!turn || !target) {
    annotate({
      action: { name: "coach.result.unknown_ref" },
      meta: { inTurn: turn !== undefined },
    });
    return { present: false, reason: "unknown_result" };
  }

  // A stored table whose range reaches past the lookback limit set since is
  // not shown again: the limit covers what the Coach shows as much as what
  // it reads.
  const { window: storedWindow, period: storedPeriod } = target.meta.source;
  if (
    storedWindow !== undefined &&
    !tableRangeWithinReach(
      storedWindow,
      storedPeriod ?? "current",
      reach,
      turn.now,
    )
  ) {
    return { present: false, reason: OUTSIDE_REACH_REASON };
  }

  // The same gate a fresh read passes, before anything is decrypted: a
  // metric the person has since excluded from the Coach, or left out of
  // this conversation's scope, is not sent to the model again either.
  const domain = target.meta.source.domain;
  if (isCoachScopeSource(domain)) {
    const gate = await buildCoachSnapshot(
      userId,
      sharedScope ?? {
        sources: [domain],
        window: limitWindow(target.meta.source.window, reach),
      },
      { reach },
    );
    if (!scopeAdmits(gate.sections, domain)) {
      return { present: false, reason: "unavailable_in_scope" };
    }
  }

  const modules = await resolveModuleMap(userId);
  const entries = await readMessageResults(
    userId,
    turn.conversationId,
    target.messageId,
    (domain) => isCoachDomainWithheld(domain, modules),
  );
  const entry = entries?.find((candidate) => candidate.ref === target.ref);
  if (!entry) return { present: false, reason: "unknown_result" };
  if ("withheld" in entry) {
    return {
      present: false,
      reason:
        entry.withheld === "module_disabled"
          ? "module_disabled"
          : "result_unavailable",
    };
  }
  const ref = turn.refs.next();
  if (!ref) return { present: false, reason: "result_limit" };
  const table = withResultView(
    {
      ...entry,
      ref,
      displayed: false,
      reusedFrom: { messageId: target.messageId, ref: target.ref },
    },
    parsed.data.view,
    turn.locale,
  );
  return {
    present: true,
    resultRef: ref,
    data: {
      shownAgain: formatPriorResultRef(
        turn.priorResults.find((p) => p.messageId === target.messageId)
          ?.turnIndex ?? 0,
        target.ref,
      ),
      ...summariseTable(table),
    },
    table,
  };
}
