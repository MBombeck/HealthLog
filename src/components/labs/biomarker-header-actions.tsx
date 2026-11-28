"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiDelete } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, labDependentKeys } from "@/lib/query-keys";

const ICON_BUTTON = "min-h-11 min-w-11 sm:min-h-9 sm:min-w-9";

/**
 * The marker's own controls in the detail page header: one overflow menu
 * that holds Edit and Delete. Delete removes the marker and every reading under
 * it, so it no longer sits as a same-size icon next to Edit, where a slip of
 * the thumb was the most expensive tap on the page; it is one menu away and
 * still asks first. Hide (in the edit sheet) stays the reversible way out.
 *
 * Rendered only for a caller who may manage the labs section; a delegate who
 * may only add results sees neither control.
 */
export function BiomarkerHeaderActions({
  biomarkerId,
  canEdit,
  onEdit,
}: {
  biomarkerId: string;
  /** False until the marker has loaded. */
  canEdit: boolean;
  onEdit: () => void;
}) {
  // One "⋯" beside the page's one button: Edit, then Delete, which still
  // asks first. Edit stood as an icon of its own beside it.
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const deleteMarker = useMutation({
    mutationFn: () => apiDelete(`/api/biomarkers/${biomarkerId}`),
    onSuccess: () => {
      toast.success(t("labs.biomarker.deletedToast"));
      void invalidateKeys(queryClient, labDependentKeys);
      router.push("/labs");
    },
    onError: (failure) =>
      showErrorToast(t("labs.biomarker.deleteError"), { cause: failure }),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            aria-label={t("common.moreOptions")}
            title={t("common.moreOptions")}
            data-slot="biomarker-more-actions"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit} disabled={!canEdit}>
            <Pencil className="size-4" aria-hidden="true" />
            {t("labs.biomarker.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirmOpen(true)}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            {t("labs.biomarker.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("labs.biomarker.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("labs.biomarker.deleteConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleteMarker.mutate()}
            >
              {t("labs.biomarker.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
