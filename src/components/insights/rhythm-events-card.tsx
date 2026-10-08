"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, HeartPulse, Footprints, Wind, Info } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { SectionHeading } from "@/components/ui/section-heading";
import { InsightSectionCard } from "./insight-section-card";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { DayLinkAt } from "@/components/day/day-link";

/**
 * v1.10.0 — device-flagged event awareness surface (categorical events,
 * WX-B).
 *
 * A timeline of the on-device notifications the user's wearable (Apple
 * Watch / Withings ScanWatch) already produced and synced —
 * irregular-rhythm / high-HR / low-HR / walking-steadiness /
 * breathing-disturbance.
 *
 * Regulatory framing (load-bearing, do not soften): this surface is
 * AWARENESS / SCREENING of the DEVICE's own decision. It reflects ONLY the
 * classification RESULT the device's FDA-cleared / CE-marked on-device
 * algorithm produced. HealthLog never re-classifies and never emits a
 * diagnosis of its own. The disclaimer below states this verbatim; it is a
 * permanent, non-dismissible part of the surface.
 *
 * Data-availability-gated: the card un-mounts entirely (`return null`) when
 * the user has no such events — never an empty / alarming card.
 */

interface RhythmEvent {
  id: string;
  type: string;
  classification: string | null;
  occurredAt: string;
  source: string;
  deviceType: string | null;
}

interface RhythmEventsResponse {
  events: RhythmEvent[];
  hasEvents: boolean;
}

const EVENT_ICONS: Record<string, LucideIcon> = {
  IRREGULAR_RHYTHM_NOTIFICATION: Activity,
  HIGH_HEART_RATE_EVENT: HeartPulse,
  LOW_HEART_RATE_EVENT: HeartPulse,
  WALKING_STEADINESS_EVENT: Footprints,
  BREATHING_DISTURBANCE_EVENT: Wind,
};

const EVENT_LABEL_KEYS: Record<string, string> = {
  IRREGULAR_RHYTHM_NOTIFICATION: "insights.rhythmEvents.event.irregularRhythm",
  HIGH_HEART_RATE_EVENT: "insights.rhythmEvents.event.highHeartRate",
  LOW_HEART_RATE_EVENT: "insights.rhythmEvents.event.lowHeartRate",
  WALKING_STEADINESS_EVENT: "insights.rhythmEvents.event.walkingSteadiness",
  BREATHING_DISTURBANCE_EVENT:
    "insights.rhythmEvents.event.breathingDisturbance",
};

/**
 * The device's verdict, surfaced verbatim. Each line is framed as the
 * device's decision ("Your device flagged …"), never HealthLog's.
 */
const CLASSIFICATION_LABEL_KEYS: Record<string, string> = {
  IRREGULAR: "insights.rhythmEvents.verdict.irregular",
  NOT_DETECTED: "insights.rhythmEvents.verdict.notDetected",
  INCONCLUSIVE: "insights.rhythmEvents.verdict.inconclusive",
  LOW: "insights.rhythmEvents.verdict.low",
  VERY_LOW: "insights.rhythmEvents.verdict.veryLow",
  FIRED: "insights.rhythmEvents.verdict.fired",
};

interface RhythmEventsCardProps {
  enabled?: boolean;
  className?: string;
}

export function RhythmEventsCard({
  enabled = true,
  className,
}: RhythmEventsCardProps) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.insightsRhythmEvents(),
    queryFn: async () => {
      try {
        return await apiGet<RhythmEventsResponse>(
          "/api/insights/rhythm-events",
        );
      } catch {
        throw new Error(t("insights.rhythmEvents.loadError"));
      }
    },
    enabled: enabled && isAuthenticated,
  });

  // A failed read is said, never swallowed: this card carries health alerts,
  // and silently rendering nothing on an error would hide them.
  if (isError && !data) {
    return (
      <section
        data-slot="rhythm-events-section"
        aria-label={t("insights.rhythmEvents.sectionTitle")}
        className={cn("space-y-3", className)}
      >
        <SectionHeading
          icon={Activity}
          title={t("insights.rhythmEvents.sectionTitle")}
        />
        <QueryErrorRow
          slot="rhythm-events-error"
          message={t("insights.rhythmEvents.loadError")}
          onRetry={() => void refetch()}
        />
      </section>
    );
  }

  // Data-availability gate — never paint an empty / alarming card.
  if (isLoading || !data || !data.hasEvents) return null;

  return (
    <section
      data-slot="rhythm-events-section"
      aria-label={t("insights.rhythmEvents.sectionTitle")}
      className={cn("space-y-3", className)}
    >
      <SectionHeading
        icon={Activity}
        title={t("insights.rhythmEvents.sectionTitle")}
      />
      <InsightSectionCard slot="rhythm-events-card">
        <p className="text-muted-foreground text-sm">
          {t("insights.rhythmEvents.sectionIntro")}
        </p>

        <ol data-slot="rhythm-events-timeline" className="space-y-3">
          {data.events.map((event) => {
            const Icon = EVENT_ICONS[event.type] ?? Activity;
            const labelKey = EVENT_LABEL_KEYS[event.type];
            const label = labelKey ? t(labelKey) : event.type;
            const verdictKey = event.classification
              ? CLASSIFICATION_LABEL_KEYS[event.classification]
              : undefined;
            const verdict = verdictKey ? t(verdictKey) : null;
            return (
              <li
                key={event.id}
                data-slot="rhythm-event-row"
                data-event-type={event.type}
                className="border-border/60 flex items-start gap-3 border-b pb-3 last:border-b-0 last:pb-0"
              >
                <span className="bg-muted text-muted-foreground mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-foreground text-sm font-medium">{label}</p>
                  {verdict && (
                    <p
                      data-slot="rhythm-event-verdict"
                      className="text-muted-foreground text-sm"
                    >
                      {verdict}
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs">
                    {/* v1.42 — the date opens the day around the event. */}
                    <DayLinkAt at={event.occurredAt} size="xs">
                      {fmt.dateTime(new Date(event.occurredAt))}
                    </DayLinkAt>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>

        {/* Load-bearing regulatory disclaimer — permanent, non-dismissible.
          Plain React text children (no markdown library — XSS rule). */}
        <div
          data-slot="rhythm-events-disclaimer"
          role="note"
          className="bg-muted/50 text-muted-foreground flex items-start gap-2 rounded-lg p-3 text-xs"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>{t("insights.rhythmEvents.disclaimer")}</p>
        </div>
      </InsightSectionCard>
    </section>
  );
}
