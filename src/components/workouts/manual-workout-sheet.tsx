"use client";

import { useCallback, useRef, useState } from "react";

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
import {
  ManualWorkoutForm,
  type ManualWorkoutEdit,
} from "@/components/workouts/manual-workout-form";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The "Log workout" sheet for a surface that owns its own open state (the
 * workouts page header). The dashboard quick-add and the capture picker mount
 * `ManualWorkoutForm` inside their own sheets, which already carry the same
 * confirm-before-discard guard; this one carries it too, so a half-filled
 * form is never dropped by a stray swipe.
 *
 * With `edit` it opens on a stored workout (#1162). Its fields start filled,
 * so "has input" says nothing there; the guard asks the form whether anything
 * differs from what it opened with.
 */
export function ManualWorkoutSheet({
  open,
  onOpenChange,
  edit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  edit?: ManualWorkoutEdit;
}) {
  const { t } = useTranslations();
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const editDirty = useRef(false);
  const handleDirtyChange = useCallback((dirty: boolean) => {
    editDirty.current = dirty;
  }, []);

  function handleOpenChange(next: boolean) {
    if (next) return onOpenChange(true);
    if (edit ? editDirty.current : sheetBodyHasUnsavedInput()) {
      setConfirmDiscardOpen(true);
      return;
    }
    onOpenChange(false);
  }

  return (
    <>
      <ResponsiveSheet
        open={open}
        onOpenChange={handleOpenChange}
        title={t(
          edit
            ? "insights.workouts.manual.editTitle"
            : "insights.workouts.manual.sheetTitle",
        )}
        description={t("insights.workouts.manual.sheetDescription")}
        footer={<div ref={setFooterEl} className="flex w-full" />}
      >
        {open && (
          <ManualWorkoutForm
            onSuccess={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
            footerSlot={footerEl}
            edit={edit}
            onDirtyChange={edit ? handleDirtyChange : undefined}
          />
        )}
      </ResponsiveSheet>
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
                onOpenChange(false);
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
