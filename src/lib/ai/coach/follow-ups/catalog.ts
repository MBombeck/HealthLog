/**
 * The follow-up chip catalog: which kinds exist, which are answered from a
 * stored table without a model call, which the model may propose, and how a
 * chip's label is rendered. A label is always one catalog key plus, on a
 * related-metric chip, the name of a domain; never model text.
 *
 * Pure apart from the server translator.
 */
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import {
  coachScopeSourceSchema,
  type CoachFollowUp,
  type CoachFollowUpKind,
  type CoachScopeSource,
  type CoachScopeWindow,
  type CoachStepDomain,
} from "@/lib/ai/coach/types";
import {
  COACH_FOLLOW_UP_KEYS,
  coachDomainLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import { METRIC_TABLE_EXCLUDED_SOURCES } from "@/lib/ai/coach/results/metric-table-tool";

import { REUSE_FOLLOW_UP_KINDS } from "./view-chip";

/** At most this many chips under one reply. */
export const MAX_FOLLOW_UPS = 3;

/** Every kind, in catalog order. */
export const FOLLOW_UP_KINDS: readonly CoachFollowUpKind[] = [
  "as_chart",
  "as_table",
  "previous_period",
  "year_ago",
  "widen_window",
  "related_metric",
  "continue",
];

/**
 * Kinds the model may propose in a `---FOLLOWUPS---` block. `continue` is
 * the server's alone: it follows from the loop hitting its round cap, which
 * the model cannot see.
 */
export const PROPOSABLE_FOLLOW_UP_KINDS: ReadonlySet<CoachFollowUpKind> =
  new Set(FOLLOW_UP_KINDS.filter((kind) => kind !== "continue"));

export function isFollowUpKind(value: string): value is CoachFollowUpKind {
  return (FOLLOW_UP_KINDS as readonly string[]).includes(value);
}

const SCOPE_SOURCES: ReadonlySet<string> = new Set(
  coachScopeSourceSchema.options,
);

/**
 * The domains `get_metric_table` reads: every scope source except the ones
 * it leaves to their own tools. A chip that asks for another period, a
 * wider window or a related metric is answered with that tool, so it is
 * only offered for these.
 */
export function isTableMetricDomain(
  domain: CoachStepDomain,
): domain is CoachScopeSource {
  return (
    SCOPE_SOURCES.has(domain) &&
    !Object.hasOwn(METRIC_TABLE_EXCLUDED_SOURCES, domain)
  );
}

/** The next wider window preset, or null from `allTime`. */
export function widerWindow(window: CoachScopeWindow): CoachScopeWindow | null {
  switch (window) {
    case "last7days":
      return "last30days";
    case "last30days":
      return "last90days";
    case "last90days":
      return "lastYear";
    case "lastYear":
      return "allTime";
    case "allTime":
      return null;
  }
}

/** The server-rendered label of a chip, in the request locale. */
export function renderFollowUpLabel(
  kind: CoachFollowUpKind,
  domain: CoachStepDomain | undefined,
  locale: Locale,
): { labelKey: string; label: string } {
  const { t } = getServerTranslator(locale);
  const labelKey = COACH_FOLLOW_UP_KEYS[kind];
  const label =
    kind === "related_metric" && domain
      ? t(labelKey, { metric: t(coachDomainLabelKey(domain)) })
      : t(labelKey);
  return { labelKey, label };
}

/**
 * One chip, labelled. The id is provisional: the chips of a reply are
 * numbered `f1`..`f3` once the final list is known.
 */
export function buildFollowUp(args: {
  kind: CoachFollowUpKind;
  anchor?: CoachFollowUp["anchor"];
  origin: CoachFollowUp["origin"];
  locale: Locale;
}): CoachFollowUp {
  const { kind, anchor, origin, locale } = args;
  return {
    id: "f0",
    kind,
    ...renderFollowUpLabel(kind, anchor?.domain, locale),
    ...(anchor ? { anchor } : {}),
    reuse: REUSE_FOLLOW_UP_KINDS.has(kind),
    origin,
  };
}

/** Number a reply's chips `f1`..`f3`, in order. */
export function numberFollowUps(chips: CoachFollowUp[]): CoachFollowUp[] {
  return chips
    .slice(0, MAX_FOLLOW_UPS)
    .map((chip, index) => ({ ...chip, id: `f${index + 1}` }));
}
