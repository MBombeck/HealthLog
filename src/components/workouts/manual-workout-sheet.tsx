"use client";

import { useCallback, useRef, useState } from "react";

import {
  ResponsiveSheet,
  sheetBodyHasUnsavedInput,
} from "@/components/ui/responsive-sheet";
import {
  ManualWorkoutForm,
  type ManualWorkoutEdit,
} from "@/components/workouts/manual-workout-form";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The "Log workout" sheet for a surface that owns its own open state (the
 * workouts page header). The dashboard quick-add and the capture picker mount
 * `ManualWorkoutForm` inside their own sheets, which ask before a stray swipe
 * drops a half-filled form; this one does too.
 *
 * With `edit` it opens on a stored workout (#1162). Its fields start filled,
 * so "has input" says nothing there; the sheet asks the form whether anything
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
  const editDirty = useRef(false);
  const handleDirtyChange = useCallback((dirty: boolean) => {
    editDirty.current = dirty;
  }, []);

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      dirty={edit ? () => editDirty.current : sheetBodyHasUnsavedInput}
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
  );
}
