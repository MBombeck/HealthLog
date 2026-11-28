"use client";

/**
 * "Verknüpfungen" on the medication's overview: what the detail read's
 * `related[]` lists (its indication, its documents, the visits it was
 * prescribed or reviewed at, and the readings of the marker it targets) as
 * the shared link row, and in the caller's own record the one "Link" button
 * that files the first three. The same tile the condition page shows; no
 * tile at all when there is nothing linked and nothing the viewer may add.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Link2 } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { RelatedRecordsList } from "@/components/links/related-records";
import { Card, CardContent } from "@/components/ui/card";
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
    <Card data-slot="medication-uebersicht-related">
      <CardContent className="space-y-4">
        <TileHeader icon={Link2} title={t("links.related.title")} />
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
      </CardContent>
    </Card>
  );
}
