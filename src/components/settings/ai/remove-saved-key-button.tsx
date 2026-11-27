"use client";

/**
 * Removes the stored API key of one personal AI provider.
 *
 * Every provider form showed a saved key and offered no way to take it back:
 * saving with the key field empty keeps the stored key, by design, so a key
 * once entered stayed until the account was deleted. `PATCH
 * /api/user/ai-provider` has always cleared a key sent as `null`; this is the
 * control for it, shared by the four forms that hold a personal key so each
 * asks the same question and reports the same way.
 *
 * It stands beside the key field it clears, as a secondary button, not in
 * the card's action row: a red "remove" next to "Save" read as the card's
 * other main action. The confirmation stays destructive.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { apiPatch } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { aiInputDependentKeys, invalidateKeys } from "@/lib/query-keys";

/** The PATCH field that holds each provider's personal key. */
export type SavedKeyField =
  "openaiKey" | "anthropicKey" | "localKey" | "compatKey";

/**
 * The body that clears exactly one key and touches nothing else: not the
 * provider choice, the model or the base URL, which stay as they were.
 */
export function removeSavedKeyBody(
  field: SavedKeyField,
): Partial<Record<SavedKeyField, null>> {
  return { [field]: null };
}

export function RemoveSavedKeyButton({ field }: { field: SavedKeyField }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: () =>
      apiPatch("/api/user/ai-provider", removeSavedKeyBody(field)),
    onSuccess: () => {
      void invalidateKeys(queryClient, aiInputDependentKeys);
      toastWrittenOutcome("success", t("settings.ai.removeKey.done"));
    },
    onError: (failure) =>
      showErrorToast(t("settings.ai.removeKey.failed"), { cause: failure }),
  });

  return (
    <ConfirmButton
      slot={`settings-ai-remove-key-${field}`}
      destructive
      variant="outline"
      size="sm"
      className="min-h-11 shrink-0 sm:min-h-9"
      icon={<Trash2 className="size-4" aria-hidden />}
      label={t("settings.ai.removeKey.label")}
      title={t("settings.ai.removeKey.title")}
      body={t("settings.ai.removeKey.body")}
      confirmLabel={t("settings.ai.removeKey.confirm")}
      pending={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  );
}
