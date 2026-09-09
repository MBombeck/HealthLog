"use client";

import { Loader2, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { useTranslations } from "@/lib/i18n/context";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import type { ShareDomain } from "@/lib/sharing/scope";

/**
 * Selection action bar for the data-management lists (measurements +
 * mood). Appears when ≥1 row on the current page is selected; shows
 * "N selected", a destructive "Delete (N)" button gated behind an
 * AlertDialog confirm, and a clear-selection affordance.
 *
 * Pure / presentational: every behaviour is a callback. The component
 * renders nothing when `count === 0`. The bar is sticky to the bottom of
 * the viewport so it stays reachable while scrolling a long page, and the
 * confirm dialog is focus-trapped by the shared `AlertDialog` primitive.
 *
 * The confirm copy is passed in because the title/body differ per surface
 * (measurements vs mood) and the count is interpolated by the caller.
 *
 * v1.36.x — bulk delete is a MANAGE verb, so the bar is absent inside somebody
 * else's record below that level. The row checkboxes that feed it are dropped
 * at their lists for the same reason; this guard is the backstop, so a list
 * that forgets cannot leave a delete button floating over the page.
 *
 * v1.38.12 — the caller names the section its bulk route answers under, and
 * the bar asks `canManageDomain` for it; `null` marks an owner-only route.
 */
export function SelectionActionBar({
  count,
  onClear,
  onConfirmDelete,
  isDeleting,
  confirmTitle,
  confirmBody,
  domain,
}: {
  /** The section the bulk-delete route answers under, or `null` for owner-only. */
  domain: ShareDomain | null;
  count: number;
  onClear: () => void;
  onConfirmDelete: () => void;
  isDeleting: boolean;
  confirmTitle: string;
  confirmBody: string;
}) {
  const { t } = useTranslations();
  const { canManageDomain, inSharedRecord } = useRecordCapabilities();
  const allowed = domain === null ? !inSharedRecord : canManageDomain(domain);

  if (count <= 0 || !allowed) return null;

  return (
    <div
      role="region"
      aria-label={t("dataList.selectionBarLabel")}
      // v1.16.8 — the Coach FAB watches for this slot via a CSS
      // `:has()` gate and yields while the bar is mounted, so the
      // floating launcher never sits over the delete action.
      data-slot="selection-action-bar"
      // v1.15.13 HIGH-1 — on mobile the fixed bottom-nav (64px, `md:hidden`,
      // z-50) plus the iOS home-indicator inset sit over the page's lower
      // edge. A `sticky bottom-2` bar lands BEHIND the nav, hiding the
      // destructive "Delete (N)" button. Lift the bar to clear the nav band
      // + safe area using the same offset the Coach FAB uses
      // (`layout-coach-fab.tsx`); the nav only hides from `md:` up
      // (`md:hidden`), so the drop back to `bottom-4` happens at `md:` —
      // an `sm:` drop sat the bar behind the still-visible nav 640-767px.
      // z-30 keeps the bar above page content without needing to beat the
      // (now-cleared) nav's z-50.
      className="bg-card border-border sticky bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] z-30 mt-2 flex items-center justify-between gap-2 rounded-lg border p-2 shadow-lg md:bottom-4"
    >
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          onClick={onClear}
          disabled={isDeleting}
          aria-label={t("dataList.clearSelection")}
        >
          <X className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium" aria-live="polite">
          {t("dataList.selected", { count: String(count) })}
        </span>
      </div>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="destructive"
            size="sm"
            className="min-h-11"
            disabled={isDeleting}
          >
            {isDeleting ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {t("dataList.deleteN", { count: String(count) })}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{confirmBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={onConfirmDelete}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
