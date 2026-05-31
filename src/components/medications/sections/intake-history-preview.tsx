"use client";

/**
 * v1.5.5 D-3 §9.5 — Intake-history preview.
 *
 * Section chrome via `<MedicationDetailSection>`. Header CTA carries a
 * CSV-import trigger. The body re-uses the shared
 * `<IntakeHistoryEditable>` (extracted in v1.7.0) so the table + sort +
 * pagination + multi-select bulk-delete + per-row edit/delete stay
 * identical between this preview and the full-history view.
 *
 * v1.7.0 — the footer "View full history →" link is gone; the detail
 * header's History button now routes directly to the full view, so the
 * redundant link is removed (R-medui §4.3).
 */

import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IntakeHistoryEditable } from "@/components/medications/intake-history-editable";
import { IntakeImportDialog } from "@/components/medications/intake-import-dialog";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { useTranslations } from "@/lib/i18n/context";

export interface IntakeHistoryPreviewProps {
  medicationId: string;
  importOpen: boolean;
  onImportOpenChange: (open: boolean) => void;
}

export function IntakeHistoryPreview({
  medicationId,
  importOpen,
  onImportOpenChange,
}: IntakeHistoryPreviewProps) {
  const { t } = useTranslations();

  return (
    <>
      <MedicationDetailSection
        titleId="medication-detail-intake-history-heading"
        title={t("medications.detail.intake.title")}
        dataSlot="medication-detail-intake-history-section"
        headerExtras={
          <Button
            variant="outline"
            size="sm"
            onClick={() => onImportOpenChange(true)}
            className="min-h-11 sm:min-h-9"
            data-slot="intake-history-import"
          >
            <Upload aria-hidden="true" className="h-4 w-4" />
            {t("medications.detail.intake.importButton")}
          </Button>
        }
      >
        <IntakeHistoryEditable medicationId={medicationId} pageSize={14} />
      </MedicationDetailSection>

      {importOpen && (
        <IntakeImportDialog
          medicationId={medicationId}
          onClose={() => onImportOpenChange(false)}
        />
      )}
    </>
  );
}
