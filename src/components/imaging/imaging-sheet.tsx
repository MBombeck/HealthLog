"use client";

/**
 * The exam's sheet: create and edit, one surface (#1672).
 *
 * Modality and day are the only required fields; Save is disabled until both
 * are there. The report and the pictures are vault documents: picked from the
 * vault through the shared link picker, or uploaded here, which files them in
 * the vault as kind `IMAGING` and selects them. Saving writes the links.
 *
 * Delete sits behind the footer's "⋯" in edit mode. The caller decides who
 * may reach edit mode (MANAGE on the labs section) and create (WRITE).
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Trash2 } from "lucide-react";

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
import { ActionMenu } from "@/components/ui/action-menu";
import { ActionPair } from "@/components/ui/action-pair";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTodayKey } from "@/components/day/use-today-key";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";

import { ImagingDocuments } from "./imaging-documents";
import { ImagingFields, SIDE_NONE, type ImagingDraft } from "./imaging-fields";
import {
  useImagingMutations,
  type ImagingExam,
  type ImagingWriteBody,
} from "./use-imaging";

function draftFrom(exam: ImagingExam | null, today: string): ImagingDraft {
  return {
    modality: exam?.modality ?? "",
    day: exam ? exam.performedAt.slice(0, 10) : today,
    side: exam?.side ?? SIDE_NONE,
    bodyPart: exam?.bodyPart ?? "",
    facility: exam?.facility ?? "",
    requestingDoctor: exam?.requestingDoctor ?? "",
    conclusion: exam?.conclusion ?? "",
    documentIds: exam?.documents.map((d) => d.id) ?? [],
  };
}

function bodyFrom(draft: ImagingDraft): ImagingWriteBody | null {
  if (!draft.modality || !/^\d{4}-\d{2}-\d{2}$/.test(draft.day)) return null;
  return {
    modality: draft.modality,
    performedAt: `${draft.day}T00:00:00.000Z`,
    side: draft.side === SIDE_NONE ? null : draft.side,
    bodyPart: draft.bodyPart.trim() || null,
    facility: draft.facility.trim() || null,
    requestingDoctor: draft.requestingDoctor.trim() || null,
    conclusion: draft.conclusion.trim() || null,
    documentIds: draft.documentIds,
  };
}

export function ImagingSheet({
  open,
  onOpenChange,
  exam,
  documentsEnabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` creates an exam; a row edits it. */
  exam: ImagingExam | null;
  /** The `inboundDocuments` module: off leaves the documents block out. */
  documentsEnabled: boolean;
}) {
  const { t } = useTranslations();
  const { create, update, remove } = useImagingMutations();
  const today = useTodayKey();
  const [seed] = useState(() => draftFrom(exam, today));
  const [draft, setDraft] = useState<ImagingDraft>(seed);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);

  const isEdit = exam !== null;
  const body = bodyFrom(draft);
  const busy = create.isPending || update.isPending || remove.isPending;
  const set = <K extends keyof ImagingDraft>(key: K, value: ImagingDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!body) return;
    setError(null);
    try {
      if (isEdit) {
        await update.mutateAsync({ id: exam.id, body });
        toastWrittenOutcome("success", t("imaging.updated"));
      } else {
        await create.mutateAsync(body);
        toastWrittenOutcome("success", t("imaging.created"));
      }
      onOpenChange(false);
    } catch (err) {
      const message = localizedApiError(err, t, "imaging.saveFailed");
      setError(message);
      showErrorToast(message, { cause: err });
    }
  };

  const footer = (
    <ActionPair>
      {isEdit ? (
        <ActionMenu disabled={busy} slot="imaging-more">
          <DropdownMenuItem onClick={() => setConfirmingDelete(true)}>
            <Trash2 className="mr-2 size-4" />
            {t("common.delete")}
          </DropdownMenuItem>
        </ActionMenu>
      ) : null}
      <Button
        type="button"
        variant="outline"
        onClick={() => onOpenChange(false)}
        disabled={busy}
      >
        {t("common.cancel")}
      </Button>
      <Button
        type="submit"
        form="imaging-form"
        data-slot="imaging-save"
        disabled={!body || busy || uploading}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        ) : null}
        {t("common.save")}
      </Button>
    </ActionPair>
  );

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      dirty={JSON.stringify(draft) !== JSON.stringify(seed)}
      title={t(isEdit ? "imaging.editTitle" : "imaging.createTitle")}
      footer={<div ref={setFooterEl} className="flex w-full" />}
    >
      <form
        id="imaging-form"
        onSubmit={(event) => void submit(event)}
        className="space-y-4"
        data-slot="imaging-form"
      >
        <ImagingFields draft={draft} set={set} today={today} />

        {documentsEnabled ? (
          <ImagingDocuments
            day={draft.day}
            open={open}
            selected={draft.documentIds}
            onChange={(ids) => set("documentIds", ids)}
            linked={exam?.documents ?? []}
            onUploadingChange={setUploading}
          />
        ) : null}

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {footerEl ? createPortal(footer, footerEl) : null}
      </form>

      {isEdit ? (
        <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("imaging.deleteTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("imaging.deleteDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>
                {t("common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                data-slot="imaging-delete-confirm"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(exam.id, {
                    onSuccess: () => {
                      toastWrittenOutcome("success", t("imaging.deleted"));
                      onOpenChange(false);
                    },
                    onError: (failure) =>
                      showErrorToast(t("imaging.deleteFailed"), {
                        cause: failure,
                      }),
                  })
                }
              >
                {t("common.delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </ResponsiveSheet>
  );
}
