"use client";

import dynamic from "next/dynamic";
import { Activity } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { CorrelationResult } from "@/lib/analytics/correlations";
import { MoodExplainerIcon } from "./mood-explainer-icon";

/**
 * v1.8.5 — mood × metric correlation cards (Apple "Life Factors" parity).
 *
 * Reuses the shared `<ScatterCorrelationChart>` (same wrapper the
 * mother-page correlation cards ride) for each mood × (sleep / steps /
 * pulse) pair. The Pearson math comes pre-computed from
 * `/api/mood/insights` (single source of truth with the LLM snapshot).
 * Below-threshold pairs render an EmptyState rather than a misleading
 * near-zero scatter — and the EmptyState names which threshold, because a
 * pairing that is still building and one that found nothing are different
 * answers and used to read as the same blank.
 */

const ScatterCorrelationChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.ScatterCorrelationChart,
    })),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="bg-muted/40 aspect-square min-h-[180px] w-full sm:aspect-[3/2] sm:h-auto" />
    ),
  },
);

export interface MoodCorrelationPoint {
  x: number;
  y: number;
  [key: string]: number;
}

export interface MoodMetricCorrelationData {
  result: CorrelationResult | null;
  points: MoodCorrelationPoint[];
  n: number;
  /** Which bar the pairing fell short of, when there is no coefficient. */
  suppressed?: "insufficientPairs" | "notSignificant";
}

/**
 * The paired-day floor the server's significance gate enforces. Repeated
 * here only to tell the reader how far off they are; the decision itself is
 * the server's and arrives as `suppressed`.
 */
const MIN_PAIRED_DAYS = 20;

type MetricKind = "sleep" | "steps" | "pulse" | "weight" | "bloodPressure";

const TITLE_KEY: Record<MetricKind, string> = {
  sleep: "insights.mood.correlation.sleepTitle",
  steps: "insights.mood.correlation.stepsTitle",
  pulse: "insights.mood.correlation.pulseTitle",
  weight: "insights.mood.correlation.weightTitle",
  bloodPressure: "insights.mood.correlation.bloodPressureTitle",
};

const Y_LABEL_KEY: Record<MetricKind, string> = {
  sleep: "insights.mood.correlation.sleepAxis",
  steps: "insights.mood.correlation.stepsAxis",
  pulse: "insights.mood.correlation.pulseAxis",
  weight: "insights.mood.correlation.weightAxis",
  bloodPressure: "insights.mood.correlation.bloodPressureAxis",
};

// v1.28.17 — the shared `--chart-1..5` vocabulary (same values as the
// `--dracula-purple/cyan/pink/green/orange` primitives it replaces, per
// theme), not raw palette tokens — matches the `no-raw-palette-color`
// discipline and the app's other chart-series colouring.
const FILL_BY_KIND: Record<MetricKind, string> = {
  sleep: "var(--chart-1)",
  steps: "var(--chart-4)",
  pulse: "var(--chart-3)",
  weight: "var(--chart-2)",
  bloodPressure: "var(--chart-5)",
};

const STRENGTH_KEY: Record<CorrelationResult["strength"], string> = {
  stark: "insights.mood.correlation.strengthStrong",
  moderat: "insights.mood.correlation.strengthModerate",
  schwach: "insights.mood.correlation.strengthWeak",
  keine: "insights.mood.correlation.strengthNone",
};

function MoodCorrelationCard({
  kind,
  data,
  className,
}: {
  kind: MetricKind;
  data: MoodMetricCorrelationData;
  className?: string;
}) {
  const { t } = useTranslations();
  const nf = useFormatters();
  const hasResult = data.result != null;

  // Three different silences, and the reader deserves to know which one they
  // are looking at: nothing paired yet, some days paired but not enough to
  // separate a pattern from chance, or enough days and no pattern in them.
  // The last one is a finding, not a gap, and used to render as the same
  // "not enough data" blank as the first.
  const emptyCopy =
    data.suppressed === "notSignificant"
      ? {
          title: t("insights.mood.correlation.noLinkTitle"),
          description: t("insights.mood.correlation.noLinkDescription", {
            n: data.n,
          }),
        }
      : data.n > 0
        ? {
            title: t("insights.mood.correlation.emptyTitle"),
            description: t("insights.mood.correlation.pendingDescription", {
              n: data.n,
              needed: MIN_PAIRED_DAYS,
            }),
          }
        : {
            title: t("insights.mood.correlation.emptyTitle"),
            description: t("insights.mood.correlation.emptyDescription"),
          };

  return (
    <Card
      data-slot="mood-correlation-card"
      data-kind={kind}
      className={className}
    >
      <CardHeader>
        <TileHeader
          size="sm"
          title={t(TITLE_KEY[kind])}
          right={
            hasResult && data.result ? (
              // No `shrink-0` here: the slot kept its icon-era rigidity after
              // v1.22 swapped the info glyph for an inline caption, and the
              // unshrinkable badge+caption row escaped the card's right edge
              // by 14–39 px on phone viewports. The caption itself moves
              // below the title on <sm (see the sm:hidden twin under the
              // header); only the compact badge stays pinned right.
              <div className="flex min-w-0 items-center gap-1.5">
                <Badge variant="outline" className="text-2xs">
                  {t(STRENGTH_KEY[data.result.strength])}
                </Badge>
                {/* v1.12.4 (C4) — the "{n} paired days · r" line sat under the
                    scatter as a half-empty row. Move it into an explainer icon
                    in the header so the card footprint stays tight. */}
                <MoodExplainerIcon
                  className="hidden whitespace-nowrap sm:inline"
                  label={t("insights.mood.correlation.sourceLabel")}
                  detail={t("insights.mood.correlation.source", {
                    n: data.n,
                    r: nf.number(data.result.r, 2),
                  })}
                />
              </div>
            ) : undefined
          }
        />
        {/* <sm twin of the header caption: stacked under the title so the
            title keeps the row width and nothing can escape the tile. */}
        {hasResult && data.result ? (
          <MoodExplainerIcon
            className="sm:hidden"
            label={t("insights.mood.correlation.sourceLabel")}
            detail={t("insights.mood.correlation.source", {
              n: data.n,
              r: nf.number(data.result.r, 2),
            })}
          />
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {hasResult && data.result ? (
          <>
            <ScatterCorrelationChart
              data={data.points}
              fill={FILL_BY_KIND[kind]}
              xAxis={{
                dataKey: "x",
                name: t("insights.moodSectionTitle"),
                domain: [1, 5],
                ticks: [1, 2, 3, 4, 5],
              }}
              yAxis={{ dataKey: "y", name: t(Y_LABEL_KEY[kind]) }}
              height={160}
            />
          </>
        ) : (
          <EmptyState
            variant="plain"
            size="compact"
            icon={<Activity className="size-5" />}
            title={emptyCopy.title}
            description={emptyCopy.description}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function MoodCorrelationCards({
  sleep,
  steps,
  pulse,
  weight,
  bloodPressureSystolic,
}: {
  sleep: MoodMetricCorrelationData;
  steps: MoodMetricCorrelationData;
  pulse: MoodMetricCorrelationData;
  weight: MoodMetricCorrelationData;
  bloodPressureSystolic: MoodMetricCorrelationData;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <MoodCorrelationCard kind="sleep" data={sleep} />
      <MoodCorrelationCard kind="steps" data={steps} />
      <MoodCorrelationCard kind="pulse" data={pulse} />
      <MoodCorrelationCard kind="weight" data={weight} />
      {/* Five fixed cards: on the two-up sm grid the trailing card lands
          alone in its row, so it spans full width there; the three-up lg
          grid leaves it paired (row of 3 + row of 2) and it stays one
          column. */}
      <MoodCorrelationCard
        kind="bloodPressure"
        data={bloodPressureSystolic}
        className="sm:col-span-2 lg:col-span-1"
      />
    </div>
  );
}
