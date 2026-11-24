"use client";

/**
 * The sheet a treatment series lives in: start one, or open one to see its
 * sessions, add the next, end it, edit or delete it.
 *
 * Only the title and the start day are needed to save. The progress, the
 * status and the session dates come from the server (`TreatmentSeriesDTO`);
 * nothing here counts visits.
 *
 * Capability note, the same rule as `EncounterSheet`: the caller decides who
 * may open a record here. `VisitsSection` hands it one only under
 * `canManageDomain("profile")`.
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
import type { Encounter } from "@/hooks/use-encounters";
import {
  useTreatmentSeries,
  useTreatmentSeriesMutations,
  type TreatmentSeries,
} from "@/hooks/use-treatment-series";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";

import {
  draftFromSeries,
  emptySeriesDraft,
  seriesDraftToBody,
  todayKey,
  type TreatmentSeriesDraft,
} from "./treatment-series-draft";
import { TreatmentSeriesFields } from "./treatment-series-fields";
import { TreatmentSeriesSessions } from "./treatment-series-sessions";

export function TreatmentSeriesSheet({
  open,
  onOpenChange,
  series,
  onAddSession,
  onOpenSession,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` starts a series; a row opens it. */
  series: TreatmentSeries | null;
  /** Book or file the next session; the caller opens the visit form. */
  onAddSession?: (series: TreatmentSeries) => void;
  /** Open one session in the visit form. */
  onOpenSession?: (visit: Encounter) => void;
}) {
  const { t } = useTranslations();
  const { create, update, remove, restore } = useTreatmentSeriesMutations();
  const isEdit = series !== null;
  const detail = useTreatmentSeries(open && series ? series.id : null);
  const current = detail.data ?? series;

  // Seeded once, at mount; the caller remounts the sheet on every open.
  const [seed] = useState<TreatmentSeriesDraft>(() =>
    series ? draftFromSeries(series) : emptySeriesDraft(),
  );
  const [draft, setDraft] = useState<TreatmentSeriesDraft>(seed);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const patch = (part: Partial<TreatmentSeriesDraft>) =>
    setDraft((prev) => ({ ...prev, ...part }));

  const body = seriesDraftToBody(draft);
  const pending = create.isPending || update.isPending;

  const submit = async () => {
    if (!body) return;
    try {
      if (isEdit) {
        await update.mutateAsync({ id: series.id, body });
        toastWrittenOutcome("success", t("treatmentSeries.updated"));
      } else {
        await create.mutateAsync(body);
        toastWrittenOutcome("success", t("treatmentSeries.created"));
      }
      onOpenChange(false);
    } catch (err) {
      const message = localizedApiError(err, t, "treatmentSeries.saveFailed");
      setError(message);
      showErrorToast(message, { cause: err });
    }
  };

  const setEnded = async (endedOn: string | null) => {
    if (!series) return;
    try {
      await update.mutateAsync({ id: series.id, body: { endedOn } });
      toastWrittenOutcome(
        "success",
        t(endedOn ? "treatmentSeries.ended" : "treatmentSeries.reopened"),
      );
      onOpenChange(false);
    } catch (err) {
      showErrorToast(t("treatmentSeries.saveFailed"), { cause: err });
    }
  };

  const ended = current?.endedOn !== null && current?.endedOn !== undefined;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      dirty={JSON.stringify(draft) !== JSON.stringify(seed)}
      title={
        isEdit
          ? (current?.title ?? t("treatmentSeries.untitled"))
          : t("treatmentSeries.createTitle")
      }
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
            data-slot="treatment-series-save"
            disabled={!body || pending}
            onClick={() => void submit()}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-slot="treatment-series-sheet">
        {isEdit && current ? (
          <TreatmentSeriesSessions
            series={current}
            visits={detail.data?.visits}
            ended={ended}
            onAddSession={onAddSession}
            onOpenSession={onOpenSession}
          />
        ) : null}

        <TreatmentSeriesFields draft={draft} patch={patch} enabled={open} />

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {isEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              data-slot="treatment-series-end"
              disabled={update.isPending}
              onClick={() => void setEnded(ended ? null : todayKey())}
            >
              {t(ended ? "treatmentSeries.reopen" : "treatmentSeries.end")}
            </Button>
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
                  data-slot="treatment-series-delete"
                >
                  <Trash2 className="size-4" aria-hidden />
                  {t("common.delete")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("treatmentSeries.deleteTitle")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("treatmentSeries.deleteDescription")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => {
                      const id = series.id;
                      remove.mutate(id, {
                        onSuccess: () => {
                          onOpenChange(false);
                          toast.success(t("treatmentSeries.deleted"), {
                            action: {
                              label: t("common.undo"),
                              onClick: () =>
                                void restore.mutateAsync(id).catch((failure) =>
                                  showErrorToast(
                                    t("treatmentSeries.saveFailed"),
                                    {
                                      cause: failure,
                                    },
                                  ),
                                ),
                            },
                          });
                        },
                        onError: (failure) =>
                          showErrorToast(t("treatmentSeries.deleteFailed"), {
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
          </div>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}
