"use client";

import { useQueries } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, Sparkles } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { metricFractionDigits } from "@/lib/measurements/value-domain";
import { pairOf } from "@/lib/measurements/paired-metrics";
import { apiGet } from "@/lib/api/api-fetch";
import { readFailureKind } from "@/lib/api/read-failure";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { ValueRow, type ValueRowItem } from "@/components/insights/value-row";
import { cn } from "@/lib/utils";
import type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";

/**
 * v1.21.2 — "Coach read" strip.
 *
 * A compact two-line read rendered ABOVE the chart on each metric sub-page:
 *
 *   1. own-baseline — "Your usual range is X–Y; today's Z sits within /
 *      above / below", or "your latest reading, <date>, was Z" when the
 *      newest reading is not from today in the reader's zone. For a glucose day still in progress the range is the
 *      one for this time of day and Z today's mean so far. Below the engine's 7-day history floor it reads
 *      "still learning your range" — never a fabricated band.
 *   2. one lagged association — the single strongest discovered driver whose
 *      outcome is this metric, stated in the engine's own never-causal voice.
 *      Omitted entirely when no driver clears the existing effect-size floor.
 *
 * A component of a paired metric (blood pressure: systolic and diastolic)
 * reads every component and writes one line per component, each named: a
 * single unnamed band on the blood-pressure page read as one range over both
 * values ("79–177 mmHg").
 *
 * Server-authoritative: the component only renders the resolved DTO from
 * `/api/insights/coach-read`. It never re-derives a band or a correlation, so
 * the web and iOS strips read identical numbers. Until every read lands the
 * strip holds its place with a placeholder card; a landed read always says
 * something, the "still learning" line at the least.
 */

export interface CoachReadStripProps {
  /** The MeasurementType the route keys on (e.g. `WEIGHT`, `RESTING_HEART_RATE`). */
  metricType: string;
  /** Unit suffix rendered next to the band edges + today's value. */
  unit: string;
  /**
   * Decimal precision for the formatted numbers. Optional: when omitted the
   * precision follows the METRIC (`metricFractionDigits`) — a discrete metric
   * resolves 0, everything else the shared default of 1. It used to default
   * to a flat 1 and rely on each page remembering to pass 0, which is how a
   * step page came to print "104.0 steps". Pass it only to override the
   * metric's own answer.
   */
  fractionDigits?: number;
  /**
   * Display-time value scale folded into the band edges + today's value (e.g.
   * WALKING_SPEED stores m/s but renders km/h via `valueScale={3.6}`). The
   * server computes the placement on unscaled stored values (scale-invariant),
   * so scaling here only affects the displayed numbers. Defaults to 1.
   */
  valueScale?: number;
}

/**
 * The strip's body holds the height of the error row's Retry button (32 px,
 * 44 px on a touch screen) in every state, so the placeholder, a failure and
 * a one-line read all stand the same height and the chart below never moves.
 */
const STRIP_BODY = "min-h-8 pointer-coarse:min-h-11";

// `YYYY-MM-DD` is already the reader's calendar day; formatting it at UTC
// midnight in UTC keeps a second zone conversion from shifting it.
function formatDay(day: string | undefined, locale: string): string {
  const m = day ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!m) return "";
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
}

/** The usual-range sentence for one resolved read. */
function baselineSentence(
  read: CoachReadStripData,
  {
    t,
    fmt,
    unit,
    locale,
  }: {
    t: (key: string, params?: Record<string, string | number>) => string;
    fmt: (value: number) => string;
    unit: string;
    locale: string;
  },
): string {
  if (read.learning || !read.baseline) {
    return t("insights.coach.readStrip.insufficient");
  }
  const { low, high, latest, placement, basis, latestIsToday } = read.baseline;
  // A band whose ends format to the same figure ("61–61 bpm") is a steady
  // value, not a range; say it as one.
  const steady = fmt(low) === fmt(high);
  // A glucose day still in progress is held against the same hours of the
  // earlier days, so the range is the one for this time of day and today's
  // figure is its mean so far; the sentence says both.
  // A latest reading from an earlier day is not today's: the sentence names
  // its date instead (`latestIsToday`, resolved server-side). The same-hours
  // basis only exists for a day in progress, so it is always today.
  const dated = basis !== "sameHours" && latestIsToday === false;
  const key =
    basis === "sameHours"
      ? placement === "above"
        ? "insights.coach.readStrip.sameHoursAbove"
        : placement === "below"
          ? "insights.coach.readStrip.sameHoursBelow"
          : "insights.coach.readStrip.sameHoursWithin"
      : dated
        ? steady
          ? placement === "above"
            ? "insights.coach.readStrip.steadyLatestAbove"
            : placement === "below"
              ? "insights.coach.readStrip.steadyLatestBelow"
              : "insights.coach.readStrip.steadyLatestWithin"
          : placement === "above"
            ? "insights.coach.readStrip.latestAbove"
            : placement === "below"
              ? "insights.coach.readStrip.latestBelow"
              : "insights.coach.readStrip.latestWithin"
        : steady
          ? placement === "above"
            ? "insights.coach.readStrip.steadyAbove"
            : placement === "below"
              ? "insights.coach.readStrip.steadyBelow"
              : "insights.coach.readStrip.steadyWithin"
          : placement === "above"
            ? "insights.coach.readStrip.baselineAbove"
            : placement === "below"
              ? "insights.coach.readStrip.baselineBelow"
              : "insights.coach.readStrip.baselineWithin";
  return t(key, {
    low: fmt(low),
    high: fmt(high),
    value: fmt(latest),
    unit,
    date: formatDay(read.baseline.latestDate, locale),
  });
}

export function CoachReadStrip({
  metricType,
  unit,
  fractionDigits,
  valueScale = 1,
}: CoachReadStripProps) {
  const digits = fractionDigits ?? metricFractionDigits(metricType);
  const { isAuthenticated } = useAuth();
  const { t, locale } = useTranslations();
  const mounted = useMounted();
  // v1.32.26 — a type with a registered metric/imperial transform resolves its
  // display unit + conversion from the user's preference and IGNORES the
  // page-passed `unit` / `valueScale` (weight labelled "kg" would otherwise
  // never follow the toggle). The band edges + today's value are ABSOLUTE, so
  // the affine `toDisplay` (factor + offset) is correct here. Untransformed
  // metrics keep the props (glucose passes its own unit + reciprocal scale).
  const unitDisplay = useUnitDisplay();
  const transformed = unitDisplay.isTransformed(metricType);
  const resolvedUnit = transformed ? unitDisplay.unitFor(metricType) : unit;

  // A component of a paired metric reads every component of the pair, in
  // reading order; the driver line comes from the page's own metric.
  const pair = pairOf(metricType);
  const types = pair ? [...pair.components] : [metricType];
  const reads = useQueries({
    queries: types.map((type) => ({
      queryKey: queryKeys.insightsCoachRead(type, locale),
      queryFn: () =>
        apiGet<CoachReadStripData>(
          `/api/insights/coach-read?metric=${encodeURIComponent(type)}`,
        ),
      enabled: isAuthenticated,
      staleTime: 5 * 60 * 1000,
    })),
  });
  const failed = reads.find((r) => r.isError);
  const isError = failed !== undefined;
  const error = failed?.error ?? null;
  const refetch = () => {
    for (const r of reads) if (r.isError) void r.refetch();
  };
  const landed = reads.every((r) => r.data !== undefined);
  const data = landed ? (reads[types.indexOf(metricType)]?.data ?? null) : null;

  // Don't paint a data branch during SSR / hydration (React #418). While the
  // read is on its way the strip holds its place with a card of the same
  // shape: it lands above the chart, and popping in later pushed the chart
  // and everything under it down the page. A landed read always paints (the
  // baseline line degrades to the "learning" copy), so the placeholder only
  // ever gives way to a card of its own height. A failed read gives way to a
  // notice with a retry: dropping the strip read as "nothing to say about
  // today", which is not what happened. The notice sits inside the same card
  // shell as the placeholder, so a failure does not move the chart either.
  // The route is a manage-level read, so a viewer on a read-only share is
  // refused it; that draws nothing, and a spent analytics budget says so
  // without offering a retry.
  if (!mounted || !data) {
    if (!isAuthenticated) return null;
    if (isError && readFailureKind(error) === "refused") return null;
    return (
      <Card
        data-slot="coach-read-strip"
        data-state={isError ? "error" : "loading"}
        aria-busy={isError ? undefined : "true"}
        density="compact"
      >
        <CardHeader>
          <TileHeader
            icon={Sparkles}
            title={t("insights.coach.readStrip.label")}
            titleAs="h2"
          />
        </CardHeader>
        <CardContent className={STRIP_BODY}>
          {isError ? (
            <QueryErrorRow
              inset
              error={error}
              slot="coach-read-strip-error"
              message={t("insights.coach.readStrip.loadError")}
              onRetry={() => void refetch()}
              className="flex-row items-center justify-between"
            />
          ) : (
            <Skeleton className="h-5.5 w-3/4" />
          )}
        </CardContent>
      </Card>
    );
  }

  const fmt = (value: number): string =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(
      transformed
        ? unitDisplay.toDisplay(metricType, value)
        : value * valueScale,
    );

  const sentenceArgs = { t, fmt, unit: resolvedUnit, locale };
  // One read-out per component of a pair, each named; one otherwise. The
  // full sentence stays the cell's accessible name and hover text; the card
  // shows the range and today's value beside a mark for where it sits.
  const items: ValueRowItem[] = types.map((type, i) => {
    const read = reads[i].data!;
    const sentence = baselineSentence(read, sentenceArgs);
    const label = pair
      ? t(pair.labelKeys[type])
      : t("insights.coach.readStrip.range");
    const title = pair
      ? t("insights.coach.readStrip.componentLine", {
          component: label,
          line: sentence,
        })
      : sentence;
    return readOut(type, read, {
      label,
      title,
      fmt,
      t,
      locale,
      sentence,
      unit: resolvedUnit,
    });
  });

  // Standard card anatomy at the compact density, the same as the stat
  // strip above it. The lagged association the read also carries is not
  // shown here: a finding about another metric is the overview's to tell.
  return (
    <Card data-slot="coach-read-strip" density="compact">
      <CardHeader>
        <TileHeader
          icon={Sparkles}
          title={t("insights.coach.readStrip.label")}
          // Top-level section on every metric sub-page, sibling of the
          // already-`h2` stat strip directly under the page `h1`.
          titleAs="h2"
        />
      </CardHeader>
      <CardContent className={STRIP_BODY}>
        <ValueRow items={items} slot="coach-read-baseline" />
      </CardContent>
    </Card>
  );
}

/** Where today's value sits against the range, as a mark with its word. */
const PLACEMENT_MARK = {
  within: { Icon: Check, tone: "text-success" },
  above: { Icon: ArrowUp, tone: "text-warning" },
  below: { Icon: ArrowDown, tone: "text-warning" },
} as const;

/** One component's read-out: the range, and the latest value with its mark. */
function readOut(
  type: string,
  read: CoachReadStripData,
  {
    label,
    title,
    fmt,
    t,
    locale,
    sentence,
    unit,
  }: {
    unit: string;
    label: string;
    title: string;
    fmt: (value: number) => string;
    t: (key: string, params?: Record<string, string | number>) => string;
    locale: string;
    sentence: string;
  },
): ValueRowItem {
  if (read.learning || !read.baseline) {
    return { key: type, label, value: "\u2014", note: sentence, title };
  }
  const { low, high, latest, placement, basis, latestIsToday, latestDate } =
    read.baseline;
  const range =
    fmt(low) === fmt(high) ? fmt(low) : `${fmt(low)}\u2013${fmt(high)}`;
  const value = fmt(latest);
  const latestText =
    basis === "sameHours"
      ? t("insights.coach.readStrip.soFarValue", { value })
      : latestIsToday === false
        ? t("insights.coach.readStrip.latestValue", {
            value,
            date: formatDay(latestDate, locale),
          })
        : t("insights.coach.readStrip.todayValue", { value });
  const mark = PLACEMENT_MARK[placement] ?? PLACEMENT_MARK.within;
  return {
    key: type,
    label,
    value: range,
    unit,
    title,
    note: (
      <>
        <span>{latestText}</span>
        <mark.Icon
          className={cn("size-3.5 shrink-0", mark.tone)}
          aria-hidden="true"
        />
        <span className="sr-only">{sentence}</span>
      </>
    ),
  };
}
