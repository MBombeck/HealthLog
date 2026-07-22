"use client";

/**
 * v1.14.0 — manual intake logger reachable from the medications-page
 * "Add" choice. The top-of-page Add button now offers two paths: create a
 * new medication (the existing wizard) or LOG AN INTAKE against an existing
 * medication — including a backdated one.
 *
 * The form picks a medication, optionally pins a schedule slot, and a
 * date+time that defaults to "now" but accepts any past instant. It submits
 * to the existing `POST /api/medications/{id}/intake` route: `takenAt`
 * carries the (possibly backdated) instant, and a chosen slot supplies
 * `scheduledFor` so the write routes through the server's canonical slot
 * upsert — the same snap/upsert path a normal "Taken" tap uses — keeping
 * the one-row-per-dose-slot invariant intact. No new endpoint is minted.
 *
 * The submit orchestration lives in the pure, injection-tested
 * `runLogIntake` (see `use-medication-intake.ts`); this component owns only
 * the form state + the medication/slot pickers.
 */

import { useId, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { DateTimeField } from "@/components/ui/date-time-field";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import {
  resolveMedicationSelectionId,
  type DefaultMedicationOption,
} from "@/lib/medications/default-medication";
import type { ScheduleWindowInput } from "@/lib/medications/window-status";
import { formatDose } from "@/lib/medications/format-dose";
import {
  runLogIntake,
  runUndoIntake,
} from "@/components/medications/use-medication-intake";

interface LogIntakeSchedule extends ScheduleWindowInput {
  label: string | null;
  dose: string | null;
}

export interface LogIntakeMedication extends DefaultMedicationOption {
  dose: string;
  schedules: LogIntakeSchedule[];
}

export interface LogIntakeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active medications the user can log against. */
  medications: LogIntakeMedication[];
}

/** Sentinel option value meaning "no specific schedule slot" (PRN). */
const NO_SLOT = "__none__";

/**
 * `<input type="datetime-local">` shape `YYYY-MM-DDTHH:mm` for the given
 * Date rendered in the user's local time. Mirrors the intake-edit dialog so
 * both date pickers read the same way.
 */
function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/**
 * Distinct HH:mm slot times for a medication, derived from each schedule's
 * first-class `timesOfDay` (falling back to `windowStart`). Sorted so the
 * morning slot leads. Empty for a medication with no time-anchored slots
 * (the PRN-only case), which simply hides the slot picker.
 */
function slotTimesFor(med: LogIntakeMedication | undefined): string[] {
  if (!med) return [];
  const times = new Set<string>();
  for (const s of med.schedules) {
    const fromTimes = s.timesOfDay && s.timesOfDay.length > 0;
    if (fromTimes) {
      for (const tod of s.timesOfDay!) times.add(tod);
    } else if (s.windowStart) {
      times.add(s.windowStart);
    }
  }
  return Array.from(times).sort((a, b) => a.localeCompare(b));
}

/**
 * Combine a `YYYY-MM-DD` date part (read off the picked `takenAt`) with an
 * `HH:mm` slot time into an ISO instant in the user's local timezone. This
 * is the slot instant on the chosen day; the server snaps it to the
 * canonical slot via the same upsert a live "Taken" tap uses.
 */
function slotInstantIso(takenAtLocal: string, slotHm: string): string | null {
  const datePart = takenAtLocal.slice(0, 10);
  if (datePart.length !== 10) return null;
  const d = new Date(`${datePart}T${slotHm}`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function LogIntakeDialog({
  open,
  onOpenChange,
  medications,
}: LogIntakeDialogProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userTz = user?.timezone || "Europe/Berlin";
  const formId = useId();

  const [medicationOverride, setMedicationOverride] = useState<string | null>(
    null,
  );
  const [selectionNow] = useState(() => new Date());
  const medicationId =
    resolveMedicationSelectionId(
      medications,
      medicationOverride,
      selectionNow,
      undefined,
      userTz,
    ) ?? "";
  const [slot, setSlot] = useState<string>(NO_SLOT);
  const [takenAt, setTakenAt] = useState<string>(() =>
    toDateTimeLocal(new Date()),
  );
  const [skipped, setSkipped] = useState(false);
  const [busy, setBusy] = useState(false);
  // v1.16.4 — per-intake dose override. `null` = untouched: the slot's
  // schedule dose (when a slot is pinned and carries one) or the
  // medication's configured dose prefills the field and nothing extra is
  // submitted. An edit that deviates travels as `doseTaken`.
  const [doseOverride, setDoseOverride] = useState<string | null>(null);

  const selected = useMemo(
    () => medications.find((m) => m.id === medicationId),
    [medications, medicationId],
  );
  const slotTimes = useMemo(() => slotTimesFor(selected), [selected]);

  // Configured baseline for the picked slot: a pinned slot prefers its
  // schedule's own dose (titration schedules differ per slot); otherwise
  // the medication's catalogue dose.
  const configuredDose = useMemo(() => {
    if (!selected) return "";
    if (slot !== NO_SLOT) {
      const scheduleForSlot = selected.schedules.find((s) =>
        s.timesOfDay && s.timesOfDay.length > 0
          ? s.timesOfDay.includes(slot)
          : s.windowStart === slot,
      );
      if (scheduleForSlot?.dose) return scheduleForSlot.dose;
    }
    return selected.dose ?? "";
  }, [selected, slot]);
  const dose = doseOverride ?? configuredDose;

  function handleMedicationChange(id: string) {
    setMedicationOverride(id);
    // Reset the slot when switching medications — the prior slot may not
    // exist on the new schedule. The dose override resets too so the new
    // medication's configured dose flows through.
    setSlot(NO_SLOT);
    setDoseOverride(null);
  }

  async function submit() {
    if (!medicationId || busy) return;
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;
    // A pinned slot must resolve to a real instant; if it can't, surface an
    // error rather than silently logging the dose through the unscheduled path
    // (which would miss the canonical slot upsert and could duplicate the row).
    let scheduledFor: string | undefined;
    if (slot !== NO_SLOT) {
      const iso = slotInstantIso(takenAt, slot);
      if (!iso) {
        toast.error(t("medications.logIntake.slotError"));
        return;
      }
      scheduledFor = iso;
    }
    setBusy(true);
    // v1.16.4 — only a deliberate deviation travels; an untouched or
    // configured-dose value keeps the row NULL (configured dose applies).
    const trimmedDose = dose.trim();
    const doseDeviates =
      !skipped &&
      trimmedDose.length > 0 &&
      trimmedDose !== configuredDose.trim();
    try {
      const ok = await runLogIntake({
        medication: { id: med.id, name: med.name },
        skipped,
        takenAt: new Date(takenAt).toISOString(),
        scheduledFor,
        ...(doseDeviates && { doseTaken: trimmedDose }),
        t,
        queryClient,
        // v1.30.1 M7 — a backdated/manual intake now gets the same
        // Undo affordance the card's take/skip path already has.
        undoIntake: (eventId) =>
          runUndoIntake({
            medication: { id: med.id, name: med.name },
            eventId,
            t,
            queryClient,
          }),
      });
      if (ok) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={t("medications.logIntake.dialogTitle")}
      description={t("medications.logIntake.dialogDescription")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("medications.logIntake.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={busy || medications.length === 0 || !medicationId}
            aria-busy={busy || undefined}
          >
            {busy && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("medications.logIntake.submit")}
          </Button>
        </>
      }
    >
      {/* v1.16.4 — a real form so Enter in the dose / datetime fields
            submits; mirrors the intake-edit and dose-history-add dialogs. */}
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || medications.length === 0 || !medicationId) return;
          void submit();
        }}
        className="space-y-4"
      >
        {medications.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">
            {t("medications.logIntake.noMedications")}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="log-intake-medication">
                {t("medications.logIntake.medicationLabel")}
              </Label>
              <NativeSelect
                id="log-intake-medication"
                value={medicationId}
                onChange={(e) => handleMedicationChange(e.target.value)}
              >
                {medications.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.dose ? `${m.name} — ${formatDose(m.dose, t)}` : m.name}
                  </option>
                ))}
              </NativeSelect>
            </div>

            {slotTimes.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="log-intake-slot">
                  {t("medications.logIntake.slotLabel")}
                </Label>
                <NativeSelect
                  id="log-intake-slot"
                  value={slot}
                  onChange={(e) => {
                    setSlot(e.target.value);
                    // The configured baseline tracks the slot's schedule
                    // dose, so an untouched field re-prefills on change.
                    setDoseOverride(null);
                  }}
                >
                  <option value={NO_SLOT}>
                    {t("medications.logIntake.slotNone")}
                  </option>
                  {slotTimes.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="log-intake-dose">
                {t("medications.logIntake.doseLabel")}
              </Label>
              <Input
                id="log-intake-dose"
                value={dose}
                maxLength={50}
                onChange={(e) => setDoseOverride(e.target.value)}
                placeholder={configuredDose}
                autoComplete="off"
                disabled={skipped}
              />
              <p className="text-muted-foreground text-xs">
                {t("medications.logIntake.doseHint")}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="log-intake-taken-at">
                {t("medications.logIntake.takenAtLabel")}
              </Label>
              <DateTimeField
                id="log-intake-taken-at"
                value={takenAt}
                max={toDateTimeLocal(new Date())}
                onChange={(value) => setTakenAt(value)}
                disabled={skipped}
              />
              <p className="text-muted-foreground text-xs">
                {t("medications.logIntake.takenAtHint")}
              </p>
            </div>

            <label
              htmlFor="log-intake-skipped"
              className="flex items-center justify-between gap-3"
            >
              <span className="text-sm font-medium">
                {t("medications.logIntake.skippedLabel")}
              </span>
              <Switch
                id="log-intake-skipped"
                checked={skipped}
                onCheckedChange={setSkipped}
              />
            </label>
          </div>
        )}
      </form>
    </ResponsiveSheet>
  );
}
