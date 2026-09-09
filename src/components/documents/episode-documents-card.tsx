"use client";

/**
 * The "Dokumente" section on an illness-episode detail page — the
 * condition side of the condition ⇄ documents linking (the document side
 * links back via the detail sheet's condition chips). Lists the episode's
 * most recent linked documents as compact rows deep-linking straight into
 * the vault (`?episode=…&doc=…` opens the detail sheet), plus the three
 * affordances: link an existing document, upload pre-linked (deep link
 * with the episode filter active — the vault threads it into the upload),
 * and the filtered "show all" view.
 *
 * Renders nothing when the documents module is off for this account —
 * module-gated surfaces never leak. An episode without documents shows a
 * quiet one-line affordance, not a teaching empty state.
 */
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Link2, Upload } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { TileHeader } from "@/components/insights/tile-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import { DocumentLinkPicker } from "./document-link-picker";
import { DOCUMENT_KIND_ICONS } from "./document-kind-meta";
import { documentDateKey } from "./vault-utils";

/** Compact preview size — "Alle anzeigen" carries the long tail. */
const PREVIEW_LIMIT = 5;

interface ListPage {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
}

export function EpisodeDocumentsCard({ episodeId }: { episodeId: string }) {
  const { t } = useTranslations();
  const format = useFormatters();
  const { user } = useAuth();
  // Linking a document to an episode writes through
  // `POST /api/documents/inbound/bulk`, the same endpoint the vault gates on
  // `canManageDocuments` throughout. The episode side of the same link had no gate at
  // all, so the vault refused what this card offered. Reading the linked
  // documents stays: the list rows and "show all" are pure navigation.
  const { canManageDomain } = useRecordCapabilities();
  const canManageDocuments = canManageDomain("documents");
  const [pickerOpen, setPickerOpen] = useState(false);

  const moduleEnabled = user?.modules?.inboundDocuments === true;

  const list = useQuery({
    queryKey: queryKeys.inboundDocumentEpisodePreview(episodeId),
    enabled: moduleEnabled,
    queryFn: () => {
      const sp = new URLSearchParams();
      sp.set("episodeId", episodeId);
      sp.set("sort", "documentDate");
      sp.set("order", "desc");
      sp.set("limit", String(PREVIEW_LIMIT + 1));
      return apiGet<ListPage>(`/api/documents/inbound?${sp.toString()}`);
    },
  });

  if (!moduleEnabled) return null;

  if (list.isError) {
    return (
      <QueryErrorCard
        title={t("documents.episodeCard.loadError")}
        onRetry={() => void list.refetch()}
      />
    );
  }

  const documents = (list.data?.documents ?? []).slice(0, PREVIEW_LIMIT);
  const hasMore =
    (list.data?.documents.length ?? 0) > PREVIEW_LIMIT ||
    list.data?.nextCursor != null;
  const vaultHref = `/documents?episode=${encodeURIComponent(episodeId)}`;

  return (
    <>
      <Card data-slot="episode-documents-card">
        <CardContent className="space-y-4">
          <TileHeader
            icon={FolderOpen}
            title={t("documents.episodeCard.title")}
            right={
              documents.length > 0 ? (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {documents.length}
                  {hasMore ? "+" : ""}
                </span>
              ) : undefined
            }
          />

          {list.isPending ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          ) : documents.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("documents.episodeCard.emptyLine")}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {documents.map((doc) => {
                const title =
                  doc.title ?? doc.filename ?? t("documents.card.untitled");
                const Icon = DOCUMENT_KIND_ICONS[doc.kind];
                return (
                  <li key={doc.id}>
                    <ListRow asChild>
                      <Link
                        href={`${vaultHref}&doc=${encodeURIComponent(doc.id)}`}
                        className="hover:bg-muted/50 focus-visible:ring-ring/50 flex items-center gap-3 focus-visible:ring-[3px] focus-visible:outline-none"
                      >
                        <Icon
                          className="text-foreground size-5 shrink-0"
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {title}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {format.date(`${documentDateKey(doc)}T12:00:00.000Z`)}
                        </span>
                      </Link>
                    </ListRow>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            {canManageDocuments ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPickerOpen(true)}
                >
                  <Link2 className="size-4" aria-hidden />
                  {t("documents.episodeCard.link")}
                </Button>
                {/* The upload affordance is a deep link into the vault with
                    this episode pre-filtered. The vault's own upload control
                    is `canManageDocuments`-gated, so an ungated link here would send a
                    delegate to a page with nothing to press. */}
                <Button asChild variant="outline" size="sm">
                  <Link href={vaultHref}>
                    <Upload className="size-4" aria-hidden />
                    {t("documents.episodeCard.upload")}
                  </Link>
                </Button>
              </>
            ) : null}
            {hasMore ? (
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="text-muted-foreground ml-auto"
              >
                <Link href={vaultHref}>
                  {t("documents.episodeCard.viewAll")}
                </Link>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {canManageDocuments ? (
        <DocumentLinkPicker
          episodeId={episodeId}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        />
      ) : null}
    </>
  );
}
