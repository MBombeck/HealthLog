"use client";

import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";

import { InfoPopover } from "@/components/ui/info-popover";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { detectMeasurementDiversity } from "@/lib/insights/measurement-diversity";

/**
 * v1.8.5 — measurement-diversity nudge for the insights category pages.
 *
 * When a metric's readings cluster on a single weekday or a narrow
 * time-of-day band, the trend reads a biased slice of reality. This
 * component fetches a bounded recent window of raw timestamps for the
 * metric, runs the pure `detectMeasurementDiversity` check, and — only
 * when the spread is genuinely lopsided — surfaces a gentle hint to
 * measure on other days / times.
 *
 * v1.8.6 — the hint moved off the page body and onto the heading. The
 * inline `role="note"` block confused on the category pages (it read
 * like a data finding rather than a tip), so the nudge now renders as a
 * small `Lightbulb` glyph beside the page title. The hint text the block
 * used to show inline opens on a tap (`InfoPopover`); the glyph mounts
 * only when the spread is actually lopsided, so a healthy metric shows
 * no extra affordance at all.
 *
 * v1.8.3 anti-freeze posture: the read is a bounded `limit`-capped query
 * with a 5-minute `staleTime`, fires only after the page has mounted
 * (no SSR blocking), and renders nothing while in flight or when the
 * spread is healthy. No new server route — it rides the existing
 * `/api/measurements` list endpoint.
 */

interface MeasurementDiversityNudgeProps {
  /** The page's `MeasurementType`. */
  measurementType: string;
  /** Localised metric name woven into the hint copy. */
  metricLabel: string;
  /** User's IANA timezone so weekday / hour resolve in the wall clock. */
  timeZone?: string;
}

/** Bounded window of recent rows — enough to read a pattern, never heavy. */
const WINDOW_SIZE = 120;

export function MeasurementDiversityNudge({
  measurementType,
  metricLabel,
  timeZone,
}: MeasurementDiversityNudgeProps) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const { data: timestamps } = useQuery({
    queryKey: queryKeys.measurementDiversity(measurementType),
    queryFn: async (): Promise<string[]> => {
      const params = new URLSearchParams();
      params.set("type", measurementType);
      params.set("limit", String(WINDOW_SIZE));
      params.set("sortBy", "measuredAt");
      params.set("sortDir", "desc");
      try {
        const data = await apiGet<{
          measurements?: Array<{ measuredAt: string }>;
        }>(`/api/measurements?${params}`);
        return (data?.measurements ?? []).map((r) => r.measuredAt);
      } catch {
        // Nudge is optional — degrade to "no data", as before.
        return [];
      }
    },
    enabled: isAuthenticated,
    // The pattern shifts slowly — a 5-minute cache keeps the nudge calm
    // and shares the read budget with the rest of the page.
    staleTime: 5 * 60 * 1000,
  });

  if (!timestamps) return null;

  const signal = detectMeasurementDiversity(timestamps, timeZone);
  if (!signal) return null;

  const message = t(`insights.subPage.diversity.${signal.kind}`, {
    metric: metricLabel,
  });
  const triggerLabel = t("insights.subPage.diversity.trigger");

  return (
    <InfoPopover
      content={message}
      label={triggerLabel}
      icon={Lightbulb}
      iconClassName="size-4"
      className="text-warning hover:text-warning/80"
      align="start"
      triggerDataSlot="measurement-diversity-nudge"
      bodyDataSlot="measurement-diversity-nudge-body"
    />
  );
}
