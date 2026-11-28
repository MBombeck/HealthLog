"use client";

/**
 * "New token" in the API & tokens page header. Kept apart from the section so
 * the settings shell can place it without loading the section's code: it
 * only writes `?new-token=1`, which the section reads to open its sheet.
 */
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { writeUrlState } from "@/lib/url-state";

export const NEW_TOKEN_PARAM = "new-token";

export function openNewToken(open: boolean) {
  writeUrlState((params) => {
    if (open) params.set(NEW_TOKEN_PARAM, "1");
    else params.delete(NEW_TOKEN_PARAM);
  });
}

export function ApiNewTokenButton() {
  const { t } = useTranslations();
  return (
    <Button
      type="button"
      size="sm"
      className="min-h-11 sm:min-h-9"
      onClick={() => openNewToken(true)}
      data-testid="api-new-token"
    >
      <Plus className="size-4" aria-hidden="true" />
      {t("settings.tokenList.newToken")}
    </Button>
  );
}
