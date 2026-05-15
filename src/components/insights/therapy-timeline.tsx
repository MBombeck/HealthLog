"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pill, Syringe } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  describeInjectionSite,
  type InjectionSiteKey,
} from "@/lib/medications/injection-sites";

/**
 * v1.4.25 W4d — therapy-timeline view for /insights/medikamente.
 *
 * Renders a chronological list of GLP-1 therapy events: dose changes,
 * injections (with site if recorded), inventory events, side-effect tag
 * occurrences. Pure list view — no chart — so the medications-page
 * "no chart on the medication card" rule stays consistent across all
 * GLP-1 surfaces; the dose curve lives on the Dashboard tile only.
 *
 * Self-hides for users with no GLP-1 medications (the parent route does
 * the gating via a non-200 from the API endpoint).
 */

interface TimelineEntry {
  date: string;
  kind: "dose-change" | "injection" | "inventory" | "side-effect";
  medicationName?: string;
  doseValue?: number;
  doseUnit?: string;
  doseDelta?: "up" | "down" | null;
  note?: string | null;
  injectionSite?: InjectionSiteKey | null;
  inventoryDelta?: number;
  reason?: string;
  tags?: string[];
}

interface TherapyTimelineResponse {
  hasGlp1: boolean;
  entries: TimelineEntry[];
}

interface TherapyTimelineProps {
  /** Optional cap — defaults to the API's default (60 entries). */
  limit?: number;
}

export function TherapyTimeline({ limit }: TherapyTimelineProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data, isLoading } = useQuery({
    queryKey: ["insights", "glp1-timeline", limit ?? "default"],
    queryFn: async () => {
      const url = limit
        ? `/api/insights/glp1-timeline?limit=${limit}`
        : "/api/insights/glp1-timeline";
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as TherapyTimelineResponse;
    },
    staleTime: 60 * 1000,
  });

  if (isLoading || !data || !data.hasGlp1) return null;
  if (data.entries.length === 0) {
    return (
      <Card data-slot="therapy-timeline">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Syringe className="text-dracula-purple h-4 w-4" />
            {t("insights.therapyTimeline.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {t("insights.therapyTimeline.empty")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-slot="therapy-timeline">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Syringe className="text-dracula-purple h-4 w-4" />
          {t("insights.therapyTimeline.title")}
        </CardTitle>
        <p className="text-muted-foreground text-xs">
          {t("insights.therapyTimeline.description")}
        </p>
      </CardHeader>
      <CardContent>
        <ol className="border-border/60 relative space-y-3 border-l pl-4">
          {data.entries.map((entry) => (
            <li
              key={`${entry.kind}-${entry.date}-${entry.medicationName ?? ""}`}
              className="relative"
            >
              <span
                className="border-background absolute top-1 -left-[18px] h-3 w-3 rounded-full border-2"
                aria-hidden="true"
                style={{ backgroundColor: colourForKind(entry.kind) }}
              />
              <div className="space-y-0.5">
                {/* v1.4.27 B7 / L4 — sr-only drug-name heading per
                    entry so screen-reader users can jump between
                    medication blocks; the visible row keeps the
                    inline <strong> rendering. */}
                {entry.medicationName && (
                  <h4 className="sr-only">{entry.medicationName}</h4>
                )}
                <p className="text-muted-foreground text-xs">
                  {fmt.dateWithWeekday(new Date(entry.date))}
                </p>
                <p className="text-foreground/90 text-sm">
                  {renderEntryLine(entry, t)}
                </p>
                {entry.note && (
                  <p className="text-muted-foreground text-xs italic">
                    {entry.note}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function colourForKind(kind: TimelineEntry["kind"]): string {
  switch (kind) {
    case "dose-change":
      return "var(--dracula-purple)";
    case "injection":
      return "var(--dracula-cyan)";
    case "inventory":
      return "var(--dracula-yellow)";
    case "side-effect":
      return "var(--dracula-orange)";
  }
}

function renderEntryLine(
  entry: TimelineEntry,
  t: (key: string, params?: Record<string, string | number>) => string,
): React.ReactNode {
  const drug = entry.medicationName ?? "";
  switch (entry.kind) {
    case "dose-change": {
      const arrow =
        entry.doseDelta === "up" ? (
          <ArrowUp className="inline h-3 w-3" aria-hidden="true" />
        ) : entry.doseDelta === "down" ? (
          <ArrowDown className="inline h-3 w-3" aria-hidden="true" />
        ) : null;
      return (
        <span>
          <strong>{drug}</strong> {t("insights.therapyTimeline.doseTo")}{" "}
          <span className="font-medium tabular-nums">
            {entry.doseValue} {entry.doseUnit}
          </span>
          {arrow && <> {arrow}</>}
        </span>
      );
    }
    case "injection": {
      const site = entry.injectionSite
        ? ` · ${t(describeInjectionSite(entry.injectionSite))}`
        : "";
      return (
        <span>
          <Pill
            className="text-dracula-cyan mr-1 inline h-3 w-3"
            aria-hidden="true"
          />
          <strong>{drug}</strong>
          {site}
        </span>
      );
    }
    case "inventory": {
      const sign = entry.inventoryDelta && entry.inventoryDelta > 0 ? "+" : "";
      return (
        <span>
          <strong>{drug}</strong> · {sign}
          {entry.inventoryDelta} {t("insights.therapyTimeline.pens")} (
          {entry.reason})
        </span>
      );
    }
    case "side-effect": {
      return (
        <span>
          {t("insights.therapyTimeline.sideEffects")}:{" "}
          {(entry.tags ?? []).join(", ")}
        </span>
      );
    }
  }
}
