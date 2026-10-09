"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Trash2 } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, apiDelete, apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { moodTagIcon } from "../mood-tag-icons";
import {
  invalidateMoodTagCaches,
  removeTag,
  setTagArchived,
  snapshotManageCache,
  tagDisplayName,
  updateManageCache,
  type ManageCatalog,
  type ManageTag,
} from "./use-mood-tag-manage";

/**
 * v1.17 — archived custom tags for `/settings/mood`. Archiving keeps
 * every historical entry resolving the tag's label (the 0126 retire
 * precedent: reads join by id without the active filter) — the card
 * copy says so explicitly. Restore flips `isActive` back (the server
 * re-checks the 50-tag cap). The hard delete sits behind an explicit
 * confirm dialog that names the number of past entries the purge will
 * strip the tag from; the FK cascade removes those links for good.
 */

interface ArchivedTagsCardProps {
  catalog: ManageCatalog;
}

/** Every archived custom tag across the tree, in tree order. */
export function archivedTags(catalog: ManageCatalog): ManageTag[] {
  return catalog.categories.flatMap((category) =>
    category.tags.filter((tag) => tag.archived === true),
  );
}

export function ArchivedTagsCard({ catalog }: ArchivedTagsCardProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [purgeTag, setPurgeTag] = useState<ManageTag | null>(null);

  const archived = archivedTags(catalog);

  async function restore(tag: ManageTag) {
    const rollback = await snapshotManageCache(queryClient);
    updateManageCache(queryClient, (c) => setTagArchived(c, tag.key, false));
    try {
      await apiPatch(`/api/mood/tags/custom/${encodeURIComponent(tag.key)}`, {
        isActive: true,
      });
      toast.success(t("common.saved"));
    } catch (err) {
      rollback();
      if (err instanceof ApiError && err.status === 422) {
        toast.error(t("mood.manage.tagLimitReached"));
      } else {
        toast.error(err instanceof ApiError ? err.message : t("common.error"));
      }
    } finally {
      void invalidateMoodTagCaches(queryClient);
    }
  }

  async function purge(tag: ManageTag) {
    const rollback = await snapshotManageCache(queryClient);
    updateManageCache(queryClient, (c) => removeTag(c, tag.key));
    try {
      await apiDelete(
        `/api/mood/tags/custom/${encodeURIComponent(tag.key)}?purge=true`,
      );
      toast.success(t("mood.manage.purged"));
    } catch (err) {
      rollback();
      toast.error(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      void invalidateMoodTagCaches(queryClient);
    }
  }

  return (
    <div className="space-y-3" data-slot="mood-archived-tags-card">
      <p className="text-muted-foreground text-xs">
        {t("mood.manage.archivedDescription")}
      </p>

      {archived.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-slot="mood-archived-empty"
        >
          {t("mood.manage.archivedEmpty")}
        </p>
      ) : (
        <div className="space-y-2">
          {archived.map((tag) => {
            const Icon = moodTagIcon(tag.icon);
            const name = tagDisplayName(tag, t);
            return (
              <div
                key={tag.key}
                data-slot="mood-archived-row"
                data-tag={tag.key}
                className="border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2"
              >
                <Icon
                  className="text-muted-foreground h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <span
                  className="text-foreground/75 min-w-0 flex-1 truncate text-sm"
                  title={name}
                >
                  {name}
                </span>
                {typeof tag.usageCount === "number" && tag.usageCount > 0 && (
                  <Badge variant="secondary" className="tabular-nums">
                    {t("mood.manage.usageCount", {
                      count: String(tag.usageCount),
                    })}
                  </Badge>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => void restore(tag)}
                >
                  <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                  {t("mood.manage.restore")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground size-11 sm:size-9"
                  onClick={() => setPurgeTag(tag)}
                  aria-label={`${t("mood.manage.purgeAction")}: ${name}`}
                  title={t("mood.manage.purgeAction")}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog
        open={purgeTag !== null}
        onOpenChange={(open) => {
          if (!open) setPurgeTag(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("mood.manage.purgeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("mood.manage.purgeBody", {
                count: String(purgeTag?.usageCount ?? 0),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const tag = purgeTag;
                setPurgeTag(null);
                if (tag) void purge(tag);
              }}
            >
              {t("mood.manage.purgeAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
