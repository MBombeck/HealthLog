"use client";

/**
 * How the day's mood sat on days carrying each context value.
 *
 * The copy rule this component exists to hold, stated once so nobody has to
 * infer it from the strings: **no sentence here names a cause.** Not "family
 * lowers your mood", not "overtime costs you two points". What the data
 * supports is "on the days recorded so far with X, the average was lower", and
 * that is what it says — with the two counts on the same line as the claim,
 * not behind a tooltip, because a reader who cannot see that a row rests on
 * six days cannot weigh it.
 *
 * The rows arriving here have already cleared the day floors and a
 * family-wide Benjamini-Hochberg correction. Nothing in this file re-filters
 * them; a second threshold in the presentation layer would be a second place
 * to get the statistics wrong.
 */
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { contextValueLabelKey } from "@/lib/mood/context-vocabulary";
import type { ContextComparisonRow } from "@/lib/insights/mood-context-crosstab";

export function MoodContextComparison({
  rows,
}: {
  rows: ContextComparisonRow[];
}) {
  const { t } = useTranslations();
  const nf = useFormatters();
  if (rows.length === 0) return null;

  return (
    <div className="space-y-3" data-slot="mood-context-comparison">
      <p className="text-muted-foreground text-sm">
        {t("insights.mood.contextComparison.description")}
      </p>
      <ul className="space-y-3">
        {rows.map((row) => {
          const label = t(contextValueLabelKey(row.field, row.value));
          const direction =
            row.delta < 0
              ? t("insights.mood.contextComparison.lower")
              : t("insights.mood.contextComparison.higher");
          return (
            <li
              key={`${row.field}:${row.value}`}
              className="border-border/60 space-y-1 border-t pt-3 first:border-t-0 first:pt-0"
              data-slot="mood-context-comparison-row"
            >
              <p className="text-foreground text-sm">
                {t("insights.mood.contextComparison.statement", {
                  label,
                  direction,
                  withAvg: nf.number(row.withAvg, 1),
                  withoutAvg: nf.number(row.withoutAvg, 1),
                })}
              </p>
              {/* The counts ride with the statement, in the same block a
                  screen reader reaches in the same breath. */}
              <p className="text-muted-foreground text-xs tabular-nums">
                {t("insights.mood.contextComparison.counts", {
                  withDays: String(row.withDays),
                  withoutDays: String(row.withoutDays),
                })}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground text-xs">
        {t("insights.mood.contextComparison.caveat")}
      </p>
    </div>
  );
}
