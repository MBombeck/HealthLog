"use client";

import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { SectionHeading } from "@/components/ui/section-heading";
import type { LabChange } from "@/lib/insights/labs-changes";
import { InsightSectionCard } from "./insight-section-card";
import { withLabUnit } from "@/lib/labs/dimensionless";

/**
 * v1.25 — "what changed since your last panel" card.
 *
 * A neutral read off the read-only `/api/insights/labs-changes` route: for each
 * analyte present in both the latest and the previous panel, the latest value,
 * the signed delta, and where the latest value sits against its reference band.
 * It un-mounts when there are fewer than two panels or no shared analyte
 * (`present === false`). Never a diagnosis — neutral framing only.
 */

interface LabsChangesResponse {
  present: boolean;
  latestDate: string | null;
  previousDate: string | null;
  changes: LabChange[];
  generatedAt: string;
}

interface LabsChangesCardProps {
  enabled?: boolean;
  className?: string;
}

function statusLabelKey(status: LabChange["status"]): string | null {
  switch (status) {
    case "in-range":
      return "insights.labsChanges.statusInRange";
    case "below":
      return "insights.labsChanges.statusBelow";
    case "above":
      return "insights.labsChanges.statusAbove";
    default:
      return null;
  }
}

export function LabsChangesCard({
  enabled = true,
  className,
}: LabsChangesCardProps) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const { data } = useQuery({
    queryKey: queryKeys.insightsLabsChanges(),
    queryFn: () => apiGet<LabsChangesResponse>("/api/insights/labs-changes"),
    enabled: enabled && isAuthenticated,
    staleTime: 60_000,
  });

  if (!data || data.present === false) return null;

  return (
    <section
      data-slot="labs-changes-section"
      aria-label={t("insights.labsChanges.sectionTitle")}
      className={cn("space-y-3", className)}
    >
      <SectionHeading
        icon={FlaskConical}
        title={t("insights.labsChanges.sectionTitle")}
        subtitle={t("insights.labsChanges.subtitle")}
      />
      <InsightSectionCard slot="labs-changes-card" flush className="divide-y">
        {data.changes.map((c) => {
          const labelKey = statusLabelKey(c.status);
          const signedDelta =
            c.direction === "flat"
              ? t("insights.labsChanges.directionFlat")
              : withLabUnit(`${c.delta > 0 ? "+" : ""}${c.delta}`, c.unit);
          return (
            <div
              key={c.analyte}
              className="flex items-center justify-between gap-3 px-4 py-3"
              data-slot="labs-change-row"
            >
              <div className="min-w-0">
                <p className="text-foreground truncate text-sm font-medium">
                  {c.analyte}
                </p>
                <p className="text-muted-foreground text-xs">
                  {withLabUnit(String(c.latest), c.unit)}
                  {labelKey ? ` · ${t(labelKey)}` : ""}
                </p>
              </div>
              {/* The delta is CONTENT — the number the row exists to report —
                  so it takes the analyte's tier, not the meta tier of the
                  line under it (ui-standards.md §3). At `text-xs` muted it wore
                  the sub-line's typography and optically attached itself to
                  that lower line, which is what made a row centred to the
                  pixel read as bottom-aligned. `self-center` states the row's
                  alignment on the cell itself so it survives a future change
                  to the row's own `items-*`. */}
              <p
                className="text-foreground shrink-0 self-center text-sm tabular-nums"
                data-slot="labs-change-delta"
              >
                {signedDelta}
              </p>
            </div>
          );
        })}
      </InsightSectionCard>
    </section>
  );
}
