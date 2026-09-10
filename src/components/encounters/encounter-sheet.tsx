"use client";

/**
 * The sheet the visit form lives in — create and edit, one surface.
 *
 * Save is disabled only when the date cannot be parsed. Nothing else on the
 * form can block it, which is the property the whole feature is checked
 * against.
 *
 * Two entry points pre-fill it and neither changes what is required:
 *
 *   - `reminderId` — opened from a due checkup. Filing the visit as DONE closes
 *     that checkup through the server's forward-only, idempotent path, so a
 *     person who both ticks the box and files a visit gets one satisfaction and
 *     no error.
 *   - `episodeId` — opened from a condition's "Visits about this" card, with
 *     the episode already linked.
 *
 * A delegate who may file the visit but not close the checkup gets the visit
 * saved and a plain sentence saying the checkup stayed open. That is reported
 * rather than skipped in silence: somebody who believes a checkup was closed
 * will not look at it again.
 *
 * Capability note: this sheet carries no capability check of its own, by
 * decision. Save is a create on one mount and an edit on the other, and Delete
 * exists only in edit mode — so the question belongs to whoever opens it.
 * `VisitsSection` hands it a record only under `canManageDomain("profile")`,
 * and the two mounts that can only create (`EpisodeVisitsCard`,
 * `VorsorgeSection`) pass `encounter={null}` behind their own write check. A
 * THIRD mount that hands this sheet a record without asking the manage
 * question reintroduces an ungated Delete, and nothing here will fail. Ask at
 * the caller, or move the check in here for everyone.
 */
import { useState } from "react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useTranslations } from "@/lib/i18n/context";
import { useEncounterMutations, type Encounter } from "@/hooks/use-encounters";
import {
  EncounterForm,
  draftFromEncounter,
  draftInstant,
  draftToBody,
  emptyDraft,
  nowLocalValue,
  type EncounterDraft,
} from "./encounter-form";

export function EncounterSheet({
  open,
  onOpenChange,
  encounter,
  reminderId,
  episodeId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` creates a visit; a row edits it. */
  encounter: Encounter | null;
  /** The due checkup this visit is being filed against, when there is one. */
  reminderId?: string | null;
  /** A condition to pre-link, when the sheet was opened from an episode. */
  episodeId?: string | null;
  onSaved?: (saved: Encounter) => void;
}) {
  const { t } = useTranslations();
  const { create, update, remove } = useEncounterMutations();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Seeded once, at mount. The caller remounts this component on every open by
  // varying its `key`, so a second edit never shows the first one's values and
  // a create after an edit starts empty — without an effect that copies props
  // into state and briefly renders the stale pair.
  const [draft, setDraft] = useState<EncounterDraft>(() =>
    encounter
      ? draftFromEncounter(encounter)
      : emptyDraft({
          occurredAt: nowLocalValue(),
          episodeIds: episodeId ? [episodeId] : [],
        }),
  );
  const [error, setError] = useState<string | null>(null);

  const isEdit = encounter !== null;
  const pending = create.isPending || update.isPending;
  // The one gate. A date that does not parse is not a visit; everything else
  // on this form is optional by design.
  const dateUsable = draftInstant(draft.occurredAt) !== null;

  const submit = async () => {
    const body = draftToBody(draft, { isEdit, reminderId });
    if (!body) return;
    try {
      const saved = isEdit
        ? await update.mutateAsync({ id: encounter.id, body })
        : await create.mutateAsync(body);
      // The server names what its grant could not reach. Today that is only a
      // checkup closure, and a delegate seeing nothing would believe it closed
      // — so a write that did part of what was asked reports `partial`, not a
      // green tick, through the one module that owns the affordance.
      const wroteEverything = (saved.skipped?.links ?? 0) === 0;
      toastWrittenOutcome(
        wroteEverything ? "success" : "partial",
        wroteEverything
          ? t(isEdit ? "encounters.updated" : "encounters.created")
          : t("encounters.checkupNotClosed"),
      );
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("encounters.saveFailed");
      setError(message);
      toast.error(message);
    }
  };

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t(isEdit ? "encounters.editTitle" : "encounters.createTitle")}
      description={t("encounters.formDescription")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            className="min-h-11"
            data-slot="encounter-save"
            disabled={!dateUsable || pending}
            onClick={() => void submit()}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <EncounterForm draft={draft} onChange={setDraft} isEdit={isEdit} />
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {isEdit ? (
          <AlertDialog
            open={confirmingDelete}
            onOpenChange={setConfirmingDelete}
          >
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="min-h-11"
                data-slot="encounter-delete"
              >
                <Trash2 className="size-4" aria-hidden />
                {t("common.delete")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("encounters.deleteTitle")}
                </AlertDialogTitle>
                {/* Says what goes with it. Deleting a booked visit retires its
                    reminder, and a person who booked one deserves to know the
                    nudge stops rather than discover it by silence. */}
                <AlertDialogDescription>
                  {t("encounters.deleteDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    remove.mutate(encounter.id, {
                      onSuccess: () => onOpenChange(false),
                      onError: () => toast.error(t("encounters.deleteFailed")),
                    });
                  }}
                >
                  {t("common.delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}
