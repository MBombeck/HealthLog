"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Loader2, BellRing, BellOff, Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";

/**
 * v1.4.25 W19e — GLP-1 cadence + compliance section.
 *
 * Sits between `<SideEffectsSection>` (W19d) and `<IntakeHistoryList>`
 * on the medication detail page. Same chrome as the W19d / W19f
 * sections, composed via the shared `<MedicationDetailSection>` wrapper.
 *
 * Three sub-sections, top-to-bottom:
 *
 *   1. Header strip — reminder on/off badge + next-due chip + "Edit
 *      schedule" link back to the medication list (where the existing
 *      `medication-form` is the canonical schedule editor; we
 *      deliberately do not re-implement the schedule editor here so
 *      there's no second source of truth).
 *
 *   2. Cadence visualisation — a 30-day track showing one cell per
 *      expected dose, status-coloured (taken / skipped / missed /
 *      upcoming). The legend below the track names each status.
 *      v1.4.25 W21 Fix-N — each cell is wrapped in a 44×44 px button
 *      to meet the WCAG 2.5.5 / Apple HIG tap-target rule; the
 *      visible cell remains the 12 px square the design system pins.
 *
 *   3. Compliance chips — four monochrome chips: adherence rate %,
 *      current streak, longest streak, missed last 30. Marc-memory:
 *      no gamified badges, no WebP art.
 *
 * Data comes from /api/medications/[id]/cadence; the route delegates
 * to the pure scheduling helpers so the chart, the chips, and the
 * route agree dose-for-dose.
 */

interface CadenceTimelineEntry {
  day: string;
  windowStart: string;
  windowEnd: string;
  scheduleIndex: number;
  status: "taken" | "skipped" | "missed" | "upcoming";
}

interface CadenceChips {
  adherenceRate: number | null;
  currentStreak: number;
  longestStreak: number;
  missedLast30: number;
  windowDays: number;
}

interface CadenceResponse {
  windowDays: number;
  anchorIso: string;
  next: {
    windowStart: string;
    windowEnd: string;
    scheduleIndex: number;
  } | null;
  chips: CadenceChips;
  timeline: CadenceTimelineEntry[];
}

interface SchedulingSectionProps {
  medicationId: string;
  reminderEnabled: boolean;
}

const STATUS_STYLES: Record<CadenceTimelineEntry["status"], string> = {
  // Monochrome scale; chart visually identical contract — no new colour
  // tokens, all classes already exist in the design system.
  taken: "bg-primary/85",
  skipped: "bg-muted",
  missed: "bg-destructive/65",
  upcoming: "border-border/70 border bg-background",
};

export function SchedulingSection({
  medicationId,
  reminderEnabled,
}: SchedulingSectionProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data, isLoading, error } = useQuery({
    queryKey: ["medications", medicationId, "cadence"],
    queryFn: async (): Promise<CadenceResponse> => {
      const res = await fetch(
        `/api/medications/${medicationId}/cadence?days=30`,
      );
      if (!res.ok) {
        throw new Error(`Failed to load cadence: ${res.status}`);
      }
      const json = await res.json();
      return json.data as CadenceResponse;
    },
  });

  const adherenceLabel = useMemo(() => {
    if (!data) return null;
    if (data.chips.adherenceRate === null) {
      return t("medications.scheduling.compliance.noData");
    }
    return `${data.chips.adherenceRate}%`;
  }, [data, t]);

  const headerExtras = (
    <div className="flex items-center gap-2">
      <Badge
        variant={reminderEnabled ? "secondary" : "outline"}
        className="gap-1 text-[10px]"
      >
        {reminderEnabled ? (
          <BellRing className="h-3 w-3" />
        ) : (
          <BellOff className="h-3 w-3" />
        )}
        {t(
          reminderEnabled
            ? "medications.scheduling.reminders.on"
            : "medications.scheduling.reminders.off",
        )}
      </Badge>
      <Button
        size="sm"
        variant="outline"
        asChild
        aria-label={t("medications.scheduling.editCta")}
      >
        <Link href="/medications">
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          {t("medications.scheduling.editCta")}
        </Link>
      </Button>
    </div>
  );

  return (
    <MedicationDetailSection
      titleId="scheduling-heading"
      title={t("medications.scheduling.section")}
      headerExtras={headerExtras}
    >
      {isLoading && (
        <div className="text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          <span>{t("medications.scheduling.loading")}</span>
        </div>
      )}

      {!!error && !isLoading && (
        <p className="text-destructive">
          {t("medications.scheduling.loadFailed")}
        </p>
      )}

      {data && !isLoading && (
        <div className="space-y-4">
          {/* Next-dose chip */}
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground">
              {data.next ? (
                <>
                  {t("medications.scheduling.cadenceViz.nextDoseLabel")}{" "}
                  <span className="text-foreground font-medium">
                    {fmt.dateShort(new Date(data.next.windowStart))}
                  </span>
                </>
              ) : (
                t("medications.scheduling.cadenceViz.noNextDose")
              )}
            </p>
          </div>

          {/* 30-day timeline */}
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-[11px] uppercase tracking-wide">
              {t("medications.scheduling.cadenceViz.title")}
            </p>
            {data.timeline.length === 0 ? (
              <p className="text-muted-foreground py-1">
                {t("medications.scheduling.cadenceViz.emptyState")}
              </p>
            ) : (
              <>
                <div
                  // v1.4.27 MB7 / CF-49 — tighten the gap from
                  // `gap-1` (4 px) to `gap-0.5` (2 px) on `<sm` so
                  // the 30-day cadence grid fits in fewer rows on
                  // Pixel 5 (375 px) without sacrificing the 44 px
                  // tap target per cell. At `sm:` and above the
                  // original 4 px gap returns; the wider container
                  // there already absorbs the timeline in 1-2 rows.
                  className="flex flex-wrap gap-0.5 sm:gap-1"
                  role="img"
                  aria-label={t(
                    "medications.scheduling.cadenceViz.ariaTimeline",
                  )}
                  data-slot="cadence-timeline"
                >
                  {data.timeline.map((slot, i) => {
                    const slotLabel = `${fmt.dateShort(new Date(slot.windowStart))} — ${t(
                      `medications.scheduling.cadenceViz.status.${slot.status}`,
                    )}`;
                    return (
                      <button
                        type="button"
                        key={`${slot.windowStart}-${i}`}
                        title={slotLabel}
                        aria-label={slotLabel}
                        data-slot="cadence-timeline-cell"
                        data-status={slot.status}
                        // 44×44 tap target per WCAG 2.5.5; the visible
                        // cell stays the 12 px square the design system
                        // pins inside, centered with flex.
                        className="inline-flex h-11 w-11 items-center justify-center rounded-sm focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
                      >
                        <span
                          className={`h-3 w-3 rounded-sm ${STATUS_STYLES[slot.status]}`}
                          aria-hidden="true"
                        />
                      </button>
                    );
                  })}
                </div>
                <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[10px]">
                  {(["taken", "skipped", "missed", "upcoming"] as const).map(
                    (s) => (
                      <span key={s} className="inline-flex items-center gap-1">
                        <span
                          className={`h-2.5 w-2.5 rounded-sm ${STATUS_STYLES[s]}`}
                        />
                        <span>
                          {t(
                            `medications.scheduling.cadenceViz.status.${s}`,
                          )}
                        </span>
                      </span>
                    ),
                  )}
                </div>
              </>
            )}
          </div>

          {/* Compliance chips */}
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-[11px] uppercase tracking-wide">
              {t("medications.scheduling.compliance.title")}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <ComplianceChip
                label={t("medications.scheduling.compliance.adherenceRate")}
                value={adherenceLabel ?? "—"}
                tooltip={t(
                  "medications.scheduling.compliance.chips.adherenceTooltip",
                )}
              />
              <ComplianceChip
                label={t("medications.scheduling.compliance.currentStreak")}
                value={`${data.chips.currentStreak} ${t(
                  "medications.scheduling.compliance.unit.days",
                )}`}
                tooltip={t(
                  "medications.scheduling.compliance.chips.streakTooltip",
                )}
              />
              <ComplianceChip
                label={t("medications.scheduling.compliance.longestStreak")}
                value={`${data.chips.longestStreak} ${t(
                  "medications.scheduling.compliance.unit.days",
                )}`}
                tooltip={t(
                  "medications.scheduling.compliance.chips.longestTooltip",
                )}
              />
              <ComplianceChip
                label={t("medications.scheduling.compliance.missedLast30")}
                value={`${data.chips.missedLast30} ${t(
                  "medications.scheduling.compliance.unit.doses",
                )}`}
                tooltip={t(
                  "medications.scheduling.compliance.chips.missedTooltip",
                )}
              />
            </div>
          </div>
        </div>
      )}
    </MedicationDetailSection>
  );
}

interface ComplianceChipProps {
  label: string;
  value: string;
  tooltip: string;
}

function ComplianceChip({ label, value, tooltip }: ComplianceChipProps) {
  return (
    <div
      className="bg-muted/30 rounded-md px-2.5 py-1.5"
      title={tooltip}
      aria-label={`${label}: ${value}. ${tooltip}`}
    >
      <p className="text-muted-foreground text-[10px] uppercase tracking-wide">
        {label}
      </p>
      <p className="text-foreground text-sm font-medium">{value}</p>
    </div>
  );
}
