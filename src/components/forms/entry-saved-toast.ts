"use client";

import { toast } from "sonner";

import { showErrorToast } from "@/lib/errors/error-toast";
import type { useTranslations } from "@/lib/i18n/context";

type Translate = ReturnType<typeof useTranslations>["t"];

/**
 * The receipt every quick-entry form shows after a save: what was saved, in
 * words ("Weight 82.3 kg saved", "Headache saved"), the record it went to
 * when somebody logs for another person, and an Undo that removes the entry
 * again through its ordinary delete route. A typo noticed a second later is
 * then one tap, not a hunt through the list.
 *
 * Undo is offered only when the caller can delete (`undo` is omitted for a
 * delegate who may write but not manage): an Undo that the server refuses is
 * worse than none.
 */
export function showEntrySavedToast({
  t,
  label,
  value,
  recordName,
  undo,
}: {
  t: Translate;
  /** What was logged: the type, symptom or "Mood". */
  label: string;
  /** The formatted reading with its unit; omitted for an entry without one. */
  value?: string;
  /** The record the entry went to, when it is not the person's own. */
  recordName?: string | null;
  /** Removes what was just saved; resolves once the server has. */
  undo?: () => Promise<unknown>;
}): void {
  const title = value
    ? t("common.savedWithValue", { label, value })
    : t("common.savedNamed", { label });
  toast.success(title, {
    description: recordName
      ? t("recordSharing.toast.savedTo", { name: recordName })
      : undefined,
    action: undo
      ? {
          label: t("common.undo"),
          onClick: () => {
            undo().then(
              () => toast(t("common.entryUndone")),
              (cause: unknown) =>
                showErrorToast(t("common.entryUndoFailed"), { cause }),
            );
          },
        }
      : undefined,
  });
}
