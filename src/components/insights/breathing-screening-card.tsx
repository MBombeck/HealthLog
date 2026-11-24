"use client";

import { useQuery } from "@tanstack/react-query";
import { Wind } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { SectionHeading } from "@/components/ui/section-heading";
import type {
  BreathingClassification,
  BreathingTrend,
} from "@/lib/insights/breathing-screening";
import { InsightSectionCard } from "./insight-section-card";

/**
 * v1.25 — sleep-breathing screening card.
 *
 * A calm read off the read-only `/api/insights/breathing-screening` route: the
 * device's own classification, the recent index trend, and the device-flagged
 * event count. It un-mounts when there is no data (`present === false`). Every
 * render carries the mandatory screening-only disclaimer — this is a SCREENING
 * SIGNAL, not a diagnosis. Neutral tone, no chart, no red.
 */

interface BreathingScreeningResponse {
  present: boolean;
  nights: number;
  recentMeanIndex: number | null;
  trend: BreathingTrend;
  eventCount: number;
  classification: BreathingClassification;
  generatedAt: string;
}

interface BreathingScreeningCardProps {
  enabled?: boolean;
  className?: string;
}

export function BreathingScreeningCard({
  enabled = true,
  className,
}: BreathingScreeningCardProps) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const { data } = useQuery({
    queryKey: queryKeys.insightsBreathingScreening(),
    queryFn: () =>
      apiGet<BreathingScreeningResponse>("/api/insights/breathing-screening"),
    enabled: enabled && isAuthenticated,
    staleTime: 60_000,
  });

  if (!data || data.present === false) return null;

  const classificationLabel =
    data.classification === "elevated"
      ? t("insights.breathingScreening.classificationElevated")
      : data.classification === "not-elevated"
        ? t("insights.breathingScreening.classificationNotElevated")
        : null;

  const trendLabel =
    data.trend === "up"
      ? t("insights.breathingScreening.trendUp")
      : data.trend === "down"
        ? t("insights.breathingScreening.trendDown")
        : data.trend === "stable"
          ? t("insights.breathingScreening.trendStable")
          : null;

  return (
    <section
      data-slot="breathing-screening-section"
      aria-label={t("insights.breathingScreening.sectionTitle")}
      className={cn("space-y-3", className)}
    >
      <SectionHeading
        icon={Wind}
        title={t("insights.breathingScreening.sectionTitle")}
        subtitle={t("insights.breathingScreening.subtitle")}
      />
      <InsightSectionCard slot="breathing-screening-card">
        {classificationLabel ? (
          <p
            className="text-foreground text-sm font-medium"
            data-slot="breathing-classification"
          >
            {classificationLabel}
          </p>
        ) : null}

        <p className="text-muted-foreground text-xs leading-snug">
          {t("insights.breathingScreening.nights", { count: data.nights })}
          {data.recentMeanIndex != null
            ? `, ${t("insights.breathingScreening.indexLine", {
                value: data.recentMeanIndex,
              })}`
            : ""}
        </p>

        {trendLabel ? (
          <p
            className="text-muted-foreground text-xs leading-snug"
            data-slot="breathing-trend"
          >
            {trendLabel}
          </p>
        ) : null}

        {data.eventCount > 0 ? (
          <p
            className="text-muted-foreground text-xs leading-snug"
            data-slot="breathing-events"
          >
            {t("insights.breathingScreening.eventsFlagged", {
              count: data.eventCount,
            })}
          </p>
        ) : null}

        <p
          className="text-muted-foreground mt-1 text-xs leading-snug"
          data-slot="breathing-disclaimer"
        >
          {t("insights.breathingScreening.disclaimer")}
        </p>
      </InsightSectionCard>
    </section>
  );
}
