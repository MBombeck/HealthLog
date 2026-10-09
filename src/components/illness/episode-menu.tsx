"use client";

/**
 * v1.18.1 — shared illness-episode overflow menu (mirrors the medication
 * card menu): one kebab folding Edit / Mark recovered / Delete. Delete is
 * gated behind an AlertDialog (every destructive peer guards this; an episode
 * delete cascades its day-logs + encrypted notes, so a single unguarded tap
 * was the Medium finding). Neutral throughout.
 */
import { useState } from "react";
import { MoreVertical, Pencil, CheckCircle2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useTranslations } from "@/lib/i18n/context";

import { useDeleteEpisode, useRestoreEpisode } from "./use-illness";
import type { IllnessEpisodeDTO } from "./types";

export interface EpisodeMenuProps {
  episode: IllnessEpisodeDTO;
  onEdit: () => void;
  /** Provided only when the episode is active + non-chronic. */
  onResolve?: () => void;
  resolving?: boolean;
  /** Called after a confirmed delete (e.g. navigate back from a detail page). */
  onDeleted?: () => void;
}

export function EpisodeMenu({
  episode,
  onEdit,
  onResolve,
  resolving,
  onDeleted,
}: EpisodeMenuProps) {
  const { t } = useTranslations();
  const del = useDeleteEpisode();
  const restore = useRestoreEpisode();
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function handleConfirmDelete() {
    try {
      await del.mutateAsync(episode.id);
      setConfirmOpen(false);
      onDeleted?.();
      // Soft-delete keeps the episode + its day-logs intact, so the delete is
      // reversible. Surface an Undo toast wired to the restore route (the labs
      // delete+undo UX).
      toast.success(t("illness.deletedToast"), {
        action: {
          label: t("common.undo"),
          onClick: () => {
            restore.mutate(episode.id, {
              onError: () => toast.error(t("illness.restoreError")),
            });
          },
        },
      });
    } catch {
      // Keep the dialog open; the list will surface any error on next read.
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 sm:size-9"
            aria-label={t("illness.menu.label")}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="h-4 w-4" />
            {t("common.edit")}
          </DropdownMenuItem>
          {onResolve ? (
            <DropdownMenuItem onSelect={onResolve} disabled={resolving}>
              <CheckCircle2 className="h-4 w-4" />
              {t("illness.markRecovered")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setConfirmOpen(true);
            }}
          >
            <Trash2 className="h-4 w-4" />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("illness.deleteConfirm.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("illness.deleteConfirm.body", { label: episode.label })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={del.isPending}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
