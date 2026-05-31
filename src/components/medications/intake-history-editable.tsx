"use client";

/**
 * v1.7.0 — shared editable intake-history surface.
 *
 * Extracted from `<IntakeHistoryPreview>` so the detail-page preview
 * (14-row, `takenAt` sort) and the full-history view (25-row,
 * `scheduledFor` sort) share one state machine: multi-select
 * bulk-delete, per-row edit (`<IntakeEditDialog>`) and per-row delete
 * (`<AlertDialog>`). The component owns the table + every editing
 * dialog; it does NOT own the CSV-import dialog (that stays lifted to
 * the hosting page so it mounts exactly once).
 *
 * Both surfaces render the same `<IntakeHistoryListV2>`; the wrapper
 * just changes `pageSize` + `defaultSortBy`. The full-history route
 * defaults to `scheduledFor desc` so skipped rows (`takenAt: null`)
 * never float to the top of the table (O-1).
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { Button } from "@/components/ui/button";
import { IntakeEditDialog } from "@/components/medications/intake-edit-dialog";
import {
  IntakeHistoryListV2,
  type IntakeEvent,
  type IntakeHistorySortKey,
} from "@/components/medications/intake-history-list-v2";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

export interface IntakeHistoryEditableProps {
  medicationId: string;
  /** Override the default page size — preview 14, full history 25. */
  pageSize?: number;
  /**
   * Initial sort column. The full-history view passes `"scheduledFor"`
   * so the chronological order stays clean even for skipped rows
   * (`takenAt: null`); the preview keeps the legacy `"takenAt"`.
   */
  defaultSortBy?: IntakeHistorySortKey;
}

export function IntakeHistoryEditable({
  medicationId,
  pageSize,
  defaultSortBy,
}: IntakeHistoryEditableProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingEvent, setEditingEvent] = useState<IntakeEvent | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rowDeleteBusy, setRowDeleteBusy] = useState(false);

  function onToggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function confirmBulkDelete() {
    if (bulkBusy || selected.size === 0) return;
    setBulkBusy(true);
    const ids = Array.from(selected);
    try {
      const res = await fetch(
        `/api/medications/${medicationId}/intake/bulk-delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventIds: ids }),
        },
      );
      if (!res.ok) {
        toast.error(t("medications.detail.intake.bulkDelete.failed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.intake.bulkDelete.toast"));
      setBulkConfirmOpen(false);
      clearSelection();
    } catch {
      toast.error(t("medications.detail.intake.bulkDelete.failed"));
    } finally {
      setBulkBusy(false);
    }
  }

  async function confirmRowDelete() {
    if (rowDeleteBusy || !pendingDeleteId) return;
    setRowDeleteBusy(true);
    const id = pendingDeleteId;
    try {
      const res = await fetch(`/api/medications/${medicationId}/intake/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error(t("medications.detail.intake.deleteRow.failed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.intake.deleteRow.toast"));
      setPendingDeleteId(null);
      // Drop the deleted row from the pending selection so the
      // bulk-toolbar count stays honest.
      setSelected((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch {
      toast.error(t("medications.detail.intake.deleteRow.failed"));
    } finally {
      setRowDeleteBusy(false);
    }
  }

  return (
    <>
      <div className="space-y-3" data-slot="intake-history-editable-body">
        {selected.size > 0 && (
          <div
            className="border-border bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
            role="region"
            aria-label={t(
              "medications.detail.intake.bulkDelete.selectionCount",
              { count: selected.size },
            )}
            data-slot="intake-history-bulk-delete-toolbar"
          >
            <span className="text-foreground text-sm font-medium">
              {t("medications.detail.intake.bulkDelete.selectionCount", {
                count: selected.size,
              })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={clearSelection}
                className="min-h-11 sm:min-h-9"
                data-slot="intake-history-bulk-cancel"
              >
                {t("medications.detail.intake.bulkDelete.cancelButton")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkConfirmOpen(true)}
                className="min-h-11 sm:min-h-9"
                data-slot="intake-history-bulk-delete"
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
                {t("medications.detail.intake.bulkDelete.deleteButton")}
              </Button>
            </div>
          </div>
        )}

        <IntakeHistoryListV2
          medicationId={medicationId}
          pageSize={pageSize}
          defaultSortBy={defaultSortBy}
          onEditIntake={setEditingEvent}
          onDeleteIntake={setPendingDeleteId}
          selection={{
            mode: "multi",
            selected,
            onToggle,
          }}
        />
      </div>

      <IntakeEditDialog
        medicationId={medicationId}
        event={
          editingEvent
            ? {
                id: editingEvent.id,
                takenAt: editingEvent.takenAt,
                skipped: editingEvent.skipped,
              }
            : null
        }
        onClose={() => setEditingEvent(null)}
      />

      <AlertDialog
        open={bulkConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setBulkConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.detail.intake.bulkDelete.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.detail.intake.bulkDelete.confirmBody", {
                count: selected.size,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkBusy}>
              {t("medications.detail.intake.bulkDelete.cancelButton")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmBulkDelete();
              }}
              disabled={bulkBusy}
              aria-busy={bulkBusy || undefined}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("medications.detail.intake.bulkDelete.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!pendingDeleteId}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.detail.intake.deleteRow.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.detail.intake.deleteRow.confirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rowDeleteBusy}>
              {t("medications.detail.intake.bulkDelete.cancelButton")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmRowDelete();
              }}
              disabled={rowDeleteBusy}
              aria-busy={rowDeleteBusy || undefined}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("medications.detail.intake.deleteRow.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
