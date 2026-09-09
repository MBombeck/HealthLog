"use client";

import { Trash2 } from "lucide-react";

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
 * Shared single-row delete button + confirm dialog for the data-
 * management lists (measurements + mood). Lifted from the two
 * copy-pasted `DeleteButton` helpers (v1.15.13).
 *
 * The confirm copy differs per surface (a measurement vs a mood entry),
 * so the title/description are passed in rather than reaching for a fixed
 * translation key. `cancelLabel` / `confirmLabel` default to the shared
 * `common.*` strings.
 *
 * v1.36.x — this is the one place a row delete is spelled across the app
 * (measurements, lab results, biomarkers, allergies, family history, custom
 * metrics, medication inventory), so the delegation rule is enforced here
 * rather than at twelve call sites. Not disabled when withheld — a greyed bin
 * still claims the row is the delegate's to remove.
 *
 * v1.38.12 — deleting is a MANAGE verb, and whether a MANAGE grant reaches it
 * depends on the section the row belongs to (`domain-write-support.ts`), so
 * the caller names the section and this component asks `canManageDomain` for
 * it. `null` says the row's delete route resolves the caller rather than the
 * record (custom metrics), which no grant reaches at any level.
 */
export function DeleteButton({
  onConfirm,
  title,
  description,
  cancelLabel,
  confirmLabel,
  triggerTitle,
  className = "",
  iconClassName = "h-3.5 w-3.5",
  domain,
}: {
  /** The section the delete route answers under, or `null` for owner-only. */
  domain: ShareDomain | null;
  onConfirm: () => void;
  title: string;
  description: string;
  cancelLabel?: string;
  confirmLabel?: string;
  /** Native hover tooltip on the trigger; defaults to the accessible name. */
  triggerTitle?: string;
  className?: string;
  iconClassName?: string;
}) {
  const { t } = useTranslations();
  const { canManageDomain, inSharedRecord } = useRecordCapabilities();
  const allowed = domain === null ? !inSharedRecord : canManageDomain(domain);
  if (!allowed) return null;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          className={`text-destructive ${className}`}
          aria-label={confirmLabel ?? t("common.delete")}
          title={triggerTitle ?? confirmLabel ?? t("common.delete")}
        >
          <Trash2 className={iconClassName} />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {cancelLabel ?? t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {confirmLabel ?? t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
