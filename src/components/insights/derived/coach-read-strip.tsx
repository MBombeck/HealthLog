"use client";

import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { metricFractionDigits } from "@/lib/measurements/value-domain";
import { apiGet } from "@/lib/api/api-fetch";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";

/**
 * v1.21.2 (A1) — "Coach read" strip.
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
 * Server-authoritative: the component only renders the resolved DTO from
 * `/api/insights/coach-read`. It never re-derives a band or a correlation, so
 * the web and iOS strips read identical numbers. The strip self-gates: it
 * paints nothing until the read lands, and nothing at all when there is no
 * baseline AND no driver (a brand-new metric stays clean).
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

  const { data } = useQuery({
    queryKey: queryKeys.insightsCoachRead(metricType, locale),
    queryFn: () =>
      apiGet<CoachReadStripData>(
        `/api/insights/coach-read?metric=${encodeURIComponent(metricType)}`,
      ),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });

  // Match the rest of the query-dependent insights chrome: don't paint a
  // branch during SSR / hydration (React #418) and don't paint until the
  // read lands.
  if (!mounted || !data) return null;

  const fmt = (value: number): string =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(
      transformed
        ? unitDisplay.toDisplay(metricType, value)
        : value * valueScale,
    );

  // `YYYY-MM-DD` is already the reader's calendar day; formatting it at UTC
  // midnight in UTC keeps a second zone conversion from shifting it.
  const fmtDay = (day: string | undefined): string => {
    const m = day ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
    if (!m) return "";
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  };

  const baselineLine = ((): string | null => {
    if (data.learning || !data.baseline) {
      return t("insights.coach.readStrip.insufficient");
    }
    const { low, high, latest, placement, basis, latestIsToday } =
      data.baseline;
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
      unit: resolvedUnit,
      date: fmtDay(data.baseline.latestDate),
    });
  })();

  // Only the wrapper is translated here. `note` is a finished sentence the
  // server wrote in the reader's language, so it goes in as it arrived — which
  // is exactly why the route has to know the language, and why this query is
  // keyed by locale.
  const driverLine = data.driver
    ? t("insights.coach.readStrip.driver", { note: data.driver.note })
    : null;

  // Self-gate: nothing to say when both lines are absent. (The baseline line
  // is always non-null — it degrades to the "learning" copy — so this only
  // fires defensively.)
  if (!baselineLine && !driverLine) return null;

  // Standard card anatomy — the real Card + TileHeader + CardContent
  // primitives at the compact density (the metric-stat-strip reference),
  // so background, radius, icon spacing and the left text edge match
  // every other insights tile. The former hand-rolled shell
  // (`bg-card/60 … px-4 py-3.5`) painted a translucent background and a
  // text edge ~8 px left of the card norm on md+. Body prose in the
  // regular foreground; muted stays reserved for meta lines.
  return (
    <Card data-slot="coach-read-strip" className="gap-2 py-3 md:py-4">
      <CardHeader>
        <TileHeader
          icon={Sparkles}
          title={t("insights.coach.readStrip.label")}
          // L3 — top-level section on every metric sub-page, sibling of the
          // already-`h2` stat strip directly under the page `h1`.
          titleAs="h2"
        />
      </CardHeader>
      <CardContent>
        <div className="min-w-0 space-y-1 text-sm leading-relaxed">
          {baselineLine ? (
            <p data-slot="coach-read-baseline" className="text-pretty">
              {baselineLine}
            </p>
          ) : null}
          {driverLine ? (
            <p data-slot="coach-read-driver" className="text-pretty">
              {driverLine}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
