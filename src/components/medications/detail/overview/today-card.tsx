"use client";

/**
 * The overview's "Today" card: today's doses with their state, one sentence
 * about the next one, and Skip / Take (Log past dose / Take for an
 * as-needed medication). The doses are the server's today list, later slots
 * included; the take records the slot the card's resolved dose names, the
 * same as on the medication card.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { BellRing, Pill } from "lucide-react";

import { ActionPair } from "@/components/ui/action-pair";
import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";
import { DoseStateLabel } from "@/components/medications/dose-state-label";
import { useCardDoseSnooze } from "@/components/medications/card-parts/use-dose-snooze";
import { useMedicationIntake } from "@/components/medications/use-medication-intake";
import { useNextDoseText } from "@/components/medications/detail/overview-status-section";
import type { MedicationDetailSnapshot } from "@/components/medications/detail/medication-detail-tabs";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import {
  useDisplayTimezone,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";
import type { DoseState } from "@/lib/medications/dose-state/resolve";
import { cardTakeSlot, type TakeSlot } from "@/lib/medications/dose-state/pill";
import { DOSE_ACTION_TERM } from "@/lib/medications/dose-state/terms";
import { queryKeys } from "@/lib/query-keys";
import { userDayKey } from "@/lib/tz/format";

import { OverviewCard, type OverviewCompliance } from "./anatomy";

/** One of today's doses, from the server's today list. */
export interface TodayDose {
  key: string;
  /** The slot's time; null for a take on no slot. */
  slotAt: string | null;
  takenAt: string | null;
  state: DoseState | null;
}

interface TodayWireRow {
  id: string;
  medicationId: string;
  takenAt: string | null;
  slotInstant: string | null;
  state: "upcoming" | "due" | "overdue" | "taken" | "skipped" | "missed" | null;
  takenLate: boolean;
}

function toDoseState(row: TodayWireRow): DoseState | null {
  if (row.state === "upcoming") return "pending";
  if (row.state === "taken" && row.takenLate) return "taken_late";
  return row.state;
}

/**
 * Today's doses of one medication, later slots included: the today list the
 * cards and the app read (`GET /api/medications/intake?scope=today`), in its
 * shared cache cell. The dose history stops at now, so it cannot say what is
 * still to come today.
 */
export function useTodayDoses(medicationId: string, enabled: boolean) {
  const { data } = useQuery({
    queryKey: queryKeys.medicationIntakeToday(),
    queryFn: () =>
      apiGet<TodayWireRow[]>("/api/medications/intake?scope=today"),
    enabled,
    staleTime: 60_000,
  });
  return useMemo<TodayDose[]>(
    () =>
      (Array.isArray(data) ? data : [])
        .filter((row) => row.medicationId === medicationId)
        .map((row) => ({
          key: row.id,
          slotAt: row.slotInstant,
          takenAt: row.takenAt,
          state: toDoseState(row),
        }))
        .sort((a, b) =>
          (a.slotAt ?? a.takenAt ?? "").localeCompare(
            b.slotAt ?? b.takenAt ?? "",
          ),
        ),
    [data, medicationId],
  );
}

/** The card's one sentence, from the server's states. */
function useTodaySentence({
  medication,
  recordOnly,
  asNeeded,
  slots,
  extras,
}: {
  medication: MedicationDetailSnapshot;
  recordOnly: boolean;
  asNeeded: boolean;
  slots: TodayDose[];
  extras: TodayDose[];
}): string | null {
  const { t } = useTranslations();
  if (!medication.active) return t("medications.detail.uebersicht.pausedHint");
  if (recordOnly) return t("medications.detail.uebersicht.nextDoseNotTracked");
  if (asNeeded) {
    return extras.length > 0
      ? t("medications.detail.overview.today.asNeededTaken", {
          count: extras.length,
        })
      : t("medications.detail.uebersicht.nextDoseAsNeeded");
  }
  // With today's doses listed, each row already says its time and its
  // state ("20:00 Due"), and the chip says how many are done: a sentence
  // would read them back. It speaks only when there is no row to read.
  if (slots.length > 0) return null;
  return t("medications.detail.overview.today.noneToday");
}

export function TodayCard({
  medication,
  recordOnly,
  asNeeded,
  courseStatus,
  compliance,
  todayDoses,
  onBackfill,
  onHistory,
}: {
  medication: MedicationDetailSnapshot;
  recordOnly: boolean;
  asNeeded: boolean;
  courseStatus?: "UPCOMING" | "CURRENT" | "ENDED";
  compliance: OverviewCompliance | null | undefined;
  todayDoses: TodayDose[];
  onBackfill: () => void;
  onHistory?: () => void;
}) {
  const { t } = useTranslations();
  const tz = useDisplayTimezone();
  const canAct =
    medication.active &&
    !recordOnly &&
    courseStatus !== "ENDED" &&
    courseStatus !== "UPCOMING";
  const now = new Date();
  const currentDose = compliance?.complianceDisplay?.currentDose ?? null;

  const slots = todayDoses.filter((dose) => dose.slotAt !== null);
  const extras = todayDoses.filter(
    (dose) => dose.slotAt === null && dose.takenAt,
  );
  const taken = slots.filter(
    (dose) => dose.state === "taken" || dose.state === "taken_late",
  ).length;
  const sentence = useTodaySentence({
    medication,
    recordOnly,
    asNeeded,
    slots,
    extras,
  });
  const nextDueAt = medication.nextDueAt ?? null;
  const showNext =
    canAct &&
    !asNeeded &&
    !!nextDueAt &&
    userDayKey(new Date(nextDueAt), tz) !== userDayKey(now, tz);

  return (
    <OverviewCard
      icon={Pill}
      title={t("medications.today")}
      chip={
        !asNeeded && slots.length > 0
          ? t("medications.detail.overview.today.progress", {
              taken,
              total: slots.length,
            })
          : undefined
      }
      sentence={sentence}
      slot="medication-overview-today"
      actions={
        <TodayActions
          medication={medication}
          recordOnly={recordOnly}
          asNeeded={asNeeded}
          canAct={canAct}
          takeSlot={cardTakeSlot(currentDose, medication.nextDueAt, now)}
          onBackfill={onBackfill}
          onHistory={onHistory}
        />
      }
    >
      <TodayRows
        slots={slots}
        extras={extras}
        nextDueAt={showNext ? nextDueAt : null}
      />
    </OverviewCard>
  );
}

/** Today's doses, any off-schedule takes, and the next dose after today. */
function TodayRows({
  slots,
  extras,
  nextDueAt,
}: {
  slots: TodayDose[];
  extras: TodayDose[];
  nextDueAt: string | null;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const nextDoseText = useNextDoseText();
  if (slots.length === 0 && extras.length === 0 && !nextDueAt) return null;
  const row = "flex min-h-10 items-center justify-between gap-3 py-2";
  return (
    <ul
      className="divide-border/60 divide-y text-sm"
      data-slot="medication-overview-today-rows"
    >
      {slots.map((dose) => (
        <li
          key={dose.key}
          className={row}
          data-slot="medication-overview-today-row"
          data-state={dose.state ?? undefined}
        >
          <span className="text-muted-foreground tabular-nums">
            {fmt.time(dose.slotAt!)}
          </span>
          <span className="flex items-center gap-1.5">
            {dose.state && (
              <DoseStateLabel state={dose.state} className="text-sm" />
            )}
            {(dose.state === "taken" || dose.state === "taken_late") &&
              dose.takenAt && (
                <span className="text-foreground tabular-nums">
                  {fmt.time(dose.takenAt)}
                </span>
              )}
          </span>
        </li>
      ))}
      {extras.map((dose) => (
        <li
          key={dose.key}
          className={row}
          data-slot="medication-overview-today-row"
          data-state="extra"
        >
          <span className="text-muted-foreground">
            {t("medications.detail.verlauf.extraColumn")}
          </span>
          <span className="text-foreground tabular-nums">
            {fmt.time(dose.takenAt!)}
          </span>
        </li>
      ))}
      {nextDueAt && (
        <li className={row} data-slot="medication-overview-next-dose">
          <span className="text-muted-foreground">
            {t("medications.detail.uebersicht.nextDoseLabel")}
          </span>
          <span className="text-foreground">{nextDoseText(nextDueAt)}</span>
        </li>
      )}
    </ul>
  );
}

/**
 * The card's foot: the early / extra hint and the snooze above the pair,
 * then Skip / Take (Log past dose / Take as needed). A dose that cannot be
 * taken now (paused, ended, record only) offers Log past dose / History.
 */
function TodayActions({
  medication,
  recordOnly,
  asNeeded,
  canAct,
  takeSlot,
  onBackfill,
  onHistory,
}: {
  medication: MedicationDetailSnapshot;
  recordOnly: boolean;
  asNeeded: boolean;
  canAct: boolean;
  takeSlot: TakeSlot | null;
  onBackfill: () => void;
  onHistory?: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { canWriteDomain } = useRecordCapabilities();
  const { intakeLoading, recordIntake } = useMedicationIntake({ medication });
  const snooze = useCardDoseSnooze({
    ...medication,
    trackIntake: !recordOnly,
    intakeActionable: canAct,
  });
  if (!canWriteDomain("medications")) return null;

  const backfill = (
    <Button
      variant="outline"

      onClick={onBackfill}
      data-slot="medication-overview-backfill"
    >
      {t("medications.detail.verlauf.backfill")}
    </Button>
  );
  if (!canAct) {
    return (
      <ActionPair>
        {backfill}
        {onHistory ? (
          <Button
            variant="outline"

            onClick={onHistory}
            data-slot="medication-overview-history"
          >
            {t("medications.detail.tabs.verlauf")}
          </Button>
        ) : null}
      </ActionPair>
    );
  }

  const extra = takeSlot?.binding === "extra";
  return (
    <div className="space-y-2">
      {takeSlot && extra ? (
        <p
          className="text-muted-foreground text-xs"
          data-slot="medication-intake-extra"
        >
          {t("medications.dose.extraHint", { time: fmt.time(takeSlot.at) })}
        </p>
      ) : takeSlot?.earlyFrom ? (
        <p
          className="text-muted-foreground text-xs"
          data-slot="medication-intake-early"
        >
          {t("medications.dose.earlyHint", {
            time: fmt.time(takeSlot.earlyFrom),
          })}
        </p>
      ) : null}
      {snooze?.snoozedUntil ? (
        <p
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          data-slot="medication-snoozed"
        >
          <BellRing className="size-3.5 shrink-0" aria-hidden="true" />
          {t("medications.dose.state.snoozedUntil", {
            time: fmt.time(snooze.snoozedUntil),
          })}
        </p>
      ) : snooze?.canSnooze ? (
        <InlineAction
          tone="muted"
          size="xs"
          onClick={snooze.snooze}
          disabled={snooze.busy || !!intakeLoading}
          data-slot="medication-intake-snooze"
        >
          <BellRing className="size-3.5" aria-hidden="true" />
          {t(DOSE_ACTION_TERM.snooze, { minutes: snooze.minutes })}
        </InlineAction>
      ) : null}
      <ActionPair>
        {asNeeded ? (
          backfill
        ) : (
          <Button
            variant="outline"

            onClick={() => void recordIntake(true, takeSlot)}
            disabled={!!intakeLoading}
            aria-busy={intakeLoading === "skip" || undefined}
            data-slot="medication-intake-skip"
          >
            {t(DOSE_ACTION_TERM.skip)}
          </Button>
        )}
        {
          <Button
            onClick={() => void recordIntake(false, takeSlot)}
            disabled={!!intakeLoading}
            aria-busy={intakeLoading === "take" || undefined}
            data-slot="medication-intake-take"
          >
            {extra
              ? t("medications.dose.action.takeExtra")
              : t(DOSE_ACTION_TERM.take)}
          </Button>
        }
      </ActionPair>
    </div>
  );
}
