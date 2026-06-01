"use client";

/**
 * v1.5.5 F-1 C-2 — per-row Bearbeiten dialog on the detail-page
 * intake-history preview.
 *
 * Restores the row-level edit affordance the v1.5.4 flat-form
 * retirement displaced (I-1 §15). The dialog opens from the
 * intake-history kebab; fields are `takenAt` (datetime-local),
 * `skipped` (boolean), `note` (string?). On save it PATCHes
 * `/api/medications/{id}/intake/{eventId}` and fires the
 * medication cache bundle so the inline compliance tile + dashboard
 * chart converge in the same tick.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

export interface IntakeEditDialogProps {
  medicationId: string;
  /** Event being edited; `null` closes the dialog. */
  event: {
    id: string;
    takenAt: string | null;
    skipped: boolean;
    note?: string | null;
  } | null;
  onClose: () => void;
}

/**
 * Convert an ISO timestamp into the `<input type="datetime-local">`
 * shape `YYYY-MM-DDTHH:mm`. Returns an empty string for null inputs.
 * The string is rendered in the user's local time so the picker
 * matches the dose timestamp the user remembers.
 */
function toDateTimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function IntakeEditDialog(props: IntakeEditDialogProps) {
  // Re-mount the body whenever the event id flips so the form state
  // initialises from the row the user clicked. The wrapper is also
  // responsible for not rendering the dialog when `event` is null.
  if (!props.event) return null;
  return <IntakeEditDialogBody key={props.event.id} {...props} />;
}

function IntakeEditDialogBody({
  medicationId,
  event,
  onClose,
}: IntakeEditDialogProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [takenAt, setTakenAt] = useState(() =>
    toDateTimeLocal(event?.takenAt ?? null),
  );
  const [skipped, setSkipped] = useState(() => event?.skipped ?? false);
  const [note, setNote] = useState(() => event?.note ?? "");
  const [busy, setBusy] = useState(false);

  if (!event) return null;

  async function save() {
    if (!event || busy) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        skipped,
      };
      if (takenAt) {
        // Re-attach the local-time string to ISO with the user's
        // current tz offset so the server stores the canonical UTC
        // value the picker showed.
        body.takenAt = new Date(takenAt).toISOString();
      } else {
        body.takenAt = null;
      }
      if (note.trim().length > 0) {
        body.note = note;
      }
      const res = await fetch(
        `/api/medications/${medicationId}/intake/${event.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        toast.error(t("medications.detail.intake.edit.failed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.intake.edit.savedToast"));
      onClose();
    } catch {
      toast.error(t("medications.detail.intake.edit.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!event} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-slot="intake-edit-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("medications.detail.intake.edit.dialogTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="intake-edit-taken-at">
              {t("medications.detail.intake.edit.takenAtLabel")}
            </Label>
            <Input
              id="intake-edit-taken-at"
              type="datetime-local"
              value={takenAt}
              onChange={(e) => setTakenAt(e.target.value)}
              disabled={skipped}
            />
          </div>
          <label
            htmlFor="intake-edit-skipped"
            className="flex items-center justify-between gap-3"
          >
            <span className="text-sm font-medium">
              {t("medications.detail.intake.edit.skippedLabel")}
            </span>
            <Switch
              id="intake-edit-skipped"
              checked={skipped}
              onCheckedChange={(checked) => setSkipped(checked)}
            />
          </label>
          <div className="space-y-1">
            <Label htmlFor="intake-edit-note">
              {t("medications.detail.intake.edit.noteLabel")}
            </Label>
            <Textarea
              id="intake-edit-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("medications.detail.intake.edit.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={busy} aria-busy={busy || undefined}>
            {t("medications.detail.intake.edit.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
