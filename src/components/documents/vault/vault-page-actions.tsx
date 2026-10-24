"use client";

import type { RefObject } from "react";
import Link from "next/link";
import { Trash2, Upload, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

import { ImportFromSourceButton } from "../sources/import-from-source-button";
import { useDocumentUsage } from "./use-document-usage";

/**
 * The page header's actions (rendered only when one of them applies): the display-settings wrench (the caller's own
 * settings, so never inside somebody else's record), the way into Recently
 * deleted (only while something is in it), the source import and the upload
 * button, which an empty vault's empty state carries instead.
 */
export function VaultPageActions({
  canManageDocuments,
  inSharedRecord,
  hideUpload,
  uploadInputRef,
}: {
  canManageDocuments: boolean;
  inSharedRecord: boolean;
  hideUpload: boolean;
  uploadInputRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslations();
  // The vault's own usage read (shared key): how many sit in Recently
  // deleted. The way in shows only above zero.
  const deletedCount = useDocumentUsage(true).data?.deletedCount ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* The wrench left of the primary action, as on the illness
        journal: it opens this vault's display settings. `/settings`
        is the caller's own, so it never shows inside somebody
        else's record. */}
      {!inSharedRecord ? (
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
        >
          <Link
            href="/settings/layout/documents"
            aria-label={t("documents.customize")}
            title={t("documents.customize")}
            data-slot="documents-customize"
          >
            <Wrench className="size-4" aria-hidden />
          </Link>
        </Button>
      ) : null}
      {/* Quiet, like the wrench, and only while there is something to
        bring back: deleted documents wait there for 30 days. On a phone
        the icon and the count; the words from `sm` up. */}
      {canManageDocuments && !inSharedRecord && deletedCount > 0 ? (
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="min-h-11 min-w-11 gap-1.5 sm:min-h-9 sm:min-w-9"
        >
          <Link
            href="/documents/deleted"
            aria-label={t("documents.trash.entryLabel", {
              count: deletedCount,
            })}
            data-slot="documents-recently-deleted"
          >
            <Trash2 className="size-4" aria-hidden />
            <span className="hidden sm:inline">
              {t("documents.trash.title")}
            </span>
            <span className="tabular-nums">({deletedCount})</span>
          </Link>
        </Button>
      ) : null}
      {canManageDocuments ? (
        <>
          {/* Renders only with a connected Paperless-ngx or Papra. */}
          <ImportFromSourceButton className="min-h-11 sm:min-h-9" />
          {/* An empty vault's empty state carries the upload. */}
          {hideUpload ? null : (
            <Button
              className="min-h-11 sm:min-h-9"
              onClick={() => uploadInputRef.current?.click()}
            >
              <Upload className="size-4" aria-hidden />
              {t("documents.pageUpload")}
            </Button>
          )}
        </>
      ) : null}
    </div>
  );
}
