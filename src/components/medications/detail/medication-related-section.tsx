"use client";

/**
 * The medication's "Verwandt" section on the overview tab: what the detail
 * read's `related[]` lists (its indication, its documents, the visits it was
 * prescribed or reviewed at, and the readings of the marker it targets), and
 * in the caller's own record the pickers that file the first three.
 */
import { useQueryClient } from "@tanstack/react-query";

import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { RelatedRecordsList } from "@/components/links/related-records";
import {
  useRecordCapabilities,
  holdsOwnerRights,
} from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { RelatedLink } from "@/lib/links/related";

export function MedicationRelatedSection({
  medicationId,
  startsOn,
  related,
}: {
  medicationId: string;
  startsOn: string | null;
  related: RelatedLink[] | undefined;
}) {
  const { t } = useTranslations();
  const qc = useQueryClient();
  // Empty and nothing to add: only for someone without the owner's rights.
  const ownerRights = holdsOwnerRights(useRecordCapabilities());
  if ((related ?? []).length === 0 && !ownerRights) return null;
  return (
    <MedicationDetailSection
      titleId="medication-uebersicht-related-heading"
      title={t("links.related.title")}
      dataSlot="medication-uebersicht-related"
    >
      <RelatedRecordsList
        key={medicationId}
        related={related}
        edit={{
          linksPath: `/api/medications/${encodeURIComponent(medicationId)}/links`,
          kinds: ["conditionEpisode", "document", "encounter"],
          anchor: startsOn,
          onSaved: () => {
            // The other end lists the medication too: every kind the
            // pickers file (episode, document, visit) reads it back on its
            // own detail, so each one's prefix goes stale.
            for (const queryKey of [
              queryKeys.medicationDetail(medicationId),
              queryKeys.illness(),
              queryKeys.documents(),
              queryKeys.encounters(),
            ]) {
              void qc.invalidateQueries({ queryKey });
            }
          },
        }}
      />
    </MedicationDetailSection>
  );
}
