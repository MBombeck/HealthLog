"use client";

import { createPortal } from "react-dom";
import { Loader2, Trash2 } from "lucide-react";

import { FieldError } from "@/components/forms/field-error";
import { SeededFormDiscardDialog } from "@/components/forms/use-seeded-form-dismissal";
import { FieldGroup } from "@/components/ui/field-group";
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
import { ActionMenu, ActionPair } from "@/components/ui/action-pair";
import { Button } from "@/components/ui/button";
import { DateTimeField } from "@/components/ui/date-time-field";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";

import { GlucoseContextSelect } from "../glucose-context-select";
import { MEASUREMENT_TYPE_LABEL_KEYS as TYPE_LABEL_KEYS } from "../measurement-list-meta";

import { MAX_COMMENT_LENGTH, toDateTimeLocalValue } from "./list-model";
import { deleteConfirmDescription } from "./row-actions";
import type { MeasurementEdit } from "./use-measurement-edit";
import type { MeasurementRowDisplay } from "./use-measurement-row-display";

/**
 * The edit sheet (a bottom sheet on phones): value in the display unit,
 * the meal context of a blood glucose reading, timestamp, note, and the delete behind the overflow menu, with the
 * actions portalled into the sheet's pinned footer.
 */
export function MeasurementEditSheet({
  edit,
  display,
}: {
  edit: MeasurementEdit;
  display: MeasurementRowDisplay;
}) {
  const { t } = useTranslations();
  const { rowDisplay } = display;
  const {
    editing,
    closeEdit,
    setEditFooterEl,
    editFormId,
    submitEdit,
    editValue,
    setEditValue,
    editError,
    editErrorDescriptor,
    editValueError,
    editValueErrorId,
    editMeasuredAt,
    setEditMeasuredAt,
    editNotes,
    setEditNotes,
    editGlucoseContext,
    setEditGlucoseContext,
    editErrorId,
    editFooterEl,
    deleteMutation,
    setEditDeleteDialogOpen,
    editDeleteDialogOpen,
    deleteEditingMeasurement,
    editDismissal,
  } = edit;
  return (
    <>
      <ResponsiveSheet
        open={!!editing}
        onOpenChange={(open) => !open && closeEdit()}
        title={t("measurements.editMeasurement")}
        footer={<div ref={setEditFooterEl} className="flex w-full" />}
      >
        {editing && (
          <form id={editFormId} onSubmit={submitEdit} className="space-y-4">
            <div className="flex items-center gap-1.5">
              <Label className="shrink-0">{t("measurements.type")}</Label>
              <span className="text-sm leading-none font-medium">
                {TYPE_LABEL_KEYS[editing.type]
                  ? t(TYPE_LABEL_KEYS[editing.type])
                  : editing.type}
              </span>
            </div>

            <FieldGroup
              htmlFor="edit-value"
              label={t("measurements.valueWithUnit", {
                unit: rowDisplay(editing).unit,
              })}
            >
              <Input
                id="edit-value"
                type="number"
                enterKeyHint="next"
                step="any"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                required
                aria-required="true"
                aria-invalid={!!(editValueError || editError) || undefined}
                aria-describedby={
                  editValueError ? editValueErrorId : editErrorDescriptor
                }
              />
              <FieldError id={editValueErrorId} message={editValueError} />
            </FieldGroup>

            {editing.type === "BLOOD_GLUCOSE" && (
              <FieldGroup
                htmlFor="edit-glucose-context"
                label={t("measurements.glucoseContext")}
              >
                <GlucoseContextSelect
                  id="edit-glucose-context"
                  value={editGlucoseContext}
                  onValueChange={setEditGlucoseContext}
                  // A sensor or MCP reading arrives without a context, and
                  // saving its note must not force one onto it.
                  allowNone
                />
              </FieldGroup>
            )}

            <FieldGroup
              htmlFor="edit-measuredAt"
              label={t("measurements.timestamp")}
            >
              <DateTimeField
                id="edit-measuredAt"
                value={editMeasuredAt}
                onChange={setEditMeasuredAt}
                // Match the server bound: no future instant.
                max={toDateTimeLocalValue(new Date().toISOString())}
                required
                aria-required="true"
                aria-invalid={!!editError || undefined}
                aria-describedby={editErrorDescriptor}
              />
            </FieldGroup>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="edit-notes">
                  {t("common.note")} ({t("common.optional")})
                </Label>
                <span className="text-muted-foreground text-xs">
                  {editNotes.length}/{MAX_COMMENT_LENGTH}
                </span>
              </div>
              <Input
                id="edit-notes"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                maxLength={MAX_COMMENT_LENGTH}
                enterKeyHint="done"
                autoCapitalize="sentences"
              />
            </div>

            {editError && (
              <div
                id={editErrorId}
                role="alert"
                aria-live="assertive"
                className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
              >
                {editError}
              </div>
            )}

            {editFooterEl
              ? createPortal(<EditSheetFooter edit={edit} />, editFooterEl)
              : null}

            <AlertDialog
              open={editDeleteDialogOpen}
              onOpenChange={setEditDeleteDialogOpen}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("measurements.deleteConfirmTitle")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {deleteConfirmDescription(editing, t)}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleteMutation.isPending}>
                    {t("common.cancel")}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={deleteEditingMeasurement}
                    disabled={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                    ) : null}
                    {t("common.delete")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </form>
        )}
      </ResponsiveSheet>
      <SeededFormDiscardDialog
        open={editDismissal.discardDialogOpen}
        onConfirm={editDismissal.confirmDiscard}
        onCancel={editDismissal.cancelDiscard}
      />
    </>
  );
}

/**
 * The sheet's pinned footer: the overflow menu with delete on the left,
 * cancel and save on the right.
 */
function EditSheetFooter({ edit }: { edit: MeasurementEdit }) {
  const { t } = useTranslations();
  const {
    updateMutation,
    deleteMutation,
    setEditDeleteDialogOpen,
    closeEdit,
    editFormId,
  } = edit;
  const busy = updateMutation.isPending || deleteMutation.isPending;
  return (
    <ActionPair>
      <ActionMenu disabled={busy}>
        <DropdownMenuItem onClick={() => setEditDeleteDialogOpen(true)}>
          <Trash2 className="mr-2 h-4 w-4" />
          {t("common.delete")}
        </DropdownMenuItem>
      </ActionMenu>
      {/* `[Cancel] [Save]`, primary rightmost, per Apple's HIG: iOS is the
          load-bearing phone target and the web shell renders desktop and the
          iOS PWA from one component. */}
      <Button
        type="button"
        variant="outline"
        onClick={closeEdit}
        disabled={busy}
      >
        {t("common.cancel")}
      </Button>
      <Button type="submit" form={editFormId} disabled={busy}>
        {updateMutation.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : null}
        {t("common.save")}
      </Button>
    </ActionPair>
  );
}
