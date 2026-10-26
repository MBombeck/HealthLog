"use client";

/**
 * Recently deleted — the vault's deleted documents, until the nightly purge
 * removes them for good.
 *
 * Deleting in the vault only sets a tombstone; for 30 days the document can
 * come back. Before this page the only way back was the undo toast, which is
 * gone a few seconds after the delete. Each row says what the document was
 * (title, type, filing date, where it came from), when it was deleted and how
 * long it has left, and offers Restore and "Delete now". Restoring all of them
 * is one action in the card header.
 *
 * Owner-only, like every route behind it: inside somebody else's record the
 * page sends the person back to the vault, which offers no way in either.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineAction } from "@/components/ui/inline-action";
import { ListCapNotice } from "@/components/ui/list-cap-notice";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { DOCUMENT_PURGE_GRACE_DAYS } from "@/lib/documents/inbound-constants";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type {
  DeletedDocumentDto,
  DocumentSourceSystemValue,
} from "@/lib/validations/inbound-documents";

import { DOCUMENT_KIND_ICONS } from "../document-kind-meta";

import { daysUntilPurge, purgeCountdownKey } from "./trash-utils";
import { useRecentlyDeleted } from "./use-recently-deleted";

export function RecentlyDeletedView() {
  const { t } = useTranslations();
  const { user, isLoading: authLoading, isAuthenticated } = useAuth();
  const { inSharedRecord } = useRecordCapabilities();
  const router = useRouter();
  const moduleEnabled = user?.modules?.inboundDocuments === true;
  const ready = !authLoading && isAuthenticated && moduleEnabled;

  // UX redirects only; every route behind the page enforces the same.
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) router.push("/auth/login");
    else if (!moduleEnabled) router.push("/");
    else if (inSharedRecord) router.push("/documents");
  }, [authLoading, isAuthenticated, moduleEnabled, inSharedRecord, router]);

  const { list, restore, restoreAll, purge } = useRecentlyDeleted({
    enabled: ready && !inSharedRecord,
  });
  const [pendingPurge, setPendingPurge] = useState<DeletedDocumentDto | null>(
    null,
  );

  if (!ready || inSharedRecord) {
    return (
      <div className="flex h-64 items-center justify-center" role="status">
        <Loader2
          className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
        <span className="sr-only">{t("nav.loadingScreen")}</span>
      </div>
    );
  }

  const documents = list.data?.data.documents ?? [];
  const graceDays = list.data?.data.graceDays ?? DOCUMENT_PURGE_GRACE_DAYS;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("documents.trash.title")}
        description={t("documents.trash.subtitle", { days: graceDays })}
        backLink={{
          href: "/documents",
          label: t("documents.trash.back"),
          dataSlot: "documents-trash-back",
        }}
      />

      {list.isPending ? (
        <div data-slot="documents-trash-loading" className="space-y-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : list.isError ? (
        <QueryErrorCard
          error={list.error}
          title={t("documents.trash.loadError")}
          onRetry={() => void list.refetch()}
        />
      ) : documents.length === 0 ? (
        <EmptyState
          icon={<Trash2 className="size-6" aria-hidden />}
          title={t("documents.trash.emptyTitle")}
          description={t("documents.trash.emptyDescription", {
            days: graceDays,
          })}
          action={
            <Button asChild variant="outline" className="min-h-11 sm:min-h-9">
              <Link href="/documents">{t("documents.trash.back")}</Link>
            </Button>
          }
        />
      ) : (
        <Card data-slot="documents-trash-card">
          <CardHeader>
            <TileHeader
              icon={Trash2}
              title={t("documents.trash.count", { count: documents.length })}
              right={
                documents.length > 1 ? (
                  <InlineAction
                    size="sm"
                    data-slot="documents-trash-restore-all"
                    disabled={restoreAll.isPending}
                    onClick={() =>
                      restoreAll.mutate(documents.map((d) => d.id))
                    }
                  >
                    <RotateCcw aria-hidden />
                    {t("documents.trash.restoreAll")}
                  </InlineAction>
                ) : null
              }
            />
          </CardHeader>
          <ul className="divide-border divide-y border-t">
            {documents.map((doc) => (
              <DeletedRow
                key={doc.id}
                doc={doc}
                busy={
                  restoreAll.isPending ||
                  (restore.isPending && restore.variables === doc.id) ||
                  (purge.isPending && purge.variables === doc.id)
                }
                onRestore={() => restore.mutate(doc.id)}
                onPurge={() => setPendingPurge(doc)}
              />
            ))}
          </ul>
          <ListCapNotice cap={list.data?.cap} className="px-4 md:px-6" />
        </Card>
      )}

      <ConfirmDialog
        open={pendingPurge !== null}
        onOpenChange={(open) => {
          if (!open && !purge.isPending) setPendingPurge(null);
        }}
        title={t("documents.trash.purgeConfirmTitle")}
        body={t("documents.trash.purgeConfirmBody")}
        confirmLabel={t("documents.trash.purge")}
        pending={purge.isPending}
        holdOpen
        destructive
        slot="documents-trash-purge"
        onConfirm={() => {
          if (!pendingPurge) return;
          purge.mutate(pendingPurge.id, {
            onSettled: () => setPendingPurge(null),
          });
        }}
      />
    </div>
  );
}

/** Product names stay untranslated; only "another system" is prose. */
function sourceName(
  system: DocumentSourceSystemValue,
  t: (key: string) => string,
): string {
  if (system === "PAPERLESS") return "Paperless-ngx";
  if (system === "PAPRA") return "Papra";
  return t("documents.detail.sourceOther");
}

/** One deleted document: what it was, how long it has left, the two ways out. */
export function DeletedRow({
  doc,
  busy,
  onRestore,
  onPurge,
}: {
  doc: DeletedDocumentDto;
  busy: boolean;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const Icon = DOCUMENT_KIND_ICONS[doc.kind];
  const title = doc.title ?? doc.filename ?? t("documents.card.untitled");
  const about = [
    t(`documents.kind.${doc.kind}`),
    doc.documentDate ? fmt.dateShortSmartCalendar(doc.documentDate) : null,
    doc.sourceSystem
      ? t("documents.detail.importedFrom", {
          system: sourceName(doc.sourceSystem, t),
        })
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  const countdown = purgeCountdownKey(daysUntilPurge(doc.purgeAt));

  return (
    <li
      data-slot="documents-trash-row"
      className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center md:px-6"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium break-words">{title}</p>
          <p className="text-muted-foreground text-xs">{about}</p>
          <p className="text-muted-foreground text-xs">
            {t("documents.trash.deletedOn", {
              date: fmt.dateShortSmart(doc.deletedAt),
            })}{" "}
            {t(countdown.key, countdown.params)}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          data-slot="documents-trash-restore"
          disabled={busy}
          onClick={onRestore}
        >
          <RotateCcw className="size-4" aria-hidden />
          {t("documents.trash.restore")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 sm:min-h-9"
          data-slot="documents-trash-purge"
          disabled={busy}
          onClick={onPurge}
        >
          {t("documents.trash.purge")}
        </Button>
      </div>
    </li>
  );
}
