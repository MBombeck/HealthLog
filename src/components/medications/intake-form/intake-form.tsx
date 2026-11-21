"use client";

/**
 * The one intake form. The medications page's "Log an intake", the dose
 * history's "+ Entry" and the capture sheet's "Medication" used to be three
 * forms with three field sets: one had a slot picker and a skip switch but no
 * note of where the dose would count, one had no dose field and asked about
 * the slot after saving, one could not skip. All three now render these
 * fields, in this order, with these labels:
 *
 *   Medication (when the form is not opened from one) · Taken / Skipped ·
 *   Time · Dose · where it counts ("Counts for the 08:00 dose").
 *
 * The caller owns the frame (sheet, footer) and the submit button; the state
 * and the write live here.
 */

import { useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateTimeField } from "@/components/ui/date-time-field";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { MedicationNote } from "@/components/medications/medication-note";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { formatDose } from "@/lib/medications/format-dose";
import { DOSE_STATE_TERM } from "@/lib/medications/dose-state/terms";
import {
  attributeIntake,
  slotFieldsOf,
  type SlotAttribution,
} from "./slot-attribution";
import { useIntakeDaySlots, type DaySlotsStatus } from "./use-intake-day-slots";

/**
 * A schedule as the form reads it: only to find the dose a slot names. Which
 * slots a day has comes from the server's ledger (`useIntakeDaySlots`).
 */
export interface IntakeFormSchedule {
  timesOfDay?: string[] | null;
  windowStart?: string | null;
  dose?: string | null;
}

export interface IntakeFormMedication {
  id: string;
  name: string;
  dose: string;
  note?: string | null;
  schedules: IntakeFormSchedule[];
}

/** `YYYY-MM-DDTHH:mm` in the browser's local time, the date-time field's value. */
export function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export type IntakeOutcome = "taken" | "skipped";

/** The form's state for one medication (picked or fixed). */
export function useIntakeFormState({
  medication,
  initialTakenAt,
}: {
  medication: IntakeFormMedication | undefined;
  initialTakenAt?: string;
}) {
  const [takenAt, setTakenAt] = useState(
    () => initialTakenAt ?? toDateTimeLocal(new Date()),
  );
  const [outcome, setOutcome] = useState<IntakeOutcome>("taken");
  const [doseOverride, setDoseOverride] = useState<string | null>(null);
  const [countNear, setCountNear] = useState(true);

  const { status: slotsStatus, slots } = useIntakeDaySlots({
    medicationId: medication?.id,
    takenAtLocal: takenAt,
  });
  // A skip names the slot it skips; a day without an open slot (or one not
  // read yet) has nothing to skip, so the outcome reads taken there.
  const canSkip = slots.length > 0;
  const effectiveOutcome: IntakeOutcome =
    outcome === "skipped" && canSkip ? "skipped" : "taken";
  const skipped = effectiveOutcome === "skipped";
  const attribution = useMemo(
    () => attributeIntake({ takenAtLocal: takenAt, slots, skipped, countNear }),
    [takenAt, slots, skipped, countNear],
  );
  // The configured dose: the dose of the schedule the take counts for, when
  // it names one (titration schedules differ per slot), else the medication's.
  const configuredDose = useMemo(() => {
    if (!medication) return "";
    const slotHm =
      attribution.kind === "slot" || attribution.kind === "late"
        ? attribution.slot.slotHm
        : null;
    if (slotHm) {
      const schedule = medication.schedules.find((s) =>
        s.timesOfDay && s.timesOfDay.length > 0
          ? s.timesOfDay.includes(slotHm)
          : s.windowStart === slotHm,
      );
      if (schedule?.dose) return schedule.dose;
    }
    return medication.dose ?? "";
  }, [medication, attribution]);
  const dose = doseOverride ?? configuredDose;

  return {
    takenAt,
    setTakenAt,
    outcome: effectiveOutcome,
    setOutcome,
    canSkip,
    slotsStatus,
    dose,
    setDose: setDoseOverride,
    configuredDose,
    countNear,
    setCountNear,
    attribution,
    /** A medication switch starts its dose over. */
    resetForMedication: () => setDoseOverride(null),
  };
}

export type IntakeFormState = ReturnType<typeof useIntakeFormState>;

/** The POST body fields the form adds to `skipped` (time, slot, dose). */
export function intakeWriteOf(form: IntakeFormState): {
  skipped: boolean;
  takenAt: string;
  scheduledFor?: string;
  forceSlotInstant?: string;
  doseTaken?: string;
} {
  const skipped = form.outcome === "skipped";
  const trimmed = form.dose.trim();
  const deviates =
    !skipped && trimmed.length > 0 && trimmed !== form.configuredDose.trim();
  return {
    skipped,
    takenAt: new Date(form.takenAt).toISOString(),
    ...slotFieldsOf(form.attribution),
    ...(deviates ? { doseTaken: trimmed } : {}),
  };
}

/** The attribution in words, under the fields. */
function AttributionLine({
  attribution,
  slotsStatus,
  countNear,
  onCountNear,
  idPrefix,
}: {
  attribution: SlotAttribution;
  slotsStatus: DaySlotsStatus;
  countNear: boolean;
  onCountNear: (next: boolean) => void;
  idPrefix: string;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const nearSlot =
    attribution.kind === "late"
      ? attribution.slot
      : attribution.kind === "extra"
        ? attribution.nearSlot
        : null;
  const text =
    slotsStatus === "loading"
      ? t("medications.intakeForm.scheduleLoading")
      : slotsStatus === "error" && attribution.kind === "extra"
        ? t("medications.intakeForm.scheduleUnavailable")
        : attribution.kind === "slot"
          ? t("medications.intakeForm.countsFor", {
              time: fmt.wallTime(attribution.slot.slotHm),
            })
          : attribution.kind === "late"
            ? t("medications.intakeForm.countsForLate", {
                time: fmt.wallTime(attribution.slot.slotHm),
              })
            : attribution.kind === "skip"
              ? t("medications.intakeForm.skips", {
                  time: fmt.wallTime(attribution.slot.slotHm),
                })
              : attribution.kind === "extra"
                ? t("medications.intakeForm.extraDose")
                : null;
  return (
    <div className="space-y-2" data-slot="intake-form-attribution">
      {nearSlot && (
        <label
          htmlFor={`${idPrefix}-count-near`}
          className="flex min-h-11 items-center justify-between gap-3"
        >
          <span className="text-sm font-medium">
            {t("medications.intakeForm.countNearLabel", {
              time: fmt.wallTime(nearSlot.slotHm),
            })}
          </span>
          <Switch
            id={`${idPrefix}-count-near`}
            checked={countNear}
            onCheckedChange={onCountNear}
            data-slot="intake-form-count-near"
          />
        </label>
      )}
      {text && (
        <p
          className="text-muted-foreground text-xs"
          data-slot="intake-form-counts-for"
          data-kind={slotsStatus === "loading" ? "pending" : attribution.kind}
          data-slots={slotsStatus}
        >
          {text}
        </p>
      )}
    </div>
  );
}

/**
 * The fields. `medications` + `onMedicationChange` render the picker; omit
 * them for a form opened from one medication.
 */
export function IntakeFormFields({
  form,
  medication,
  medications,
  onMedicationChange,
  idPrefix,
  testIdPrefix,
  maxTakenAt,
  error = null,
}: {
  form: IntakeFormState;
  medication: IntakeFormMedication | undefined;
  medications?: readonly IntakeFormMedication[];
  onMedicationChange?: (id: string) => void;
  idPrefix: string;
  /** Prefix of the fields' `data-testid`s, for a caller's own e2e hooks. */
  testIdPrefix?: string;
  /** Latest selectable time (defaults to now; a dose is not logged ahead). */
  maxTakenAt?: string;
  /** The failed save's message, shown as the form's inline alert. */
  error?: string | null;
}) {
  const { t } = useTranslations();
  const skipped = form.outcome === "skipped";
  // A day without an open slot has no dose to skip.
  const canSkip = form.canSkip;

  return (
    <div className="space-y-4" data-slot="intake-form">
      {medications && onMedicationChange && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-medication`}>
            {t("medications.intakeForm.medicationLabel")}
          </Label>
          <NativeSelect
            id={`${idPrefix}-medication`}
            data-slot="intake-form-medication"
            data-testid={
              testIdPrefix ? `${testIdPrefix}-medication` : undefined
            }
            value={medication?.id ?? ""}
            onChange={(e) => {
              onMedicationChange(e.target.value);
              form.resetForMedication();
            }}
          >
            {medications.map((m) => (
              <option key={m.id} value={m.id}>
                {m.dose ? `${m.name} ${formatDose(m.dose, t)}` : m.name}
              </option>
            ))}
          </NativeSelect>
          <MedicationNote note={medication?.note} slot="intake-form-note" />
        </div>
      )}

      {canSkip && (
        <Segmented
          label={t("medications.intakeForm.outcomeLabel")}
          mode="toggle"
          stretch
          slot="intake-form-outcome"
          options={[
            { value: "taken", label: t(DOSE_STATE_TERM.taken) },
            { value: "skipped", label: t(DOSE_STATE_TERM.skipped) },
          ]}
          value={form.outcome}
          onChange={(next) => form.setOutcome(next)}
        />
      )}

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-taken-at`}>
          {t("medications.intakeForm.timeLabel")}
        </Label>
        <DateTimeField
          id={`${idPrefix}-taken-at`}
          data-testid={testIdPrefix ? `${testIdPrefix}-taken-at` : undefined}
          value={form.takenAt}
          max={maxTakenAt ?? toDateTimeLocal(new Date())}
          onChange={(value) => form.setTakenAt(value)}
          required
        />
      </div>

      {!skipped && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-dose`}>
            {t("medications.intakeForm.doseLabel")}
          </Label>
          <Input
            id={`${idPrefix}-dose`}
            data-slot="intake-form-dose"
            data-testid={testIdPrefix ? `${testIdPrefix}-dose` : undefined}
            value={form.dose}
            // The configured dose the field starts on: the sheet's dirty
            // check reads it to tell an untouched dose from a typed one.
            data-seed={form.configuredDose}
            maxLength={50}
            onChange={(e) => form.setDose(e.target.value)}
            placeholder={form.configuredDose}
            autoComplete="off"
          />
          <p className="text-muted-foreground text-xs">
            {t("medications.intakeForm.doseHint")}
          </p>
        </div>
      )}

      <AttributionLine
        attribution={form.attribution}
        slotsStatus={form.slotsStatus}
        countNear={form.countNear}
        onCountNear={form.setCountNear}
        idPrefix={idPrefix}
      />

      {error && (
        <p
          role="alert"
          className="text-destructive text-sm"
          data-slot="intake-form-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
