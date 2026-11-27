"use client";

/**
 * The visit sheet's v1.43 relation links: the medications prescribed,
 * changed or reviewed at the visit and the doses given there, plus whatever
 * else the visit relates to that the form above does not already pick.
 *
 * Unlike the form's documents, lab results and conditions (a replace-set sent
 * with Save), these two write straight through the visit's links route when
 * picked, so they need a saved visit and render in edit mode only.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RelatedRecordsBlock } from "@/components/links/related-records";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { RelatedLink } from "@/lib/links/related";

export function EncounterRelatedLinks({
  encounterId,
  occurredAt,
}: {
  encounterId: string;
  occurredAt: string | null;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: queryKeys.encounter(encounterId),
    queryFn: () =>
      apiGet<{ related?: RelatedLink[] }>(
        `/api/encounters/${encodeURIComponent(encounterId)}`,
      ),
  });
  // The pickers seed from this read; before it lands they would offer an
  // empty selection that the first tap could not compute a change from.
  if (!detail.data) return null;
  const related = detail.data.related;
  return (
    <div className="border-t pt-4 empty:hidden" data-slot="encounter-related">
      <RelatedRecordsBlock
        key={encounterId}
        related={related}
        omitKinds={["document", "labResult", "conditionEpisode"]}
        edit={{
          linksPath: `/api/encounters/${encodeURIComponent(encounterId)}/links`,
          kinds: ["medication", "vaccination"],
          anchor: occurredAt,
          onSaved: () => {
            // The other end lists the visit too.
            for (const queryKey of [
              queryKeys.encounter(encounterId),
              queryKeys.medications(),
              queryKeys.vaccinations(),
            ]) {
              void qc.invalidateQueries({ queryKey });
            }
          },
        }}
      />
    </div>
  );
}
