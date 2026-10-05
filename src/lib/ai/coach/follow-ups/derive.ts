/**
 * The follow-up chips under the latest assistant reply, derived on the
 * server from what the turn read: as a chart, as a table, the period before,
 * a year ago, a wider window, a related metric. At most three, deduplicated,
 * labels from the catalog only.
 *
 * A chip is offered only when what it asks for is grounded in this turn:
 *
 *   - `as_chart` / `as_table`: a table this turn produced (or copied) that
 *     has a chart; the chip names the view it is not shown in yet.
 *   - `previous_period`: a time series table of the current period, for a
 *     metric the table tool reads and the record holds.
 *   - `year_ago`: the same, over a window of at most 90 days, when the
 *     record's history for the metric reaches back a year.
 *   - `widen_window`: the same, when the record holds readings older than
 *     the table's window.
 *   - `related_metric`: `get_correlations` returned a pair this turn that
 *     links a metric the turn read to another metric the record holds.
 *
 * Absence never becomes a chip: every rule needs a done read, and the
 * history rules need the record's own first reading. `continue` is not
 * derived here (`continue.ts`).
 *
 * The model may propose chips in a `---FOLLOWUPS---` block. A proposal only
 * reorders: it is honoured when its domain was read this turn and the same
 * chip is among the ones the rules above allow, which it then leads.
 *
 * `deriveFollowUps` and `correlationPartners` are pure. `readFollowUpHistory`
 * is the one read the rules need, done once per turn before deriving.
 */
import type { Locale } from "@/lib/i18n/config";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { userDayKey, shiftDateKey } from "@/lib/tz/format";
import { annotate } from "@/lib/logging/context";
import type {
  CoachFollowUp,
  CoachResultMeta,
  CoachScopeSource,
  CoachScopeWindow,
  CoachStep,
  CoachStepDomain,
} from "@/lib/ai/coach/types";
import type { InventoryEntry } from "@/lib/ai/coach/tools/inventory";
import {
  probeCoachAvailability,
  subjectForTool,
  type CoachAvailabilitySubject,
} from "@/lib/ai/coach/tools/availability";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import type { SettledToolCall } from "@/lib/ai/coach/results/project";
import { presentSources } from "@/lib/ai/coach/clarify";
import type { CoachPrefs } from "@/lib/validations/coach-prefs";

import {
  MAX_FOLLOW_UPS,
  buildFollowUp,
  isTableMetricDomain,
  numberFollowUps,
  widerWindow,
} from "./catalog";
import type { FollowUpProposal } from "./parse-sentinel";
import {
  exceedsReach,
  fitsReach,
  reachFromPrefs,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";

/** A discovered pair `get_correlations` returned this turn, as scope sources. */
export interface CorrelationPair {
  a: CoachScopeSource;
  b: CoachScopeSource;
}

/**
 * The record's history for the metrics a turn's tables read: the first
 * reading per metric and today, both as day keys in the person's timezone.
 */
export interface FollowUpHistory {
  today: string;
  firstDate: Partial<Record<CoachScopeSource, string>>;
}

/** The windows a year-ago comparison is offered for. */
const SHORT_WINDOW_DAYS: Partial<Record<CoachScopeWindow, number>> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
};

const WINDOW_DAYS: Partial<Record<CoachScopeWindow, number>> = {
  ...SHORT_WINDOW_DAYS,
  lastYear: 365,
};

/**
 * True when answering `chip` stays inside the lookback limit: the period
 * before needs twice the window, a year ago a year more than it, a wider
 * window must itself fit.
 */
function chipWithinReach(chip: Candidate, reach: CoachHistoryReach): boolean {
  const window = chip.anchor?.window;
  if (!window) return true;
  if (exceedsReach(window, reach)) return false;
  const days = WINDOW_DAYS[window];
  switch (chip.kind) {
    case "previous_period":
      return days !== undefined && fitsReach(2 * days, reach);
    case "year_ago":
      return days !== undefined && fitsReach(days + 365, reach);
    case "widen_window": {
      const wider = widerWindow(window);
      return wider !== null && !exceedsReach(wider, reach);
    }
    default:
      return true;
  }
}

/** Whether the pref lets chips be offered. Absent means on. */
export function followUpChipsEnabled(prefs: CoachPrefs): boolean {
  return prefs.followUpChips !== false;
}

/** `YYYY-MM-DD` minus `days`, as a day key. */
function dayKeyMinus(dayKey: string, days: number): string {
  return shiftDateKey(dayKey, -days);
}

/** True when the record's first reading lies before `dayKey`. */
function historyBefore(
  history: FollowUpHistory | undefined,
  domain: CoachScopeSource,
  daysBack: number,
): boolean {
  const first = history?.firstDate[domain];
  if (!history || !first) return false;
  return first < dayKeyMinus(history.today, daysBack);
}

/** The readings a table counted, from the step that produced it. */
function readingsFor(
  meta: CoachResultMeta,
  steps: readonly CoachStep[],
): number {
  const step = steps.find((s) => s.resultRef === meta.ref);
  return step?.count ?? meta.rowCount;
}

type Candidate = CoachFollowUp;

export function deriveFollowUps(args: {
  results: CoachResultMeta[];
  steps: CoachStep[];
  /** What the record holds; null on the no-tools path and a reuse turn. */
  inventory: InventoryEntry[] | null;
  /** Kind and domain pairs the model proposed, already catalog-checked. */
  proposals: FollowUpProposal[];
  forcedFinal: boolean;
  prefs: CoachPrefs;
  locale: Locale;
  /** The record's history for the tables' metrics; absent → no history chips. */
  history?: FollowUpHistory;
  /** Pairs `get_correlations` returned this turn. */
  correlations?: readonly CorrelationPair[];
}): CoachFollowUp[] {
  const { results, steps, inventory, locale } = args;
  if (!followUpChipsEnabled(args.prefs)) return [];

  const done = new Set<CoachStepDomain>();
  for (const step of steps) {
    if (step.status === "done" && step.domain) done.add(step.domain);
  }
  // A table this turn holds is a done read of its domain, whether it was
  // fetched or copied from an earlier answer.
  const grounded = new Set<CoachStepDomain>(done);
  for (const meta of results) grounded.add(meta.source.domain);
  const present = inventory ? presentSources(inventory) : null;

  const candidates: Candidate[] = [];
  // Tables the answer showed come first: the chips follow what the person
  // is looking at.
  const ordered = [
    ...results.filter((meta) => meta.displayed),
    ...results.filter((meta) => !meta.displayed),
  ];

  for (const meta of ordered) {
    const { source } = meta;
    if (!grounded.has(source.domain)) continue;
    const anchor = {
      ref: meta.ref,
      domain: source.domain,
      window: source.window,
      ...(source.granularity ? { granularity: source.granularity } : {}),
      period: source.period,
    };
    if (meta.chartKind !== null) {
      // The other view of what the answer shows: a table shown as a table
      // offers its chart, a shown chart offers its table.
      const showsChart = meta.displayed && meta.view !== "table";
      candidates.push(
        buildFollowUp({
          kind: showsChart ? "as_table" : "as_chart",
          anchor,
          origin: "server",
          locale,
        }),
      );
    }
  }

  for (const meta of ordered) {
    const { source } = meta;
    const domain = source.domain;
    if (meta.shape !== "timeSeries" || source.period !== "current") continue;
    if (!grounded.has(domain) || !isTableMetricDomain(domain)) continue;
    if (!present?.has(domain)) continue;
    const anchor = {
      ref: meta.ref,
      domain,
      window: source.window,
      ...(source.granularity ? { granularity: source.granularity } : {}),
      period: source.period,
    };
    const windowDays = WINDOW_DAYS[source.window];
    // The period before exists only when the record reaches back past the
    // window's start; all time has no period before it at all (the table
    // tool reads it as the current period whatever it is asked).
    if (
      windowDays !== undefined &&
      historyBefore(args.history, domain, windowDays)
    ) {
      candidates.push(
        buildFollowUp({
          kind: "previous_period",
          anchor,
          origin: "server",
          locale,
        }),
      );
    }
    const shortDays = SHORT_WINDOW_DAYS[source.window];
    if (shortDays !== undefined && historyBefore(args.history, domain, 365)) {
      candidates.push(
        buildFollowUp({ kind: "year_ago", anchor, origin: "server", locale }),
      );
    }
    if (
      windowDays !== undefined &&
      readingsFor(meta, steps) > 0 &&
      historyBefore(args.history, domain, windowDays)
    ) {
      candidates.push(
        buildFollowUp({
          kind: "widen_window",
          anchor,
          origin: "server",
          locale,
        }),
      );
    }
  }

  for (const pair of args.correlations ?? []) {
    for (const [read, partner] of [
      [pair.a, pair.b],
      [pair.b, pair.a],
    ] as const) {
      if (!done.has(read) || grounded.has(partner)) continue;
      if (!isTableMetricDomain(partner) || !present?.has(partner)) continue;
      const readTable = ordered.find((meta) => meta.source.domain === read);
      candidates.push(
        buildFollowUp({
          kind: "related_metric",
          anchor: {
            ref: readTable?.ref ?? "",
            domain: partner,
            ...(readTable ? { window: readTable.source.window } : {}),
          },
          origin: "server",
          locale,
        }),
      );
    }
  }

  // Deduplicate by kind and domain, first wins. A chip that would read past
  // the lookback limit is not offered: it could only be answered with
  // "that lies beyond your limit".
  const reach = reachFromPrefs(args.prefs);
  const key = (chip: Candidate) => `${chip.kind}:${chip.anchor?.domain ?? ""}`;
  const unique = new Map<string, Candidate>();
  for (const chip of candidates) {
    if (!chipWithinReach(chip, reach)) continue;
    if (!unique.has(key(chip))) unique.set(key(chip), chip);
  }

  // A proposal leads when its domain was read this turn and the rules allow
  // the same chip; otherwise it is ignored.
  const led: Candidate[] = [];
  for (const proposal of args.proposals) {
    if (!done.has(proposal.domain)) continue;
    const match = unique.get(`${proposal.kind}:${proposal.domain}`);
    if (!match || led.includes(match)) continue;
    led.push({ ...match, origin: "model" });
  }
  const ledKeys = new Set(led.map(key));
  const rest = [...unique.values()].filter((chip) => !ledKeys.has(key(chip)));
  return numberFollowUps([...led, ...rest].slice(0, MAX_FOLLOW_UPS));
}

// ── Correlation pairs ─────────────────────────────────────────────────────

/** Measurement type → the scope source that reads it. */
const SOURCE_BY_TYPE: ReadonlyMap<string, CoachScopeSource> = new Map(
  (
    Object.entries(COACH_SOURCE_MEASUREMENT_TYPES) as Array<
      [CoachScopeSource, readonly string[]]
    >
  ).flatMap(([source, types]) => types.map((type) => [type, source] as const)),
);

/**
 * A discovery channel label ("sleep duration", "blood pressure sys") back to
 * the scope source that reads it, or null when it is not a measurement
 * channel. The labels are the channel keys lower-cased and spaced, so the
 * reverse is exact; anything else (an environment field, a custom metric,
 * adherence) names no metric a chip could fetch.
 */
function channelSource(label: unknown): CoachScopeSource | null {
  if (typeof label !== "string") return null;
  const key = label.trim().toUpperCase().replace(/\s+/g, "_");
  if (key === "MOOD") return "mood";
  return SOURCE_BY_TYPE.get(key) ?? null;
}

/** The metric pairs a present `get_correlations` result named this turn. */
export function correlationPartners(
  calls: readonly SettledToolCall[],
): CorrelationPair[] {
  const pairs: CorrelationPair[] = [];
  for (const call of calls) {
    if (call.name !== "get_correlations" || !call.result.present) continue;
    const data = call.result.data as { drivers?: unknown } | undefined;
    if (!Array.isArray(data?.drivers)) continue;
    for (const driver of data.drivers) {
      if (!driver || typeof driver !== "object") continue;
      const d = driver as { behaviour?: unknown; outcome?: unknown };
      const a = channelSource(d.behaviour);
      const b = channelSource(d.outcome);
      if (a && b && a !== b) pairs.push({ a, b });
    }
  }
  return pairs;
}

// ── History ───────────────────────────────────────────────────────────────

/**
 * The record's first reading for each metric a time series table of this
 * turn read, and today, in the person's timezone. One batched probe, only
 * when a table could carry a history chip; a failed probe offers no history
 * chip rather than guessing one.
 */
export async function readFollowUpHistory(args: {
  userId: string;
  results: readonly CoachResultMeta[];
  prefs: CoachPrefs;
  now?: Date;
}): Promise<FollowUpHistory | undefined> {
  if (!followUpChipsEnabled(args.prefs)) return undefined;
  const subjects = new Map<string, CoachAvailabilitySubject>();
  for (const meta of args.results) {
    const domain = meta.source.domain;
    if (meta.shape !== "timeSeries" || meta.source.period !== "current") {
      continue;
    }
    if (meta.source.window === "allTime" || !isTableMetricDomain(domain)) {
      continue;
    }
    const subject = subjectForTool("get_metric_table", domain);
    if (subject) subjects.set(domain, subject);
  }
  if (subjects.size === 0) return undefined;
  try {
    const now = args.now ?? new Date();
    const [probed, tz] = await Promise.all([
      probeCoachAvailability(args.userId, subjects, { now }),
      resolveUserTimezone(args.userId),
    ]);
    const firstDate: FollowUpHistory["firstDate"] = {};
    for (const [domain, available] of probed) {
      firstDate[domain as CoachScopeSource] = available.firstDate;
    }
    return { today: userDayKey(now, tz), firstDate };
  } catch (err) {
    annotate({
      action: { name: "coach.followUp.history_failed" },
      meta: { reason: err instanceof Error ? err.name : "unknown" },
    });
    return undefined;
  }
}
