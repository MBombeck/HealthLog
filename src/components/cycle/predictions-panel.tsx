"use client";

import { Check, Sparkles } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import type { Formatters } from "@/lib/format-locale";
import { FERTILE_HUE, FLOW_HUE, OVULATION_HUE } from "./phase-tokens";
import type { CyclePrediction, CycleHistoryResponse } from "./types";

/**
 * v1.15.0 — the predictions panel.
 *
 * Shows the next-period RANGE (a window, with a confidence pill), the fertile
 * window (already goal-gated server-side — the API nulls it unless TTC, so we
 * just render what is present), the "still learning" state for < 3 cycles or
 * raw-chart mode, and the cycle-history stats. Never a single dated next-period
 * claim — always the range. The non-medical disclaimer is set once at the
 * cycle-tracking on-ramp, not repeated beneath every prediction surface.
 */

/**
 * Issue #66 — was a bespoke `toLocaleDateString(undefined, …)` (browser
 * locale, never the app's) with no year. Predictions run 1-2 cycles out, so
 * a window straddling New Year's would otherwise print an unadorned "Jan 3"
 * in December. Routes through the app-locale conditional-year formatter
 * instead; it renders day+month in the locale's field order and only adds
 * the year when it differs from the current one. The calendar variant reads
 * the key in UTC, so the date never rolls a day in UTC+12..+14.
 */
function formatDate(d: string, fmt: Formatters): string {
  return fmt.dateShortSmartCalendar(d);
}

function confidenceTone(c: number): {
  labelKey: string;
  variant: "default" | "secondary" | "outline";
} {
  if (c >= 0.66)
    return { labelKey: "cycle.predictions.confidenceHigh", variant: "default" };
  if (c >= 0.33)
    return {
      labelKey: "cycle.predictions.confidenceMedium",
      variant: "secondary",
    };
  return { labelKey: "cycle.predictions.confidenceLow", variant: "outline" };
}

export interface PredictionsPanelProps {
  prediction: CyclePrediction | null;
  rawChartMode: boolean;
  history: CycleHistoryResponse | undefined;
}

export function PredictionsPanel({
  prediction,
  rawChartMode,
  history,
}: PredictionsPanelProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <TileHeader icon={Sparkles} title={t("cycle.predictions.title")} />
        </CardHeader>
        <CardContent className="space-y-4">
          {rawChartMode ? (
            <Learning
              title={t("cycle.predictions.rawMode")}
              body={t("cycle.predictions.rawModeBody")}
            />
          ) : prediction == null ? (
            <p className="text-muted-foreground text-sm">
              {t("cycle.predictions.none")}
            </p>
          ) : prediction.stillLearning ? (
            <>
              <Learning
                title={t("cycle.predictions.stillLearning")}
                body={t("cycle.predictions.stillLearningBody")}
              />
              <NextPeriod prediction={prediction} />
            </>
          ) : (
            <>
              <NextPeriod prediction={prediction} />
              {prediction.fertileWindowStart && prediction.fertileWindowEnd ? (
                <Row
                  hue={FERTILE_HUE}
                  label={t("cycle.predictions.fertileWindow")}
                  value={`${formatDate(prediction.fertileWindowStart, fmt)}–${formatDate(
                    prediction.fertileWindowEnd,
                    fmt,
                  )}`}
                />
              ) : null}
              {prediction.predictedOvulation ? (
                <Row
                  hue={OVULATION_HUE}
                  label={
                    prediction.ovulationConfirmed
                      ? t("cycle.predictions.ovulationConfirmed")
                      : t("cycle.predictions.ovulation")
                  }
                  value={formatDate(prediction.predictedOvulation, fmt)}
                />
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <HistoryCard history={history} />
    </div>
  );
}

function NextPeriod({ prediction }: { prediction: CyclePrediction }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const tone = confidenceTone(prediction.confidence);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Row
          hue={FLOW_HUE}
          label={t("cycle.predictions.nextPeriod")}
          value={t("cycle.predictions.nextPeriodWindow", {
            low: formatDate(prediction.nextPeriodStartLow, fmt),
            high: formatDate(prediction.nextPeriodStartHigh, fmt),
          })}
        />
        <Badge variant={tone.variant} className="shrink-0">
          {t(tone.labelKey)}
        </Badge>
      </div>
    </div>
  );
}

function Row({
  hue,
  label,
  value,
}: {
  hue: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: hue }}
      />
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-foreground ml-auto text-sm font-medium tabular-nums">
        {value}
      </span>
    </div>
  );
}

function Learning({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-muted/40 rounded-md p-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 text-sm">{body}</p>
    </div>
  );
}

/** Inclusive day span between two `YYYY-MM-DD` dates (noon-UTC anchored). */
function daySpan(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

function HistoryCard({
  history,
}: {
  history: CycleHistoryResponse | undefined;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const stats = history?.stats;
  // Most-recent observed cycles (the spread the regularity number summarises —
  // seeing it builds trust; the data was already on the wire). QA H2.
  const observed = (history?.cycles ?? [])
    .filter((c) => !c.isPredicted)
    .slice(0, 6);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("cycle.history.title")}</CardTitle>
        {stats ? (
          <CardDescription>
            {t(`cycle.history.regularity${stats.regularity}`)}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {!stats || stats.avgLengthDays == null ? (
          <p className="text-muted-foreground text-sm">
            {t("cycle.history.none")}
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat
              label={t("cycle.history.avgLength")}
              value={t("cycle.history.days", { count: stats.avgLengthDays })}
            />
            {stats.lengthVariabilityDays != null ? (
              <Stat
                label={t("cycle.history.variability")}
                value={t("cycle.history.daysPlusMinus", {
                  count: stats.lengthVariabilityDays,
                })}
              />
            ) : null}
            {stats.avgPeriodLengthDays != null ? (
              <Stat
                label={t("cycle.history.avgPeriodLength")}
                value={t("cycle.history.days", {
                  count: stats.avgPeriodLengthDays,
                })}
              />
            ) : null}
          </dl>
        )}

        {observed.length > 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-xs font-medium">
              {t("cycle.history.recentCycles")}
            </p>
            <ul
              className="divide-border divide-y"
              data-slot="cycle-history-list"
            >
              {observed.map((c) => {
                const periodLen =
                  c.periodEndDate != null
                    ? daySpan(c.startDate, c.periodEndDate)
                    : null;
                return (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <span className="text-foreground tabular-nums">
                      {formatDate(c.startDate, fmt)}
                      {"–"}
                      {c.endDate
                        ? formatDate(c.endDate, fmt)
                        : t("cycle.history.ongoing")}
                    </span>
                    <span className="text-muted-foreground flex items-center gap-2 tabular-nums">
                      {c.lengthDays != null
                        ? t("cycle.history.days", { count: c.lengthDays })
                        : "—"}
                      {periodLen != null ? (
                        <span className="text-xs">
                          {t("cycle.history.periodDays", { count: periodLen })}
                        </span>
                      ) : null}
                      {c.ovulationConfirmed ? (
                        <Badge variant="secondary" className="gap-1 text-xs">
                          <Check className="h-3 w-3" aria-hidden="true" />
                          {t("cycle.history.ovulationChip")}
                        </Badge>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  );
}
