"use client";

/**
 * The detail page's Overview status: the next dose with its state and the
 * take / skip / snooze actions the medication card offers, the reminder
 * state, and the supply runway. The card one level up let a dose be taken
 * and the detail page did not, so a person who opened a medication to check
 * it had to go back to record the dose; the two now share the action row.
 */

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { InlineAction } from "@/components/ui/inline-action";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import { useCardDoseSnooze } from "@/components/medications/card-parts/use-dose-snooze";
import { useWeekdayLabel } from "@/components/medications/card-parts/medication-next-last-slot";
import { DoseStateLabel } from "@/components/medications/dose-state-label";
import { useMedicationIntake } from "@/components/medications/use-medication-intake";
import { formatUnitCount } from "@/components/medications/units-per-dose";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { SupplySummary } from "@/lib/medications/inventory/summary";
import { resolveNextDueDayLabel } from "@/lib/medications/next-due-day-label";
import { estimateRunwayDays } from "@/lib/medications/supply-runway";
import {
  doseStateFromWire,
  isOpenDoseState,
} from "@/lib/medications/dose-state/terms";
import { queryKeys } from "@/lib/query-keys";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import type { TabSlug } from "@/components/medications/detail/tab-slugs";
import type { MedicationDetailSnapshot } from "@/components/medications/detail/medication-detail-tabs";

interface CurrentDoseWire {
  state: string | null;
  takenLate: boolean;
  targetAt: Date | string | null;
}

/** "Today, 08:00", "Tomorrow, 08:00", "Mon, 08:00" or the date: the card's phrasing. */
function useNextDoseText(): (at: string) => string {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const weekday = useWeekdayLabel();
  const { user } = useAuth();
  const tz = user?.timezone || DEFAULT_TIMEZONE;
  return (at) => {
    const label = resolveNextDueDayLabel(new Date(at), new Date(), tz);
    const day =
      label.kind === "today"
        ? t("medications.today")
        : label.kind === "tomorrow"
          ? t("medications.tomorrow")
          : label.kind === "weekday"
            ? weekday(label.weekday)
            : fmt.dateWithWeekdaySmart(label.instant);
    return `${day}, ${fmt.time(at)}`;
  };
}

export function OverviewStatusSection({
  medication,
  recordOnly,
  asNeeded,
  courseStatus,
  currentDose,
  jumpTo,
}: {
  medication: MedicationDetailSnapshot;
  recordOnly: boolean;
  asNeeded: boolean;
  courseStatus?: "UPCOMING" | "CURRENT" | "ENDED";
  currentDose: CurrentDoseWire | null;
  jumpTo: (tab: TabSlug) => (() => void) | undefined;
}) {
  const { t } = useTranslations();
  const nextDoseText = useNextDoseText();
  const id = medication.id;

  // Supply readout: the Bestand tab's query key, so the two share a cache
  // slot; the row only renders once supply items exist.
  const { data: inventory } = useQuery({
    queryKey: queryKeys.medicationInventory(id),
    queryFn: async () => {
      try {
        return await apiGet<{
          items: Array<{
            state: "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";
          }>;
          summary?: SupplySummary;
        } | null>(`/api/medications/${id}/inventory`);
      } catch {
        return null;
      }
    },
    staleTime: 30_000,
  });
  const inventoryItems = Array.isArray(inventory?.items) ? inventory.items : [];
  // Server-authoritative supply figures (iOS#25); the runway is a UI
  // projection over the canonical `dosesRemaining`.
  const {
    unitsRemaining,
    unitsTotal,
    dosesRemaining,
    dosesTotal,
    expiredUnits,
  } = inventory?.summary ?? {
    unitsRemaining: 0,
    unitsTotal: 0,
    dosesRemaining: 0,
    dosesTotal: 0,
    expiredUnits: 0,
  };
  const perDose =
    medication.unitsPerDose && medication.unitsPerDose > 0
      ? medication.unitsPerDose
      : 1;
  const runwayDays =
    medication.runwayDays !== undefined
      ? medication.runwayDays
      : estimateRunwayDays(dosesRemaining, medication.schedules);

  // The open dose and its actions, the card's: the resolved state from the
  // compliance block, the take for the slot the state names (else the next
  // due one), and the snooze while a reminder is open.
  const state = doseStateFromWire(currentDose?.state, currentDose?.takenLate);
  // Only a dose that waits for an answer gets a state beside it: due,
  // overdue, or missed (a take now still counts, late).
  const shownState =
    state === "missed" || (isOpenDoseState(state) && state !== "pending")
      ? state
      : null;
  const canAct =
    medication.active &&
    !recordOnly &&
    courseStatus !== "ENDED" &&
    courseStatus !== "UPCOMING";
  const slotAt =
    currentDose?.targetAt != null
      ? new Date(currentDose.targetAt)
      : medication.nextDueAt
        ? new Date(medication.nextDueAt)
        : null;
  const { intakeLoading, recordIntake } = useMedicationIntake({ medication });
  const snooze = useCardDoseSnooze({
    ...medication,
    trackIntake: !recordOnly,
    intakeActionable: canAct,
  });

  const nextDoseValue: ReactNode = !medication.active
    ? t("medications.detail.uebersicht.pausedHint")
    : recordOnly
      ? t("medications.detail.uebersicht.nextDoseNotTracked")
      : asNeeded
        ? t("medications.detail.uebersicht.nextDoseAsNeeded")
        : medication.nextDueAt
          ? nextDoseText(medication.nextDueAt)
          : t("medications.detail.uebersicht.nextDoseNone");

  return (
    <MedicationDetailSection
      titleId="medication-uebersicht-status-heading"
      title={t("medications.detail.uebersicht.statusTitle")}
      dataSlot="medication-uebersicht-status"
    >
      <ul className="divide-border/60 divide-y">
        <li
          className="space-y-3 py-2.5 first:pt-0 last:pb-0"
          data-slot="uebersicht-next-dose"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-muted-foreground text-xs font-medium">
                {t("medications.detail.uebersicht.nextDoseLabel")}
              </p>
              <p className="text-foreground text-sm">{nextDoseValue}</p>
            </div>
            {canAct && shownState && (
              <DoseStateLabel state={shownState} className="shrink-0 text-sm" />
            )}
          </div>
          {canAct && (
            <MedicationIntakeActions
              intakeLoading={intakeLoading}
              onRecordIntake={(skipped) => void recordIntake(skipped, slotAt)}
              snooze={snooze}
            />
          )}
        </li>
        {/* As-needed never reminds; the row would only mislead. */}
        {!asNeeded && !recordOnly && (
          <StatusRow
            label={t("medications.detail.uebersicht.reminderLabel")}
            value={
              medication.notificationsEnabled
                ? t("medications.detail.uebersicht.reminderOn")
                : t("medications.detail.uebersicht.reminderOff")
            }
            jumpLabel={t("medications.detail.uebersicht.jumpToZeitplan")}
            onJump={jumpTo("schedule")}
            dataSlot="uebersicht-reminder"
          />
        )}
        {inventoryItems.length > 0 && (
          <StatusRow
            label={t("medications.detail.uebersicht.supplyLabel")}
            value={
              <>
                {t("medications.detail.bestand.summary", {
                  remaining: dosesRemaining,
                  total: dosesTotal,
                })}
                {perDose !== 1 && (
                  <span className="text-muted-foreground">
                    {" ("}
                    {t("medications.detail.bestand.unitsDetail", {
                      remaining: formatUnitCount(unitsRemaining),
                      total: formatUnitCount(unitsTotal),
                    })}
                    {")"}
                  </span>
                )}
                {expiredUnits > 0 && (
                  <span className="text-muted-foreground">
                    {" · "}
                    {t("medications.detail.bestand.expiredSuffix", {
                      units: expiredUnits,
                    })}
                  </span>
                )}
                {runwayDays !== null && (
                  <span className="text-muted-foreground">
                    {" · "}
                    {t("medications.detail.uebersicht.supplyRunway", {
                      days: runwayDays,
                    })}
                  </span>
                )}
              </>
            }
            jumpLabel={t("medications.detail.uebersicht.jumpToBestand")}
            onJump={jumpTo("supply")}
            dataSlot="uebersicht-supply"
          />
        )}
      </ul>
    </MedicationDetailSection>
  );
}

/**
 * One status row: label + value on the left, a quiet jump link into the
 * owning tab on the right. The link is a button (the tab switch is shallow
 * URL state, not a navigation) styled as an inline text link.
 */
function StatusRow({
  label,
  value,
  jumpLabel,
  onJump,
  dataSlot,
}: {
  label: string;
  value: ReactNode;
  jumpLabel: string;
  /** Absent when the tab it would open is not offered to this viewer. */
  onJump?: () => void;
  dataSlot: string;
}) {
  return (
    <li
      className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
      data-slot={dataSlot}
    >
      <div className="min-w-0 space-y-0.5">
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
        <p className="text-foreground text-sm">{value}</p>
      </div>
      {onJump && (
        <InlineAction
          onClick={onJump}
          className="shrink-0"
          data-slot={`${dataSlot}-jump`}
        >
          {jumpLabel}
        </InlineAction>
      )}
    </li>
  );
}
