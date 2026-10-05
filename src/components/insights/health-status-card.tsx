"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowDownRight, ArrowUpRight } from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { metricFractionDigits } from "@/lib/measurements/value-domain";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { SectionHeading } from "@/components/ui/section-heading";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/components/measurements/measurement-list-meta";
import type {
  HealthStatusDeviation,
  HealthStatusShift,
} from "@/lib/insights/health-status";
import { InsightSectionCard } from "./insight-section-card";

/**
 * v1.25 — baseline-drift card.
 *
 * A calm read of what is drifting from the user's own normal, drawn off the
 * read-only `/api/insights/health-status` route (which folds the personal-band
 * deviations from the coincident engine with the dated changepoint shifts). The
 * card un-mounts entirely when nothing is drifting (`present === false`) rather
 * than surfacing an empty header. Awareness framing only — at most a neutral
 * tone, never a red alert, never a diagnosis.
 */

interface HealthStatusResponse {
  present: boolean;
  deviations: HealthStatusDeviation[];
  shifts: HealthStatusShift[];
  generatedAt: string;
}

interface HealthStatusCardProps {
  enabled?: boolean;
  className?: string;
}

export function HealthStatusCard({
  enabled = true,
  className,
}: HealthStatusCardProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { isAuthenticated } = useAuth();

  const { data } = useQuery({
    queryKey: queryKeys.insightsHealthStatus(),
    queryFn: () => apiGet<HealthStatusResponse>("/api/insights/health-status"),
    enabled: enabled && isAuthenticated,
    staleTime: 60_000,
  });

  if (!data || data.present === false) return null;

  const vitalName = (type: string): string => {
    const key = MEASUREMENT_TYPE_LABEL_KEYS[type];
    return key ? t(key) : type;
  };

  // The engines hand over raw doubles. Interpolating one straight into the
  // sentence prints whatever floating-point produced — a pulse mean reads
  // "68.33333333333333" — and reads in the wrong number convention for every
  // locale that does not use a dot. Render each figure at the metric's own
  // decimal precision, through the same formatter the rest of the app uses.
  const metricValue = (type: string, value: number): string =>
    fmt.number(value, metricFractionDigits(type));

  return (
    <section
      data-slot="health-status-section"
      aria-label={t("insights.healthStatus.sectionTitle")}
      className={cn("space-y-3", className)}
    >
      <SectionHeading
        icon={Activity}
        title={t("insights.healthStatus.sectionTitle")}
        subtitle={t("insights.healthStatus.subtitle")}
      />
      <InsightSectionCard slot="health-status-card">
        {data.deviations.map((d) => (
          <div
            key={`dev-${d.type}`}
            className="flex items-start gap-2"
            data-slot="health-status-deviation"
          >
            {d.direction === "above" ? (
              <ArrowUpRight
                className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
            ) : (
              <ArrowDownRight
                className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0 space-y-0.5">
              <p className="text-foreground text-sm">
                {t(
                  d.direction === "above"
                    ? "insights.healthStatus.deviationAbove"
                    : "insights.healthStatus.deviationBelow",
                  { vital: vitalName(d.type) },
                )}
              </p>
              <p className="text-muted-foreground text-xs leading-snug">
                {t(
                  d.basis === "sameHours"
                    ? "insights.healthStatus.rangeContextTimeOfDay"
                    : "insights.healthStatus.rangeContext",
                  {
                    value: metricValue(d.type, d.value),
                    low: metricValue(d.type, d.low),
                    high: metricValue(d.type, d.high),
                  },
                )}
              </p>
            </div>
          </div>
        ))}

        {data.shifts.map((s) => (
          <div
            key={`shift-${s.metric}`}
            className="flex items-start gap-2"
            data-slot="health-status-shift"
          >
            {s.direction === "up" ? (
              <ArrowUpRight
                className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
            ) : (
              <ArrowDownRight
                className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0 space-y-0.5">
              <p className="text-foreground text-sm">
                {t(
                  s.direction === "up"
                    ? "insights.healthStatus.shiftUp"
                    : "insights.healthStatus.shiftDown",
                  { vital: vitalName(s.metric) },
                )}
              </p>
              <p className="text-muted-foreground text-xs leading-snug">
                {t("insights.healthStatus.shiftContext", {
                  before: metricValue(s.metric, s.beforeMean),
                  after: metricValue(s.metric, s.afterMean),
                })}
              </p>
            </div>
          </div>
        ))}
      </InsightSectionCard>
    </section>
  );
}
