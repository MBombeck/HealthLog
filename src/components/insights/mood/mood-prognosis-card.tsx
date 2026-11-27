"use client";

/**
 * The day's two readings, side by side, with the person's own one leading.
 *
 * The copy rules this component exists to hold, stated once so nobody has to
 * infer them from the strings:
 *
 *   * **No sentence names a cause.** Not "overtime lowered your mood", not
 *     "poor sleep is why today was hard". What the data supports is "on your
 *     own past days, a value around X would have been expected", and that is
 *     what it says. The ban is a test, not a habit:
 *     `src/__tests__/copy-matches-behaviour-guard.test.ts` reads the six
 *     bundles and fails on a causal construction in any of them.
 *   * **The forecast is a counterfactual and the sentence says so.** Never
 *     "your mood is 5.4" — always "a value around 5.4 would have been
 *     expected". The difference is the whole distinction between the two
 *     readings.
 *   * **The count is on the same surface as the number**, not in a tooltip. A
 *     forecast built from thirty days and one built from three hundred look
 *     identical otherwise, and a reader who cannot see which one they are
 *     looking at cannot weigh it.
 *   * **The deviation is measured against the band, never against the
 *     midpoint.** Inside the band is "as expected"; outside it is the finding.
 *
 * The explanation is generated from the contributions the job stored for that
 * day, so it names what the model actually weighted rather than a fresh
 * calculation against a model that may since have been re-fitted.
 */
import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { formatDate } from "@/lib/date-format";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { PrognosisReading } from "@/lib/analytics/mood-prognosis/read";

import { prognosisFeatureLabel } from "./prognosis-feature-label";

/** How many weighted features the explanation names. */
const EXPLAINED_FEATURES = 3;

function formatValue(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * The card over its read. Nothing is drawn while the read is on its way:
 * below the first rung the card draws nothing at all, so a loading
 * placeholder was a frame that often collapsed again. A failed read says so
 * with a retry rather than passing for "nothing to say yet".
 */
export function MoodPrognosisCard() {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();

  const { data, error, isError, refetch } = useQuery({
    queryKey: queryKeys.moodPrognosis(),
    queryFn: async () => apiGet<PrognosisReading>("/api/mood/prognosis"),
    enabled: isAuthenticated,
    staleTime: 60_000,
  });

  if (isError && !data) {
    return (
      <QueryErrorRow
        error={error}
        slot="mood-prognosis-error"
        message={t("insights.mood.prognosis.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!data) return null;
  return <MoodPrognosisView reading={data} />;
}

/**
 * The card itself, over a resolved reading.
 *
 * Split from the query so the copy rules above can be asserted against real
 * renders rather than against the strings alone: "the two values are never
 * merged" is a property of what reaches the screen, and a bundle check cannot
 * see it.
 */
export function MoodPrognosisView({ reading }: { reading: PrognosisReading }) {
  const { t, locale } = useTranslations();
  const dateFormat = useDateFormatPreference();
  const data = reading;
  // The day key is a plain calendar date and is rendered as one, through the
  // account's own date-order preference and pinned to UTC — the same treatment
  // every other day key in the app gets, so this card cannot show a different
  // day from the list beside it.
  const day = data.present ? formatDate(data.date, dateFormat, locale) : "";

  // Below the first rung there is nothing to say and the surface says nothing
  // rather than showing an empty frame with an apology in it.
  if (!data.present && data.reason === "no-output-yet") return null;

  return (
    <Card data-slot="mood-prognosis" density="compact">
      <CardHeader>
        <TileHeader icon={Compass} title={t("insights.mood.prognosis.title")} />
      </CardHeader>
      <CardContent className="space-y-3">
        {!data.present ? (
          <p
            className="text-muted-foreground text-sm"
            data-slot="mood-prognosis-absent"
          >
            {data.reason === "learning-phase"
              ? t("insights.mood.prognosis.learning", {
                  entries: String(data.entries),
                  threshold: String(data.nextThreshold ?? 0),
                })
              : t("insights.mood.prognosis.noPattern", {
                  entries: String(data.entries),
                })}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              {/* The self-assessment leads: it is the larger number, it comes
                  first, and it is the only one of the two the person gave. */}
              <div data-slot="mood-prognosis-self">
                <p className="text-muted-foreground text-xs">
                  {t("insights.mood.prognosis.selfLabel")}
                </p>
                <p className="text-foreground text-3xl font-semibold tabular-nums">
                  {data.selfAssessment === null
                    ? t("mood.dayContext.notRecorded")
                    : formatValue(data.selfAssessment, locale)}
                </p>
              </div>
              <div data-slot="mood-prognosis-expected">
                <p className="text-muted-foreground text-xs">
                  {t("insights.mood.prognosis.expectedLabel")}
                </p>
                <p className="text-foreground text-xl font-medium tabular-nums">
                  {formatValue(data.predicted, locale)}
                </p>
                {/* The band and the count ride with the value, in the block a
                    screen reader reaches in the same breath. */}
                <p className="text-muted-foreground text-xs tabular-nums">
                  {data.ciLow !== null && data.ciHigh !== null
                    ? t("insights.mood.prognosis.band", {
                        low: formatValue(data.ciLow, locale),
                        high: formatValue(data.ciHigh, locale),
                      })
                    : null}
                </p>
              </div>
            </div>

            <p
              className="text-foreground text-sm"
              data-slot="mood-prognosis-statement"
            >
              {t("insights.mood.prognosis.statement", {
                value: formatValue(data.predicted, locale),
                date: day,
                n: String(data.n),
              })}
            </p>

            {data.provisional ? (
              <p
                className="text-muted-foreground text-xs"
                data-slot="mood-prognosis-provisional"
              >
                {t("insights.mood.prognosis.provisional")}
              </p>
            ) : null}

            {!data.current ? (
              <p
                className="text-muted-foreground text-xs"
                data-slot="mood-prognosis-age"
              >
                {t("insights.mood.prognosis.notToday", { date: day })}
              </p>
            ) : null}

            {data.deviation !== null && data.selfAssessment !== null ? (
              <p
                className="text-foreground text-sm"
                data-slot="mood-prognosis-deviation"
              >
                {data.deviation === "within"
                  ? t("insights.mood.prognosis.deviationWithin")
                  : data.deviation === "above"
                    ? t("insights.mood.prognosis.deviationAbove", {
                        amount: formatValue(data.deviationAmount ?? 0, locale),
                      })
                    : t("insights.mood.prognosis.deviationBelow", {
                        amount: formatValue(data.deviationAmount ?? 0, locale),
                      })}
              </p>
            ) : null}

            <PrognosisExplanation contributions={data.contributions} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PrognosisExplanation({
  contributions,
}: {
  contributions: Array<{ feature: string; contribution: number }>;
}) {
  const { t } = useTranslations();
  const named = contributions
    .map((item) => ({
      ...item,
      label: prognosisFeatureLabel(item.feature, t),
    }))
    .filter(
      (item): item is typeof item & { label: string } =>
        item.label !== null && item.contribution !== 0,
    )
    .slice(0, EXPLAINED_FEATURES);

  if (named.length === 0) return null;

  return (
    <div className="space-y-1" data-slot="mood-prognosis-explanation">
      <p className="text-muted-foreground text-xs">
        {t("insights.mood.prognosis.weightedTitle")}
      </p>
      <ul className="space-y-0.5">
        {named.map((item) => (
          <li
            key={item.feature}
            className="text-foreground text-sm"
            data-slot="mood-prognosis-weighted-item"
          >
            {item.contribution > 0
              ? t("insights.mood.prognosis.weightedUp", { label: item.label })
              : t("insights.mood.prognosis.weightedDown", {
                  label: item.label,
                })}
          </li>
        ))}
      </ul>
    </div>
  );
}
