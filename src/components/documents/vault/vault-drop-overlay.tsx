import { UploadCloud } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";

/**
 * The page-wide drop overlay. Pure decoration (aria-hidden): the intake
 * announces through the page's live region.
 */
export function VaultDropOverlay() {
  const { t } = useTranslations();
  return (
    <div
      aria-hidden
      data-slot="document-drop-overlay"
      className="bg-background/80 fixed inset-0 z-50 p-4 backdrop-blur-sm md:p-8"
    >
      <div className="border-primary bg-primary/5 flex h-full items-center justify-center rounded-xl border-2 border-dashed">
        <div className="flex flex-col items-center gap-2 px-4 text-center">
          <UploadCloud className="text-primary size-8" aria-hidden />
          <p className="text-base font-medium">
            {t("documents.dropOverlay.title")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("documents.dropOverlay.hint")}
          </p>
        </div>
      </div>
    </div>
  );
}
