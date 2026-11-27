"use client";

/**
 * v1.5.5 D-3 §9.7 — Settings rows.
 *
 * v1.7.0 — the monolithic "Settings" card is decomposed into reusable
 * rows so each can slot under the right group: API tokens → Data, Grace →
 * Reminders, Phasen → Lifecycle.
 *
 * v1.15.18 — the standalone `<SettingsSection>` wrapper is retired with
 * the modal advanced-settings sheet; the detail page's tabs consume the
 * individual rows (`GraceRow` / `DrugCodingRow` / `PhasesRow`) directly.
 *
 * v1.15.20 — the Grace row writes the SAME value onto every schedule of
 * a multi-schedule medication (full `schedules` round-trip, the same
 * wholesale-replace contract the Zeitplan times editor uses) instead of
 * silently touching only the primary schedule. A helper line states the
 * all-schedules scope when more than one schedule exists.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhaseConfigSheet } from "@/components/medications/sections/phase-config-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";
import { apiPut } from "@/lib/api/api-fetch";
import type { DoseWindowEntry } from "@/components/medications/scheduling/dose-window";

/** The schedule fields the grace save round-trips on a wholesale PUT. */
export interface GraceScheduleSnapshot {
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  timesOfDay?: string[];
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  reminderGraceMinutes?: number | null;
  scheduleType?: string | null;
  cyclicOnWeeks?: number | null;
  cyclicOffWeeks?: number | null;
  doseWindows?: DoseWindowEntry[] | null;
}

/**
 * v1.7.0 — reminder-window (grace) row. Self-saves via
 * `PUT /api/medications/[id]`.
 *
 * v1.15.20 — a single-schedule medication keeps the cheap top-level
 * `reminderGraceMinutes` write (the server applies it to the primary
 * schedule). A multi-schedule medication round-trips the FULL schedules
 * array with the same grace on every schedule — every field is preserved
 * verbatim from the snapshot, only `reminderGraceMinutes` changes — so
 * the value can no longer drift apart per schedule.
 *
 * The row saves on choice, like the switches beside it in the reminder
 * card: one way to save there, no mid-card Save button. A preset list keeps
 * a half-typed number from being written; a stored value off the presets
 * stays offered as it is.
 */
const GRACE_PRESETS = [15, 30, 45, 60, 90, 120, 180, 240];

/** The presets, plus a stored value off them, ascending. */
export function graceOptions(current: number): number[] {
  return [...new Set([...GRACE_PRESETS, current])].sort((a, b) => a - b);
}

export function GraceRow({
  medicationId,
  schedules,
  compact = false,
}: {
  medicationId: string;
  schedules: GraceScheduleSnapshot[];
  /** One line: the name left, the choice right, no helper. */
  compact?: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const firstGrace = schedules[0]?.reminderGraceMinutes;
  const [graceValue, setGraceValue] = useState(
    typeof firstGrace === "number" ? firstGrace : 30,
  );
  const [graceBusy, setGraceBusy] = useState(false);

  const multiSchedule = schedules.length > 1;

  const options = graceOptions(graceValue);

  async function saveGrace(next: number) {
    if (graceBusy || next === graceValue) return;
    const previous = graceValue;
    setGraceValue(next);
    setGraceBusy(true);
    try {
      const body = multiSchedule
        ? {
            // Wholesale schedules replace (the PUT contract): preserve
            // every cadence field from the snapshot, set the SAME grace
            // on every schedule.
            schedules: schedules.map((s) => {
              const recurrence = parseScheduleRecurrence(s.daysOfWeek);
              return {
                windowStart: s.windowStart,
                windowEnd: s.windowEnd,
                label: s.label ?? undefined,
                dose: s.dose ?? undefined,
                timesOfDay:
                  s.timesOfDay && s.timesOfDay.length > 0
                    ? s.timesOfDay
                    : [s.windowStart],
                daysOfWeek: recurrence.daysOfWeek,
                intervalWeeks: recurrence.intervalWeeks,
                ...(s.rrule ? { rrule: s.rrule } : {}),
                ...(typeof s.rollingIntervalDays === "number"
                  ? { rollingIntervalDays: s.rollingIntervalDays }
                  : {}),
                reminderGraceMinutes: next,
                ...(s.scheduleType
                  ? {
                      scheduleType: s.scheduleType as
                        "SCHEDULED" | "PRN" | "CYCLIC",
                    }
                  : {}),
                ...(typeof s.cyclicOnWeeks === "number"
                  ? { cyclicOnWeeks: s.cyclicOnWeeks }
                  : {}),
                ...(typeof s.cyclicOffWeeks === "number"
                  ? { cyclicOffWeeks: s.cyclicOffWeeks }
                  : {}),
                ...(s.doseWindows ? { doseWindows: s.doseWindows } : {}),
              };
            }),
          }
        : { reminderGraceMinutes: next };
      await apiPut(`/api/medications/${medicationId}`, body);
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.settings.grace.saved"));
    } catch (failure) {
      setGraceValue(previous);
      showErrorToast(t("medications.detail.settings.grace.failed"), {
        cause: failure,
      });
    } finally {
      setGraceBusy(false);
    }
  }

  const select = (
    <Select
      value={String(graceValue)}
      onValueChange={(v) => void saveGrace(Number(v))}
      disabled={graceBusy}
    >
      <SelectTrigger
        id="medication-detail-grace-input"
        className={
          compact
            ? "min-h-11 w-36 shrink-0 sm:min-h-9"
            : "min-h-11 w-40 sm:min-h-9"
        }
        aria-busy={graceBusy || undefined}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((minutes) => (
          <SelectItem key={minutes} value={String(minutes)}>
            {fmt.integer(minutes)} {t("medications.detail.settings.grace.unit")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (compact) {
    return (
      <div
        className="flex items-center justify-between gap-3"
        data-slot="medication-detail-grace-row"
      >
        <Label
          htmlFor="medication-detail-grace-input"
          className="text-foreground text-sm font-medium"
          noColon
        >
          {t("medications.detail.settings.grace.label")}
        </Label>
        {select}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-slot="medication-detail-grace-row">
      <Label
        htmlFor="medication-detail-grace-input"
        className="text-foreground text-sm font-medium"
      >
        {t("medications.detail.settings.grace.label")}
      </Label>
      <p className="text-muted-foreground text-xs">
        {t("medications.detail.settings.grace.description")}
      </p>
      {multiSchedule && (
        <p className="text-muted-foreground text-xs">
          {t("medications.detail.settings.grace.appliesToAllNote")}
        </p>
      )}
      {select}
    </div>
  );
}

/**
 * v1.9.0 — optional drug-classification codes (ATC / RxNorm) row.
 * Self-saves via `PUT /api/medications/[id]` with the two top-level
 * `atcCode` / `rxNormCode` fields. The codes are user/clinician-asserted
 * and surface on the FHIR health-record export's
 * `medicationCodeableConcept` (ATC primary, RxNorm secondary); the app
 * never machine-guesses a code. An empty input clears the stored code.
 */
export function DrugCodingRow({
  medicationId,
  atcCode,
  rxNormCode,
}: {
  medicationId: string;
  atcCode?: string | null;
  rxNormCode?: string | null;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [atcValue, setAtcValue] = useState(atcCode ?? "");
  const [rxValue, setRxValue] = useState(rxNormCode ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      // Empty input clears the column (null); a non-empty value is sent
      // verbatim for the server to validate (422 on a malformed code).
      await apiPut(`/api/medications/${medicationId}`, {
        atcCode: atcValue.trim() === "" ? null : atcValue.trim(),
        rxNormCode: rxValue.trim() === "" ? null : rxValue.trim(),
      });
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.settings.codes.saved"));
    } catch (failure) {
      showErrorToast(t("medications.detail.settings.codes.failed"), {
        cause: failure,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-slot="medication-detail-drug-coding-row">
      <Label className="text-foreground text-sm font-medium">
        {t("medications.detail.settings.codes.label")}
      </Label>
      <p className="text-muted-foreground text-xs">
        {t("medications.detail.settings.codes.note")}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label
            htmlFor="medication-detail-atc-input"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.settings.codes.atcLabel")}
          </Label>
          <Input
            id="medication-detail-atc-input"
            value={atcValue}
            onChange={(e) => setAtcValue(e.target.value.toUpperCase())}
            placeholder="A10BX10"
            className="w-32"
          />
        </div>
        <div className="space-y-1">
          <Label
            htmlFor="medication-detail-rxnorm-input"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.settings.codes.rxNormLabel")}
          </Label>
          <Input
            id="medication-detail-rxnorm-input"
            inputMode="numeric"
            value={rxValue}
            onChange={(e) => setRxValue(e.target.value)}
            placeholder="2601723"
            className="w-32"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void save()}
          disabled={busy}
          aria-busy={busy || undefined}
          className="min-h-11 sm:min-h-9"
        >
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The reminder phases row: when the reminders for a dose come and when the
 * dose counts as missed. Every scheduled medication has phases (the reminder
 * worker reads them for all of them); the row used to be GLP-1 only, and
 * then only once a course window was set. When `onRequestPhaseSheet` is
 * provided the parent orchestrates the sheet; otherwise the row mounts it.
 */
export function PhasesRow({
  medicationId,
  onRequestPhaseSheet,
}: {
  medicationId: string;
  onRequestPhaseSheet?: () => void;
}) {
  const { t } = useTranslations();
  const [phaseSheetOpen, setPhaseSheetOpen] = useState(false);

  return (
    <>
      <div
        className="flex items-start justify-between gap-3"
        data-slot="medication-detail-phase-management-row"
      >
        <div className="min-w-0 space-y-1">
          <p className="text-foreground text-sm font-medium">
            {t("medications.phaseConfig")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("medications.phaseConfigDescription")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onRequestPhaseSheet
              ? onRequestPhaseSheet()
              : setPhaseSheetOpen(true)
          }
          className="min-h-11 shrink-0 sm:min-h-9"
          data-slot="medication-detail-phase-management-button"
        >
          {t("medications.detail.settings.phases.openButton")}
        </Button>
      </div>

      {!onRequestPhaseSheet && (
        <PhaseConfigSheet
          medicationId={medicationId}
          open={phaseSheetOpen}
          onOpenChange={setPhaseSheetOpen}
        />
      )}
    </>
  );
}
