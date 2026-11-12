"use client";

/**
 * The sheet the dose form lives in — create and edit, one surface.
 *
 * Save is disabled only when the date cannot be parsed or neither identity arm
 * is present. Nothing else on the form can block it — the property the whole
 * feature is checked against.
 *
 * On a successful create the caller may raise the booster-mint prompt; this
 * sheet completes and closes regardless of what the person does with it. The
 * mint is an offer, never a step.
 *
 * Capability note: the same posture as the visit sheet. No check here; Delete
 * renders only in edit mode, and the one mount that can reach edit mode
 * (`VaccinationsView`) asks `canManageDomain("profile")` before handing over a
 * record, while its create path asks `canWriteDomain("profile")`. A second
 * mount that skips either question reintroduces an ungated control with
 * nothing failing.
 */
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

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
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import { RelatedRecordsBlock } from "@/components/links/related-records";
import type { RelatedLink } from "@/lib/links/related";
import {
  useVaccination,
  useVaccinationMutations,
  type Vaccination,
} from "./use-vaccinations";
import {
  VaccinationForm,
  draftFromVaccination,
  draftHasIdentity,
  draftInstant,
  draftToBody,
  emptyDraft,
  type VaccinationDraft,
} from "./vaccination-form";

export function VaccinationSheet({
  open,
  onOpenChange,
  vaccination,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` creates a dose; a row edits it. */
  vaccination: Vaccination | null;
  /** Raised after a fresh create, for the booster-mint offer. */
  onCreated?: (created: Vaccination) => void;
}) {
  const { t } = useTranslations();
  const { create, update, remove, restore } = useVaccinationMutations();
  // The list row carries no document links; the detail read does. Until it
  // answers, the draft's links stay "untouched" and Save leaves them alone.
  const detail = useVaccination(vaccination?.id ?? null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Seeded once at mount; the caller remounts on every open by varying `key`.
  const [draft, setDraft] = useState<VaccinationDraft>(() =>
    vaccination ? draftFromVaccination(vaccination) : emptyDraft(),
  );
  const [error, setError] = useState<string | null>(null);

  const isEdit = vaccination !== null;
  const pending = create.isPending || update.isPending;
  const savable =
    draftInstant(draft.occurredAt) !== null && draftHasIdentity(draft);

  const submit = async () => {
    const body = draftToBody(draft);
    if (!body) return;
    try {
      if (isEdit) {
        await update.mutateAsync({ id: vaccination.id, body });
        toastWrittenOutcome("success", t("vaccinations.updated"));
        onOpenChange(false);
      } else {
        const created = await create.mutateAsync(body);
        toastWrittenOutcome("success", t("vaccinations.created"));
        onOpenChange(false);
        onCreated?.(created);
      }
    } catch (err) {
      const message = localizedApiError(err, t, "vaccinations.saveFailed");
      setError(message);
      showErrorToast(message, { cause: err });
    }
  };

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t(isEdit ? "vaccinations.editTitle" : "vaccinations.createTitle")}
      description={t("vaccinations.formDescription")}
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
            data-slot="vaccination-save"
            disabled={!savable || pending}
            onClick={() => void submit()}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <VaccinationForm
          draft={draft}
          onChange={setDraft}
          savedDocuments={
            vaccination
              ? {
                  ids:
                    detail.data?.documents?.map((document) => document.id) ??
                    null,
                  links: detail.data?.documents,
                  pending: detail.isPending,
                  error: detail.isError,
                  retry: () => void detail.refetch(),
                }
              : undefined
          }
        />
        {/* v1.43 — the visit the dose was given at and anything else it
            relates to; its pages have their own picker above. */}
        {vaccination ? (
          <RelatedRecordsBlock
            related={
              (detail.data as { related?: RelatedLink[] } | undefined)?.related
            }
            omitKinds={["document"]}
          />
        ) : null}
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
                data-slot="vaccination-delete"
              >
                <Trash2 className="size-4" aria-hidden />
                {t("common.delete")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("vaccinations.deleteTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("vaccinations.deleteDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    const id = vaccination.id;
                    remove.mutate(id, {
                      onSuccess: () => {
                        onOpenChange(false);
                        // The delete is soft. The Undo runs after this sheet
                        // closed, so it awaits the restore itself rather than
                        // passing callbacks a closed sheet never receives.
                        toast.success(t("vaccinations.deleted"), {
                          action: {
                            label: t("common.undo"),
                            onClick: () =>
                              void restore.mutateAsync(id).catch((failure) =>
                                showErrorToast(
                                  t("vaccinations.restoreFailed"),
                                  {
                                    cause: failure,
                                  },
                                ),
                              ),
                          },
                        });
                      },
                      onError: (failure) =>
                        showErrorToast(t("vaccinations.deleteFailed"), {
                          cause: failure,
                        }),
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
