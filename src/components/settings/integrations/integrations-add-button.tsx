"use client";

/**
 * "Add" in the Integrations page header. Kept apart from the section so the
 * settings shell can place it without loading the section's code: it only
 * writes `?add=1`, which the section reads to open its sheet.
 */
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { writeUrlState } from "@/lib/url-state";

export function openIntegrationsAdd(open: boolean) {
  writeUrlState((params) => {
    if (open) params.set("add", "1");
    else params.delete("add");
  });
}

export function IntegrationsAddButton() {
  const { t } = useTranslations();
  return (
    <Button
      type="button"
      size="sm"
      className="min-h-11 sm:min-h-9"
      onClick={() => openIntegrationsAdd(true)}
      data-testid="integrations-add"
    >
      <Plus className="size-4" aria-hidden="true" />
      {t("common.add")}
    </Button>
  );
}
