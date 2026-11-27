"use client";

/**
 * "Verknüpfungen" on a condition's page: its documents, its visits and
 * whatever else the server relates it to (the medications that treat it, the
 * lab results it shares a visit with), as one row of chips in one tile.
 *
 * It replaces three tiles (documents, visits, related) that each wrote a
 * line of their own when they had nothing to show. An absence now takes no
 * line: a condition with no links and nothing the viewer may add shows no
 * tile at all, and one the viewer may add to shows the tile with its button.
 *
 * The documents are the newest few, each opening the vault filtered to the
 * condition with the document's sheet on top; "Show all" opens the filtered
 * vault when there are more. The visits are the ones filed against the
 * condition, read from the condition side ONLY: an episode spans weeks and a
 * visit is a point, so a match from the visit side would be wrong often
 * enough to teach the person to ignore every suggestion. Adding a visit here
 * creates one pre-linked instead of guessing.
 *
 * Each family keeps its gate. Documents need the documents module, and
 * linking or uploading needs `canManageDomain("documents")` (the vault's own
 * gate, so this tile never offers what the vault refuses). A new visit is a
 * `POST /api/encounters`, which answers at WRITE on the profile.
 */
import { useDocumentDate } from "@/components/documents/use-document-date";
import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DocumentLinkPicker } from "@/components/documents/document-link-picker";
import { ImportFromSourceButton } from "@/components/documents/sources/import-from-source-button";
import { EncounterSheet } from "@/components/encounters/encounter-sheet";
import { encounterKindText } from "@/components/encounters/encounter-labels";
import { TileHeader } from "@/components/insights/tile-header";
import {
  RecordLinkAddButton,
  RecordLinksRow,
  relatedChips,
  type RecordLinkAddOption,
  type RecordLinkChipData,
} from "@/components/links/record-links";
import { Card, CardContent } from "@/components/ui/card";
import { InlineAction } from "@/components/ui/inline-action";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useCalendarDate } from "@/hooks/use-calendar-date";
import { useEncounters } from "@/hooks/use-encounters";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import { careVisitPath } from "@/lib/encounters/visit-links";
import { pageHref } from "@/lib/links/hrefs";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { RelatedLink } from "@/lib/links/related";
import { queryKeys } from "@/lib/query-keys";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import type { EncounterKind } from "@/generated/prisma/client";

/** The newest documents shown as chips; "Show all" carries the rest. */
const DOCUMENT_PREVIEW_LIMIT = 5;

interface ListPage {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
}

export function EpisodeLinksCard({
  episodeId,
  related,
}: {
  episodeId: string;
  related: readonly RelatedLink[] | undefined;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const calendarDate = useCalendarDate();
  const documentDate = useDocumentDate();
  const router = useRouter();
  const { user } = useAuth();
  const { canManageDomain, canWriteDomain } = useRecordCapabilities();
  const documentsOn = user?.modules?.inboundDocuments === true;
  const illnessOn = user?.modules?.illness === true;
  const canManageDocuments = documentsOn && canManageDomain("documents");
  const canAddVisit = illnessOn && canWriteDomain("profile");

  const [documentPickerOpen, setDocumentPickerOpen] = useState(false);
  const [visitSheetOpen, setVisitSheetOpen] = useState(false);
  const [visitSession, setVisitSession] = useState(0);

  const documents = useQuery({
    queryKey: queryKeys.inboundDocumentEpisodePreview(episodeId),
    enabled: documentsOn,
    queryFn: () => {
      const sp = new URLSearchParams();
      sp.set("episodeId", episodeId);
      sp.set("sort", "documentDate");
      sp.set("order", "desc");
      sp.set("limit", String(DOCUMENT_PREVIEW_LIMIT + 1));
      return apiGet<ListPage>(`/api/documents/inbound?${sp.toString()}`);
    },
  });
  // The filter runs in SQL: the two arms of the response are separately
  // bounded, so narrowing here would page wrongly on a long history.
  const visits = useEncounters(illnessOn, { episodeId });

  const vaultHref = `${pageHref("documents")}?episode=${encodeURIComponent(episodeId)}`;
  const shownDocuments = (documents.data?.documents ?? []).slice(
    0,
    DOCUMENT_PREVIEW_LIMIT,
  );
  const moreDocuments =
    (documents.data?.documents.length ?? 0) > DOCUMENT_PREVIEW_LIMIT ||
    documents.data?.nextCursor != null;
  const visitList = [
    ...(visits.data?.upcoming ?? []),
    ...(visits.data?.past ?? []),
  ];

  const chips: RecordLinkChipData[] = [
    ...(documentsOn ? shownDocuments : []).map((doc) => ({
      kind: "document" as const,
      id: doc.id,
      label: doc.title ?? doc.filename ?? t("documents.card.untitled"),
      dateLabel: documentDate(doc),
      href: `${vaultHref}&doc=${encodeURIComponent(doc.id)}`,
    })),
    ...(illnessOn ? visitList : []).map((visit) => ({
      kind: "encounter" as const,
      id: visit.id,
      label:
        visit.practitioner?.name ??
        encounterKindText(t, visit.kind as EncounterKind),
      dateLabel: format.date(visit.occurredAt),
      href: careVisitPath(visit.id),
    })),
    ...relatedChips(t, format, calendarDate, related, [
      "document",
      "encounter",
    ]),
  ];

  const addOptions: RecordLinkAddOption[] = [];
  if (canManageDocuments) {
    addOptions.push({
      key: "document-link",
      kind: "document",
      onSelect: () => setDocumentPickerOpen(true),
    });
    // Uploading opens the vault filtered to this condition; the vault
    // threads the filter into the upload, so the new file arrives linked.
    addOptions.push({
      key: "document-upload",
      kind: "document",
      label: t("links.row.uploadDocument"),
      onSelect: () => router.push(vaultHref),
    });
  }
  if (canAddVisit) {
    addOptions.push({
      key: "visit-new",
      kind: "encounter",
      label: t("encounters.episodeCard.add"),
      onSelect: () => {
        setVisitSheetOpen(true);
        setVisitSession((n) => n + 1);
      },
    });
  }

  const pending =
    (documentsOn && documents.isPending) || (illnessOn && visits.isPending);
  const status = (
    <>
      {documentsOn && documents.isError ? (
        <QueryErrorRow
          inset
          error={documents.error}
          message={t("documents.episodeCard.loadError")}
          onRetry={() => void documents.refetch()}
        />
      ) : null}
      {illnessOn && visits.isError ? (
        <QueryErrorRow
          inset
          error={visits.error}
          message={t("encounters.loadError")}
          onRetry={() => void visits.refetch()}
        />
      ) : null}
    </>
  );
  const failed =
    (documentsOn && documents.isError) || (illnessOn && visits.isError);

  if (!pending && !failed && chips.length === 0 && addOptions.length === 0) {
    return null;
  }

  return (
    <>
      <Card data-slot="episode-links-card">
        <CardContent className="space-y-4">
          <TileHeader icon={Link2} title={t("links.related.title")} />
          <RecordLinksRow
            slot="episode-links"
            labelled={false}
            chips={chips}
            status={
              pending ? (
                <div className="flex flex-wrap gap-1.5">
                  <Skeleton className="h-8 w-40 rounded-full" />
                  <Skeleton className="h-8 w-28 rounded-full" />
                </div>
              ) : failed ? (
                status
              ) : undefined
            }
            add={
              addOptions.length > 0 || moreDocuments ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <RecordLinkAddButton
                    options={addOptions}
                    slot="episode-links"
                  />
                  {canManageDocuments ? (
                    <ImportFromSourceButton
                      className="h-8 rounded-full text-xs"
                      link={{ kind: "conditionEpisode", id: episodeId }}
                    />
                  ) : null}
                  {moreDocuments ? (
                    <InlineAction asChild tone="muted" size="xs">
                      <Link href={vaultHref} data-slot="episode-links-all">
                        {t("documents.episodeCard.viewAll")}
                      </Link>
                    </InlineAction>
                  ) : null}
                </span>
              ) : undefined
            }
          />
        </CardContent>
      </Card>

      {canManageDocuments ? (
        <DocumentLinkPicker
          episodeId={episodeId}
          open={documentPickerOpen}
          onOpenChange={setDocumentPickerOpen}
        />
      ) : null}
      {canAddVisit ? (
        <EncounterSheet
          key={visitSession}
          open={visitSheetOpen}
          onOpenChange={setVisitSheetOpen}
          encounter={null}
          // Pre-linked, so the person never has to find this condition again
          // in a picker they already navigated away from.
          episodeId={episodeId}
        />
      ) : null}
    </>
  );
}
