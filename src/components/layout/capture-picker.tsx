"use client";

import { useState } from "react";
import { Activity, GlassWater, Pill, Waves } from "lucide-react";

import { MeasurementForm } from "@/components/measurements/measurement-form";
import { MoodForm } from "@/components/mood/mood-form";
import { MedicationIntakeQuickAdd } from "@/components/dashboard/medication-intake-quick-add";
import { WaterQuickAddSheet } from "@/components/insights/nutrients/water-quick-add-sheet";
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
import { sheetBodyHasUnsavedInput } from "@/components/dashboard/quick-entry-sheets";
import { useTranslations } from "@/lib/i18n/context";
import { useModuleEnabled } from "@/hooks/use-module-enabled";

/**
 * The center "Log" capture action (iOS parity — the bottom bar's
 * middle slot is a capture CTA, not a destination). It opens a small
 * picker that routes to four existing quick-entry surfaces:
 *
 *   - Measurement → `<MeasurementForm>` (the `/measurements` add form)
 *   - Medication  → `<MedicationIntakeQuickAdd>` (dashboard quick-add)
 *   - Mood        → `<MoodForm>` (the `/mood` add form, 5-face flow)
 *   - Water       → `<WaterQuickAddSheet>` (the hydration quick-add)
 *
 * The picker reuses each existing capture component rather than
 * rebuilding parallel forms.
 *
 * Nothing here orphans a route: the same surfaces remain reachable
 * from their own pages (`/measurements`, `/mood`, dashboard) and from
 * the More hub. The picker is an additional fast path, not a removal.
 *
 * v1.30.1 — the form sheet shares the dashboard quick-entry sheets'
 * confirm-before-discard guard (`sheetBodyHasUnsavedInput()`), so a
 * swipe-down / backdrop tap / Escape on a half-filled form from the
 * primary mobile capture path asks before dropping typed input,
 * instead of closing unconditionally.
 */

type CaptureKind = "measurement" | "medication" | "mood" | "water";

interface CapturePickerProps {
  /** Whether the picker chooser sheet is open. */
  open: boolean;
  /** Open-state setter for the chooser sheet. */
  onOpenChange: (open: boolean) => void;
}

export function CapturePicker({ open, onOpenChange }: CapturePickerProps) {
  const { t } = useTranslations();
  const nutrientsEnabled = useModuleEnabled("nutrients");
  const [kind, setKind] = useState<CaptureKind | null>(null);
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  // v1.30.1 — mirrors `QuickEntrySheets`' `confirmDiscardOpen`: hold a
  // dismiss attempt here instead of closing outright when the form
  // body carries unsaved input.
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  function chooseKind(next: CaptureKind) {
    if (next === "water" && !nutrientsEnabled) return;
    // Close the chooser first, then open the form sheet so only one
    // bottom-sheet is mounted at a time (no stacked backdrops).
    onOpenChange(false);
    setKind(next);
  }

  function closeForm() {
    setKind(null);
  }

  // Intercept a form-sheet dismiss: close immediately when the form is
  // clean, otherwise keep the sheet open and ask before discarding —
  // same contract as `QuickEntrySheets.handleQuickEntryOpenChange`.
  function handleFormOpenChange(next: boolean) {
    if (next) return;
    if (sheetBodyHasUnsavedInput()) {
      setConfirmDiscardOpen(true);
      return;
    }
    closeForm();
  }

  const options: ReadonlyArray<{
    kind: CaptureKind;
    label: string;
    description: string;
    icon: typeof Activity;
  }> = [
    {
      kind: "measurement",
      label: t("nav.capture.measurement"),
      description: t("nav.capture.measurementDescription"),
      icon: Activity,
    },
    {
      kind: "medication",
      label: t("nav.capture.medication"),
      description: t("nav.capture.medicationDescription"),
      icon: Pill,
    },
    {
      kind: "mood",
      label: t("nav.capture.mood"),
      description: t("nav.capture.moodDescription"),
      icon: Waves,
    },
    {
      kind: "water",
      label: t("nav.capture.water"),
      description: t("nav.capture.waterDescription"),
      icon: GlassWater,
    },
  ];

  const formTitleByKind: Record<CaptureKind, string> = {
    measurement: t("measurements.addMeasurement"),
    medication: t("nav.capture.medication"),
    mood: t("mood.addEntry"),
    water: t("nutrients.hydration.quickAddTitle"),
  };
  // `kind === null` keeps the form sheet closed (the title is unread then);
  // the mood label is the harmless default, matching the prior ternary's
  // else branch.
  const formTitle = kind ? formTitleByKind[kind] : t("mood.addEntry");

  return (
    <>
      {/* The capture-kind chooser. */}
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title={t("nav.capture.title")}
        description={t("nav.capture.description")}
      >
        <div
          className="grid grid-cols-1 gap-2"
          data-testid="capture-picker-options"
        >
          {options.map((opt) =>
            opt.kind !== "water" || nutrientsEnabled ? (
              <button
                key={opt.kind}
                type="button"
                data-testid={`capture-picker-${opt.kind}`}
                onClick={() => chooseKind(opt.kind)}
                className="border-border hover:bg-accent/40 focus-visible:ring-ring/50 flex min-h-14 items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
                  <opt.icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{opt.label}</span>
                  <span className="text-muted-foreground block text-xs">
                    {opt.description}
                  </span>
                </span>
              </button>
            ) : null,
          )}
        </div>
      </ResponsiveSheet>

      {/* The chosen capture surface, reusing the existing form. */}
      <ResponsiveSheet
        open={kind !== null && kind !== "water"}
        onOpenChange={handleFormOpenChange}
        title={formTitle}
        footer={<div ref={setFooterEl} className="flex w-full" />}
      >
        {kind === "measurement" && (
          <MeasurementForm
            onSuccess={closeForm}
            onCancel={closeForm}
            footerSlot={footerEl}
          />
        )}
        {kind === "medication" && (
          <MedicationIntakeQuickAdd
            onSuccess={closeForm}
            onCancel={closeForm}
            footerSlot={footerEl}
          />
        )}
        {kind === "mood" && (
          <MoodForm
            onSuccess={closeForm}
            onCancel={closeForm}
            footerSlot={footerEl}
          />
        )}
      </ResponsiveSheet>

      {nutrientsEnabled && kind === "water" && (
        <WaterQuickAddSheet
          open
          onOpenChange={handleFormOpenChange}
          onSuccess={closeForm}
        />
      )}

      {/* v1.30.1 — confirm before discarding a partly-filled capture
          form when the sheet is dismissed by an overlay tap, Escape,
          or a mobile swipe-down. Copy shared with the dashboard
          quick-entry sheets' identical guard. */}
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
                closeForm();
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
