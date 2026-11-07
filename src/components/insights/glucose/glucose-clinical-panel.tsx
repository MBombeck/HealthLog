"use client";

import Link from "next/link";
import { Activity, Droplet, FlaskConical, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { InfoPopover } from "@/components/ui/info-popover";
import { LearningGate } from "@/components/ui/learning-gate";
import { LearnMoreLink } from "@/components/ui/learn-more-link";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  convertGlucose,
  glucoseBandParams,
  resolveGlucoseUnit,
} from "@/lib/glucose";
import type { DataSummary } from "@/lib/analytics/trends";
import { GlucoseTirBar } from "./glucose-tir-bar";
import { GlucoseAdvancedDisclosure } from "./glucose-advanced-disclosure";

/**
 * v1.17.0 — glucose clinical panel.
 *
 * The default view leads with the three numbers that matter to a person
 * managing glucose: time-in-range (Battelino bands, as a stacked bar), a GMI +
 * estimated-A1C pair, and a variability badge that flags "unstable" at CV% ≥ 36
 * (Monnier). The advanced indices (J-index, LBGI/HBGI) sit behind a calm
 * disclosure. Every number is server-computed by the one literature-locked
 * engine — the panel renders verbatim and never re-derives.
 *
 * Honesty contract: HealthLog stores SPOT readings, not a CGM trace, so the
 * copy always carries the "spot-reading estimate" caveat, and a thin window
 * shows a warm "still learning" state instead of asserting a clinical profile.
 * Tone follows the cycle-phase texts: warm, professional, grounded — never
 * alarmist, never breezy.
 *
 * Reads the thick `/api/analytics` payload directly (the slim slice does not
 * carry `glucoseClinical`); the cache cell is shared with the dashboard so the
 * mount is usually a free hit.
 */
export function GlucoseClinicalPanel() {
  const { user, isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const query = useAnalyticsQuery({});

  const glucoseUnit = resolveGlucoseUnit(user?.glucoseUnit ?? null);
  const isMmol = glucoseUnit === "mmol/L";

  if (!isAuthenticated) return null;

  if (query.isLoading) {
    return (
      <Card data-slot="glucose-clinical-panel-skeleton">
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-6 w-full" />
          <div className="grid grid-cols-3 gap-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const clinical = query.data?.glucoseClinical;
  // No glucose data at all, or the thick slice did not carry the block — the
  // page's own empty state already covers the truly-no-data case, so render
  // nothing rather than a redundant card.
  if (!clinical) return null;

  const byContext = query.data?.glucoseByContext as
    Record<string, DataSummary> | undefined;

  const formatGlucoseValue = (mgdl: number): string => {
    const v = convertGlucose(mgdl, glucoseUnit);
    return fmt.number(v, isMmol ? 1 : 0);
  };

  // Learning state — calm, never asserting TIR / GMI off thin data.
  if (clinical.stillLearning) {
    const hasAny = clinical.readingCount > 0;
    const readingsLabel =
      clinical.readingCount === 1
        ? t("insights.bloodGlucose.clinical.readingsCountOne", { count: 1 })
        : t("insights.bloodGlucose.clinical.readingsCount", {
            count: clinical.readingCount,
          });
    const spanDays = Math.max(1, Math.round(clinical.actualSpanDays));
    const daysLabel =
      spanDays === 1
        ? t("insights.bloodGlucose.clinical.daysCountOne", { count: spanDays })
        : t("insights.bloodGlucose.clinical.daysCount", { days: spanDays });

    return (
      <Card data-slot="glucose-clinical-panel" data-state="learning">
        <CardHeader>
          <TileHeader
            icon={Droplet}
            title={t("insights.bloodGlucose.clinical.learningTitle")}
          />
        </CardHeader>
        <CardContent>
          <LearningGate
            bodySlot="glucose-learning-body"
            message={
              hasAny
                ? t("insights.bloodGlucose.clinical.learningBody", {
                    count: readingsLabel,
                    days: daysLabel,
                  })
                : t("insights.bloodGlucose.clinical.learningBodyEmpty")
            }
            caveat={t("insights.bloodGlucose.clinical.spotCaveat")}
          />
          <div className="mt-4">
            <LabsCrossLink />
          </div>
          <div className="mt-3">
            <LearnMoreLink concept="BLOOD_GLUCOSE" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // Asserted view.
  const dist = clinical.distribution;
  const cv = clinical.variability;

  return (
    <Card data-slot="glucose-clinical-panel" data-state="asserted">
      <CardHeader>
        <div className="flex flex-col gap-0.5">
          <TileHeader
            icon={Droplet}
            title={t("insights.bloodGlucose.clinical.title")}
          />
          <span className="text-muted-foreground text-xs">
            {t("insights.bloodGlucose.clinical.subtitle", {
              days: Math.max(1, Math.round(clinical.actualSpanDays)),
              count: clinical.readingCount,
            })}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Time in range */}
        {dist ? (
          <section className="space-y-2" data-slot="glucose-tir-section">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-foreground text-sm font-medium">
                {t("insights.bloodGlucose.clinical.tir.title")}
              </h3>
            </div>
            <GlucoseTirBar distribution={dist} />
            <p className="text-muted-foreground text-xs">
              {t(
                "insights.bloodGlucose.clinical.tir.caption",
                glucoseBandParams(glucoseUnit, fmt.number),
              )}
            </p>
          </section>
        ) : null}

        {/* Headline metrics */}
        <section
          className="grid grid-cols-2 gap-3 sm:grid-cols-4"
          data-slot="glucose-headline"
        >
          {clinical.meanMgdl !== null ? (
            <Metric
              icon={<Droplet className="h-3.5 w-3.5" aria-hidden="true" />}
              label={t("insights.bloodGlucose.clinical.mean.label")}
              value={formatGlucoseValue(clinical.meanMgdl)}
              unit={glucoseUnit}
            />
          ) : null}
          {clinical.gmi !== null ? (
            <Metric
              icon={<Activity className="h-3.5 w-3.5" aria-hidden="true" />}
              label={t("insights.bloodGlucose.clinical.gmi.label")}
              help={t("insights.bloodGlucose.clinical.gmi.help")}
              value={fmt.number(clinical.gmi, 1)}
              unit="%"
            />
          ) : null}
          {clinical.estimatedA1c !== null ? (
            <Metric
              icon={<TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />}
              label={t("insights.bloodGlucose.clinical.eA1c.label")}
              help={t("insights.bloodGlucose.clinical.eA1c.help")}
              value={fmt.number(clinical.estimatedA1c, 1)}
              unit="%"
            />
          ) : null}
          {cv ? (
            <div className="space-y-0.5" data-slot="glucose-cv">
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                {t("insights.bloodGlucose.clinical.cv.label")}
                <InfoPopover
                  content={t("insights.bloodGlucose.clinical.cv.help")}
                />
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-foreground text-lg font-semibold tabular-nums">
                  {Math.round(cv.cv)}%
                </span>
                <Badge
                  variant={cv.unstable ? "destructive" : "secondary"}
                  data-slot="glucose-cv-badge"
                  data-unstable={cv.unstable}
                >
                  {cv.unstable
                    ? t("insights.bloodGlucose.clinical.cv.unstable")
                    : t("insights.bloodGlucose.clinical.cv.steady")}
                </Badge>
              </div>
            </div>
          ) : null}
        </section>

        {/* Spot-reading honesty caveat — only for sparse spot data. A dense
            continuous stream (a CGM such as Nightscout) clears the density bar
            and reports `isSpotEstimate: false`, so the caveat would undersell
            the data. */}
        {clinical.isSpotEstimate ? (
          <p
            className="text-muted-foreground text-xs"
            data-slot="glucose-spot-caveat"
          >
            {t("insights.bloodGlucose.clinical.spotCaveat")}
          </p>
        ) : null}

        {/* Advanced indices behind a disclosure. */}
        {clinical.advanced ? (
          <GlucoseAdvancedDisclosure
            advanced={clinical.advanced}
            byContext={byContext}
          />
        ) : null}

        <LabsCrossLink />
        <LearnMoreLink concept="BLOOD_GLUCOSE" />
      </CardContent>
    </Card>
  );
}

/**
 * v1.18.6 — signpost the measurement-vs-lab mental model. This panel
 * estimates A1c / GMI from spot or CGM readings over time; a lab-ordered
 * HbA1c or fasting-glucose result is a dated panel value that lives under
 * Labs. The cross-link keeps the two surfaces referencing each other so a
 * user knows which door to use rather than treating them as rivals.
 */
function LabsCrossLink() {
  const { t } = useTranslations();
  return (
    <Link
      href="/labs"
      data-slot="glucose-labs-link"
      className="text-muted-foreground hover:text-foreground border-border/60 flex items-start gap-1.5 border-t pt-3 text-xs leading-relaxed underline-offset-4 hover:underline"
    >
      <FlaskConical className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span>{t("insights.bloodGlucose.clinical.labsLink")}</span>
    </Link>
  );
}

function Metric({
  icon,
  label,
  help,
  value,
  unit,
}: {
  icon: React.ReactNode;
  label: string;
  help?: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="space-y-0.5">
      <span className="text-muted-foreground flex items-center gap-1 text-xs">
        {icon}
        {label}
        {help ? <InfoPopover content={help} /> : null}
      </span>
      <span className="text-foreground flex items-baseline gap-1">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        <span className="text-muted-foreground text-xs">{unit}</span>
      </span>
    </div>
  );
}
