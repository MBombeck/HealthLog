"use client";

/**
 * v1.25.3 — the dated result history with severity badges.
 *
 * v1.27.9 — pinned-only: the combined landing card (with the instrument
 * toggle) is gone; the landing shows intro + instrument cards and nothing
 * else. This component now renders ONE instrument's detail body — trend
 * chart (lazy Recharts, the labs-detail precedent) over the dated list —
 * inside the detail surface a card click opens. The history is deliberately
 * opt-in behind that click, never pushed onto the main page.
 *
 * CRISIS-SAFETY: a flagged PHQ-9 row carries a discreet "support shown"
 * marker; tapping it re-surfaces the STATIC crisis-resource card derived from
 * the row's stored locale (`crisisResourcesForLocale`) — it NEVER decrypts or
 * reveals the item-9 answer, and surfacing it triggers no third-party alert.
 * No new data leaves the safety boundary.
 *
 * Each row also carries an opt-in answer breakdown: expanding it fetches the
 * per-administration detail read, where the server decrypts the stored
 * per-item answers (`AssessmentItemBreakdown`). Item 9 renders there like any
 * other item — the flagged marker above stays the one crisis affordance.
 */
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { importWithRetry } from "@/lib/retry-import";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { crisisResourcesForLocale } from "@/lib/mental-health/crisis-resources";
import { Activity, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

import { DayLinkAt } from "@/components/day/day-link";

import { AssessmentItemBreakdown } from "./assessment-item-breakdown";
import { CrisisCard } from "./crisis-card";
import type { AssessmentRow, CrisisSet, InstrumentId } from "./types";

// Defer the recharts trend chart so recharts stays off the surface's
// first-load JS (the labs detail precedent). The `<ChartSkeleton>` shell
// holds the layout.
const AssessmentHistoryChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({
        default: mod.AssessmentHistoryChart,
      }),
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
function AssessmentHistoryChart(
  props: ComponentProps<typeof AssessmentHistoryChartLazy>,
) {
  return (
    <ChartErrorBoundary>
      <AssessmentHistoryChartLazy {...props} />
    </ChartErrorBoundary>
  );
}

/** Re-derive the STATIC crisis set from a row's locale — no decryption. */
function crisisFromRow(row: AssessmentRow): CrisisSet {
  const set = crisisResourcesForLocale(row.locale);
  return {
    emergencyNumber: set.emergencyNumber,
    resources: set.resources.map((r) => ({
      id: r.id,
      contacts: [...r.contacts],
    })),
  };
}

export function AssessmentHistory({
  rows,
  instrument,
}: {
  /** ALL assessments (any instrument); filtered internally. */
  rows: AssessmentRow[];
  /** The instrument this detail surface is pinned to. */
  instrument: InstrumentId;
}) {
  const { t } = useTranslations();
  const { date: formatDate } = useFormatters();
  // Which flagged row's crisis card is currently expanded (re-surfaced).
  const [openCrisisRowId, setOpenCrisisRowId] = useState<string | null>(null);
  // Which row's per-item answer breakdown is expanded (single-open, like the
  // crisis card — the detail fetch runs only when someone asks).
  const [openBreakdownRowId, setOpenBreakdownRowId] = useState<string | null>(
    null,
  );

  const forInstrument = useMemo(
    () =>
      rows
        .filter((r) => r.instrument === instrument)
        .sort(
          (a, b) =>
            new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
        ),
    [rows, instrument],
  );

  if (forInstrument.length === 0) {
    return (
      <div data-slot="mental-health-history" data-pinned={instrument}>
        <EmptyState
          icon={<Activity className="size-6" />}
          title={t("mentalHealth.history.title")}
          description={t("mentalHealth.history.empty")}
        />
      </div>
    );
  }

  return (
    <div
      data-slot="mental-health-history"
      data-pinned={instrument}
      className="flex flex-col gap-4"
    >
      <AssessmentHistoryChart instrument={instrument} rows={forInstrument} />

      <ul className="flex flex-col gap-1.5" data-slot="history-list">
        {forInstrument.map((row) => {
          const flagged = row.item9Flagged;
          const open = openCrisisRowId === row.id;
          const breakdownOpen = openBreakdownRowId === row.id;
          return (
            <li key={row.id} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                {/* v1.42 — the date opens the day around the result: the
                    keyboard way to the days the chart above opens. */}
                <DayLinkAt at={row.takenAt}>
                  {formatDate(row.takenAt)}
                </DayLinkAt>
                <div className="flex items-center gap-2">
                  {flagged && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto p-0"
                      aria-expanded={open}
                      onClick={() => setOpenCrisisRowId(open ? null : row.id)}
                      data-slot="history-flagged-marker"
                    >
                      <Badge variant="outline">
                        {t("mentalHealth.history.flaggedBadge")}
                      </Badge>
                    </Button>
                  )}
                  <Badge variant="secondary">
                    {t(
                      `mentalHealth.band.${row.instrument}.${row.severityBand}`,
                    )}
                  </Badge>
                  <span className="font-medium tabular-nums">
                    {row.totalScore}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto p-0.5"
                    aria-expanded={breakdownOpen}
                    aria-label={t("mentalHealth.history.answersToggle")}
                    onClick={() =>
                      setOpenBreakdownRowId(breakdownOpen ? null : row.id)
                    }
                    data-slot="history-answers-toggle"
                  >
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "text-muted-foreground size-4 transition-transform",
                        breakdownOpen && "rotate-180",
                      )}
                    />
                  </Button>
                </div>
              </div>
              {flagged && open && <CrisisCard crisis={crisisFromRow(row)} />}
              {breakdownOpen && (
                <div className="border-border/70 border-l pl-3">
                  <AssessmentItemBreakdown
                    assessmentId={row.id}
                    instrument={instrument}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
