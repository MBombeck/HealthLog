"use client";

/**
 * Quick-entry sheets for the dashboard: measurement, mood, medication
 * intake, and water behind the shared ResponsiveSheet primitive
 * (bottom-sheet on `<md`, centred Dialog on `md+`), plus the
 * confirm-before-discard guard for dirty forms.
 *
 * Extracted from the dashboard page; the page keeps the open-state and
 * the quick-add menu that triggers each sheet.
 */
import { useState } from "react";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { MoodForm } from "@/components/mood/mood-form";
import { MedicationIntakeQuickAdd } from "@/components/dashboard/medication-intake-quick-add";
import { WaterQuickAddSheet } from "@/components/insights/nutrients/water-quick-add-sheet";
import { useTranslations } from "@/lib/i18n/context";

export type QuickEntryDialog =
  "measurement" | "mood" | "medicationIntake" | "water" | null;

/**
 * v1.11.3 F3 — guard the quick-entry sheets against an accidental
 * dismiss (overlay tap, Esc, mobile swipe-down) discarding a partly
 * filled form. The forms live behind a stable `ResponsiveSheet` body
 * slot and don't expose their dirty state, so we read it from the DOM
 * at dismiss time: any visible text/number input or textarea that
 * carries a value, or any checked checkbox/radio that isn't a default,
 * counts as unsaved input. Date/time pickers are excluded — the forms
 * prefill them with the current timestamp on mount, so a pristine sheet
 * would otherwise always read as dirty. Cheap, synchronous, and runs
 * only on the one mounted sheet body.
 */
const PREFILLED_PICKER_TYPES = new Set([
  "date",
  "datetime-local",
  "time",
  "month",
  "week",
]);
export function sheetBodyHasUnsavedInput(): boolean {
  if (typeof document === "undefined") return false;
  const body = document.querySelector<HTMLElement>(
    '[data-slot="responsive-sheet-body"]',
  );
  if (!body) return false;
  const fields = body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  );
  for (const field of fields) {
    if (field.disabled || field.type === "hidden") continue;
    // Skip pickers the form prefills with "now" — an untouched default
    // is not user input (v1.11.3 QA H1).
    if (PREFILLED_PICKER_TYPES.has(field.type)) continue;
    if (field.type === "checkbox" || field.type === "radio") {
      const box = field as HTMLInputElement;
      if (box.checked !== box.defaultChecked) return true;
      continue;
    }
    if (field.value.trim() !== "") return true;
  }
  // v1.11.5 — the input/textarea walk misses two non-text controls a user can
  // change before dismissing: the mood `role="radio"` selector and a Radix
  // Select (measurement type / medication). Losing either silently on a
  // backdrop-dismiss is the same data-loss class the H1 confirm-on-dirty guard
  // was meant to close.
  //
  // Mood radios start with nothing selected (`mood = ""`), so ANY
  // `aria-checked="true"` is a deliberate user choice — flag it.
  if (body.querySelector('[role="radio"][aria-checked="true"]') !== null) {
    return true;
  }
  // Radix Select trigger renders `role="combobox"`. A trigger with
  // `data-state="open"` is mid-interaction (the dropdown is up) — the user is
  // actively choosing, so a dismiss should confirm rather than drop the pick.
  // We deliberately do NOT treat a merely non-placeholder value as dirty: the
  // type / medication selects mount with a non-placeholder DEFAULT, and
  // flagging that would over-trigger the confirm on a pristine sheet.
  if (body.querySelector('[role="combobox"][data-state="open"]') !== null) {
    return true;
  }
  return false;
}

export function QuickEntrySheets({
  open,
  onClose,
}: {
  open: QuickEntryDialog;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  // v1.4.27 R4 RC2 — DOM handles for the form action-row portal target
  // on each quick-entry sheet. The Sheet branch sticky-pins this slot.
  const [measurementFooterEl, setMeasurementFooterEl] =
    useState<HTMLDivElement | null>(null);
  const [moodFooterEl, setMoodFooterEl] = useState<HTMLDivElement | null>(null);
  // v1.4.37 W7b — medication-intake quick-add lives on the same Sheet
  // primitive as the other two quick-entries; the form's action row is
  // portalled into this slot so Save / Cancel stay reachable above the
  // mobile soft keyboard.
  const [medicationIntakeFooterEl, setMedicationIntakeFooterEl] =
    useState<HTMLDivElement | null>(null);
  // v1.11.3 F3 — when an open quick-entry sheet is dismissed with
  // unsaved input, hold the close in this flag and surface a confirm
  // instead of nulling the dialog outright. Cleared once the user
  // confirms (close) or keeps editing (dismiss the confirm).
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  // Intercept a sheet dismiss: close immediately when the form is
  // clean, otherwise keep the sheet open and ask before discarding.
  function handleQuickEntryOpenChange(nextOpen: boolean) {
    if (nextOpen) return;
    if (sheetBodyHasUnsavedInput()) {
      setConfirmDiscardOpen(true);
      return;
    }
    onClose();
  }

  return (
    <>
      <ResponsiveSheet
        open={open === "measurement"}
        onOpenChange={handleQuickEntryOpenChange}
        title={t("measurements.addMeasurement")}
        footer={<div ref={setMeasurementFooterEl} className="flex w-full" />}
      >
        <MeasurementForm
          onSuccess={onClose}
          onCancel={onClose}
          footerSlot={measurementFooterEl}
        />
      </ResponsiveSheet>
      <ResponsiveSheet
        open={open === "mood"}
        onOpenChange={handleQuickEntryOpenChange}
        title={t("mood.addEntry")}
        footer={<div ref={setMoodFooterEl} className="flex w-full" />}
      >
        <MoodForm
          onSuccess={onClose}
          onCancel={onClose}
          footerSlot={moodFooterEl}
        />
      </ResponsiveSheet>
      {/* v1.4.37 W7b — third Sheet: medication intake. Same
          ResponsiveSheet contract as the two above; the form's footer
          (Cancel + Save) portals into the sticky-pinned slot so it
          stays reachable above the soft keyboard on mobile. */}
      <ResponsiveSheet
        open={open === "medicationIntake"}
        onOpenChange={handleQuickEntryOpenChange}
        title={t("dashboard.medicationIntakeQuickAdd.sheetTitle")}
        description={t("dashboard.medicationIntakeQuickAdd.sheetDescription")}
        footer={
          <div ref={setMedicationIntakeFooterEl} className="flex w-full" />
        }
      >
        <MedicationIntakeQuickAdd
          onSuccess={onClose}
          onCancel={onClose}
          footerSlot={medicationIntakeFooterEl}
        />
      </ResponsiveSheet>
      <WaterQuickAddSheet
        open={open === "water"}
        onOpenChange={handleQuickEntryOpenChange}
        onSuccess={onClose}
      />

      {/* v1.11.3 F3 — confirm before discarding a partly-filled
          quick-entry form when the sheet is dismissed by an overlay
          tap, Escape, or a mobile swipe-down. Keeps the sheet open
          until the user decides. */}
      <AlertDialog
        open={confirmDiscardOpen}
        onOpenChange={setConfirmDiscardOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("dashboard.quickEntryDiscard.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("dashboard.quickEntryDiscard.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("dashboard.quickEntryDiscard.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDiscardOpen(false);
                onClose();
              }}
            >
              {t("dashboard.quickEntryDiscard.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
