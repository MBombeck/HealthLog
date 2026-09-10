"use client";

import { useState } from "react";
import { Activity, Pill, Waves } from "lucide-react";

import { MeasurementForm } from "@/components/measurements/measurement-form";
import { MoodForm } from "@/components/mood/mood-form";
import { MedicationIntakeQuickAdd } from "@/components/dashboard/medication-intake-quick-add";
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
import type { ShareDomain } from "@/lib/sharing/scope";
import {
  useRecordCapabilities,
  type RecordCapabilities,
} from "@/hooks/use-record-capabilities";

/**
 * The center "Log" capture action (iOS parity — the bottom bar's
 * middle slot is a capture CTA, not a destination). It opens a small
 * picker that routes to three existing quick-entry surfaces:
 *
 *   - Measurement → `<MeasurementForm>` (the `/measurements` add form)
 *   - Medication  → `<MedicationIntakeQuickAdd>` (dashboard quick-add)
 *   - Mood        → `<MoodForm>` (the `/mood` add form, 5-face flow)
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

type CaptureKind = "measurement" | "medication" | "mood";

/**
 * The section each capture surface writes to.
 *
 * One question per kind, asked of that kind's own section. The picker used to
 * ask a coarse one as well — a closed list of kinds a WRITE grant admits,
 * offered whenever the grant could write anywhere — and that answer is the
 * grant's LEVEL with no scope term at all. A WRITE grant scoped to `["labs"]`
 * read as true and got a weight form the server refuses; one scoped to
 * `["documents"]`, which takes no delegated write at any level, got both.
 *
 * `writableDomains` is already the level × scope × route-table intersection,
 * so asking it per section answers both cases and the mood entry's
 * MANAGE-only create as well.
 */
const CAPTURE_KIND_DOMAIN: Readonly<Record<CaptureKind, ShareDomain>> = {
  measurement: "measurements",
  medication: "medications",
  mood: "mind",
};

/** The order the chooser lists them in. */
export const CAPTURE_KIND_ORDER: ReadonlyArray<CaptureKind> = [
  "measurement",
  "medication",
  "mood",
];

/**
 * The kind whose form may actually be on screen.
 *
 * Gating the chooser is not enough, and the gap is widest exactly when it
 * matters. `resolveRecordCapabilities(undefined)` answers "your own record"
 * until `/api/auth/me` settles — deliberately, so no add button blanks on
 * every cold load — and the switch flow ends in a hard reload that wipes the
 * persisted query cache. So a delegate's first paint offers all kinds for
 * as long as that query takes. `chooseKind` refused an unoffered kind at tap
 * time and then never asked again, so a tap landing inside that window opened
 * a form and left it open once the answer arrived: the delegate ends up
 * standing on a form posting to a route the server refuses.
 *
 * Re-deriving the open form from the CURRENT offer is what closes it. Same
 * shape `/measurements` and the medication wizard already use (`open={x &&
 * capability}`) — a control that appears and withdraws is a much smaller lie
 * than one that stays and 403s.
 *
 * Pure and exported so the rule can be pinned without a click; an SSR test
 * cannot tap the button that opens the sheet.
 */
export function admittedCaptureKind(
  kind: CaptureKind | null,
  offered: ReadonlyArray<CaptureKind>,
): CaptureKind | null {
  return kind !== null && offered.includes(kind) ? kind : null;
}

/**
 * The capture kinds to offer, given what the record allows. Exported pure so
 * the delegation rule can be pinned without opening a sheet: an SSR test
 * cannot tap the button that opens it.
 */
export function visibleCaptureKinds(
  caps: Pick<RecordCapabilities, "canWriteDomain">,
  kinds: ReadonlyArray<CaptureKind>,
): CaptureKind[] {
  return kinds.filter((kind) => caps.canWriteDomain(CAPTURE_KIND_DOMAIN[kind]));
}

interface CapturePickerProps {
  /** Whether the picker chooser sheet is open. */
  open: boolean;
  /** Open-state setter for the chooser sheet. */
  onOpenChange: (open: boolean) => void;
}

export function CapturePicker({ open, onOpenChange }: CapturePickerProps) {
  const { t } = useTranslations();
  const capabilities = useRecordCapabilities();
  const offered = visibleCaptureKinds(capabilities, CAPTURE_KIND_ORDER);
  const [kind, setKind] = useState<CaptureKind | null>(null);
  // Re-derived on every render, never latched: the offer can shrink under a
  // sheet that is already open. See `admittedCaptureKind`.
  const openKind = admittedCaptureKind(kind, offered);
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  // v1.30.1 — mirrors `QuickEntrySheets`' `confirmDiscardOpen`: hold a
  // dismiss attempt here instead of closing outright when the form
  // body carries unsaved input.
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  function chooseKind(next: CaptureKind) {
    if (!offered.includes(next)) return;
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

  const allOptions: ReadonlyArray<{
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
  ];
  const options = allOptions.filter((opt) => offered.includes(opt.kind));

  const formTitleByKind: Record<CaptureKind, string> = {
    measurement: t("measurements.addMeasurement"),
    medication: t("nav.capture.medication"),
    mood: t("mood.addEntry"),
  };
  // `openKind === null` keeps the form sheet closed (the title is unread
  // then); the mood label is the harmless default, matching the prior
  // ternary's else branch.
  const formTitle = openKind ? formTitleByKind[openKind] : t("mood.addEntry");

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
          {options.map((opt) => (
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
          ))}
        </div>
      </ResponsiveSheet>

      {/* The chosen capture surface, reusing the existing form. */}
      <ResponsiveSheet
        open={openKind !== null}
        onOpenChange={handleFormOpenChange}
        title={formTitle}
        footer={<div ref={setFooterEl} className="flex w-full" />}
      >
        {openKind === "measurement" && (
          <MeasurementForm
            onSuccess={closeForm}
            onCancel={closeForm}
            footerSlot={footerEl}
          />
        )}
        {openKind === "medication" && (
          <MedicationIntakeQuickAdd
            onSuccess={closeForm}
            onCancel={closeForm}
            footerSlot={footerEl}
          />
        )}
        {openKind === "mood" && (
          <MoodForm
            onSuccess={closeForm}
            onCancel={closeForm}
            footerSlot={footerEl}
          />
        )}
      </ResponsiveSheet>

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
