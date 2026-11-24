"use client";

/**
 * The one line that says what the artefact will contain.
 *
 * This is the consent check: reading it IS the review. Fenced inclusions are
 * restated by name rather than folded into the count, because a number cannot
 * be checked at a glance and "incl. Mood, PHQ-9" can.
 *
 * On an empty scope it is also the reason the generate / create control is
 * disabled, which is why it takes an `id`: the control points its
 * `aria-describedby` here, so "why can I not press this" has an answer in the
 * accessibility tree as well as on screen.
 *
 * Meta tier — one sentence about the form beside it, not content.
 *
 * One per picker, so the test id ends with the same surface its picker does.
 */
import { scopeSummary } from "@/lib/report-selection/panel-state";
import type { ReportLeafId } from "@/lib/report-selection/catalogue";

import type { ReportScopeSurface } from "./surface";

export function ScopeSummary({
  t,
  id,
  surface,
  selected,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Referenced by the control this line explains, via `aria-describedby`. */
  id?: string;
  surface: ReportScopeSurface;
  selected: ReadonlySet<ReportLeafId>;
}) {
  const summary = scopeSummary(selected);
  if (summary.total === 0) {
    return (
      <p
        id={id}
        className="text-muted-foreground text-xs"
        data-testid={`report-scope-summary-${surface}`}
      >
        {t("reportSelection.scopeNone")}
      </p>
    );
  }
  const base = t("reportSelection.scopeCount", {
    count: summary.total,
    groups: summary.groups,
  });
  const sensitive =
    summary.sensitiveLabelKeys.length > 0
      ? t("reportSelection.scopeSensitive", {
          names: summary.sensitiveLabelKeys.map((key) => t(key)).join(", "),
        })
      : null;
  return (
    <p
      id={id}
      className="text-muted-foreground text-xs"
      data-testid={`report-scope-summary-${surface}`}
    >
      {sensitive ? `${base}, ${sensitive}` : base}
    </p>
  );
}
