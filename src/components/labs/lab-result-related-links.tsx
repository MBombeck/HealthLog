"use client";

/**
 * A lab reading's v1.43 relation links in its edit sheet: the records the
 * reading relates to (`related[]` on `GET /api/labs/{id}`, resolved on the
 * server) and the pickers that file the report it was read from and the
 * visit it was drawn at. The pickers write straight through
 * `/api/labs/{id}/links` when picked, independent of the form's Save, the
 * same way the visit sheet's medication and dose pickers do.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RelatedRecordsBlock } from "@/components/links/related-records";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

import type { LabResultDetailDto } from "./types";

export function fetchLabResultDetail(id: string) {
  return apiGet<LabResultDetailDto>(`/api/labs/${encodeURIComponent(id)}`);
}

export function LabResultRelatedLinks({
  labResultId,
  takenAt,
}: {
  labResultId: string;
  takenAt: string | null;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: queryKeys.labResult(labResultId),
    queryFn: () => fetchLabResultDetail(labResultId),
  });
  // The pickers seed from this read; before it lands they would offer an
  // empty selection that the first tap could not compute a change from.
  if (!detail.data) return null;
  const related = detail.data.related;
  return (
    <div className="border-t pt-4 empty:hidden" data-slot="lab-result-related">
      <RelatedRecordsBlock
        key={labResultId}
        related={related}
        edit={{
          linksPath: `/api/labs/${encodeURIComponent(labResultId)}/links`,
          kinds: ["document", "encounter"],
          anchor: takenAt,
          onSaved: () => {
            // The other ends list the reading too: the document's and the
            // visit's sheets seed their pickers from their cached reads, and
            // a condition reaches the reading through the visit.
            for (const queryKey of [
              queryKeys.labResult(labResultId),
              queryKeys.documents(),
              queryKeys.encounters(),
              queryKeys.illness(),
            ]) {
              void qc.invalidateQueries({ queryKey });
            }
          },
        }}
      />
    </div>
  );
}
