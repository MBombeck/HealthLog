"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ExternalLink,
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  Share2,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { InlineAction } from "@/components/ui/inline-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { INBOUND_DOCUMENT_KINDS } from "@/lib/documents/inbound-constants";
import { formatBytes } from "@/lib/format/bytes";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { cn } from "@/lib/utils";

// Loaded on demand: only a managed profile's guardian ever opens it, and it
// carries the Coach's bubble renderer.
const DocumentChatSheet = dynamic(
  () => import("../chat/document-chat-sheet").then((m) => m.DocumentChatSheet),
  { ssr: false, loading: () => null },
);
import type {
  InboundDocumentDetailDto,
  InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";

import {
  DocumentDownloadButton,
  DocumentOpenInTabButton,
} from "./original-file";
import type { DocumentDetail } from "./use-document-detail";

/**
 * The sheet's footer. Delete sits bottom-left as a quiet text button (the
 * bottom-right slot reads as the confirm action, and a destructive control
 * there is a footgun); Coach, Share, open in a new tab and Download keep the
 * trailing edge, icon-only on phones so they never overflow at 360 px.
 */
export function DocumentDetailFooter({
  doc,
  detail,
  aiEnabled,
  coachAvailable,
  onOpenChange,
}: {
  doc: InboundDocumentDetailDto;
  detail: DocumentDetail;
  aiEnabled: boolean;
  coachAvailable: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslations();
  // The vault's "Ask the Coach" opens the fenced conversation scoped to this
  // document in the shared side drawer.
  const launch = useCoachLaunch();
  // #1403 — a managed profile's guardian has no Coach drawer (a shared record
  // does not mount one), so the same question opens the document's own chat.
  const [chatOpen, setChatOpen] = useState(false);
  const {
    canManageDocuments,
    ownsVault,
    setConfirmDeleteOpen,
    remove,
    setShareOpen,
    inlineSrc,
    inlineFailed,
  } = detail;
  return (
    <div className="flex w-full items-center justify-between gap-2">
      {/* Deleting is the owner's and a managed profile's guardian's;
          inside an adult's record the sheet reads the document and offers
          the download, and the leading slot simply has nothing in it.
          Sharing stays the owner's alone. */}
      {canManageDocuments ? (
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() => setConfirmDeleteOpen(true)}
          disabled={remove.isPending}
          data-slot="document-detail-delete"
        >
          <Trash2 className="size-4" aria-hidden />
          {t("documents.detail.delete")}
        </Button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">
        {/* .x — `launch` is the one entry point that rendered
            without asking whether a drawer exists to open. It is null
            inside somebody else's record (the shell mounts no drawer
            there), and `/documents` is a shared-record destination, so
            this is the Coach button a delegate actually meets. */}
        {aiEnabled && coachAvailable && launch ? (
          // "Ask the Coach" opens the REAL
          // coach conversation scoped to this document in the SIDE
          // DRAWER (the maximize control there expands it to the full
          // `/coach` page). Every doc turn still runs on the hardened
          // fenced document endpoint (never the coach tool route) — only
          // WHERE the conversation renders changed, not the send path.
          // Close the detail sheet so the drawer owns the surface.
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              launch.askCoach(null, undefined, false, doc.id);
            }}
            data-slot="document-chat-open"
          >
            <Sparkles className="size-4" aria-hidden />
            <span className="sr-only sm:not-sr-only">
              {t("documents.chat.openButton")}
            </span>
          </Button>
        ) : aiEnabled &&
          !launch &&
          !ownsVault &&
          canManageDocuments &&
          doc.hasContentIndex ? (
          <>
            <Button
              variant="outline"
              onClick={() => setChatOpen(true)}
              data-slot="document-chat-open"
            >
              <Sparkles className="size-4" aria-hidden />
              <span className="sr-only sm:not-sr-only">
                {t("documents.chat.openButton")}
              </span>
            </Button>
            <DocumentChatSheet
              documentId={doc.id}
              title={doc.title ?? doc.filename ?? t("documents.card.untitled")}
              open={chatOpen}
              onOpenChange={setChatOpen}
            />
          </>
        ) : null}
        {ownsVault && (
          <Button
            variant="outline"
            onClick={() => setShareOpen(true)}
            data-slot="document-share"
            aria-label={t("documents.detail.share")}
          >
            <Share2 className="size-4" aria-hidden />
            <span className="hidden sm:inline">
              {t("documents.detail.share")}
            </span>
          </Button>
        )}
        {/* A blob tab on a browser with no PDF viewer would only start the
            same download the button beside it offers. */}
        {detail.previewInline ? (
          <DocumentOpenInTabButton
            readyUrl={inlineSrc}
            unavailable={inlineFailed}
          />
        ) : null}
        <DocumentDownloadButton
          documentId={doc.id}
          filename={doc.filename}
          readyUrl={inlineSrc}
          unavailable={inlineFailed}
          variant="outline"
          slot="document-download"
        />
      </div>
    </div>
  );
}

/** Title, kind, filing date and the condition links, each saving on commit. */
export function DocumentDetailFields({
  doc,
  detail,
}: {
  doc: InboundDocumentDetailDto;
  detail: DocumentDetail;
}) {
  const { t } = useTranslations();
  const {
    canManageDocuments,
    editingTitle,
    setEditingTitle,
    titleDraft,
    setTitleDraft,
    commitTitle,
    patch,
    episodes,
    toggleEpisode,
  } = detail;
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="document-title-input">
          {t("documents.detail.titleLabel")}
        </Label>
        {editingTitle ? (
          <Input
            id="document-title-input"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") setEditingTitle(false);
            }}
            maxLength={200}
            placeholder={t("documents.detail.titlePlaceholder")}
          />
        ) : !canManageDocuments ? (
          <p
            id="document-title-input"
            className={cn(
              "min-h-10 px-3 py-2 text-sm",
              doc.title === null && "text-muted-foreground",
            )}
          >
            {doc.title ?? t("documents.detail.titlePlaceholder")}
          </p>
        ) : (
          <button
            type="button"
            id="document-title-input"
            onClick={() => {
              setTitleDraft(doc.title ?? "");
              setEditingTitle(true);
            }}
            className="border-input hover:bg-muted/50 focus-visible:border-input-focus flex min-h-10 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none"
          >
            <span
              className={cn(
                "truncate",
                doc.title === null && "text-muted-foreground",
              )}
            >
              {doc.title ?? t("documents.detail.titlePlaceholder")}
            </span>
            <Pencil
              className="text-muted-foreground size-3.5 shrink-0"
              aria-hidden
            />
          </button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="document-kind-select">
            {t("documents.detail.kindLabel")}
          </Label>
          {/* Read-only rather than absent: the value IS the content
              a delegate came to read, and a form field that shows it
              without accepting a change is the honest rendering. */}
          <Select
            value={doc.kind}
            disabled={!canManageDocuments}
            onValueChange={(value) =>
              patch.mutate({ kind: value as InboundDocumentKindValue })
            }
          >
            <SelectTrigger id="document-kind-select" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INBOUND_DOCUMENT_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`documents.kind.${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="document-date-field">
            {t("documents.detail.dateLabel")}
          </Label>
          <DateField
            id="document-date-field"
            disabled={!canManageDocuments}
            value={doc.documentDate ?? ""}
            onChange={(value) =>
              patch.mutate({
                documentDate: value === "" ? null : value,
              })
            }
            aria-label={t("documents.detail.dateLabel")}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm leading-none font-medium">
          {t("documents.detail.conditionsLabel")}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {doc.conditionLinks.map((link) => (
            <Link
              key={link.episodeId}
              href={`/illness/${link.episodeId}`}
              className="bg-muted text-foreground hover:bg-muted/70 focus-visible:ring-ring/50 inline-flex max-w-48 items-center rounded-full px-2.5 py-1 text-xs focus-visible:ring-[3px] focus-visible:outline-none"
            >
              <span className="truncate">{link.name}</span>
            </Link>
          ))}
          {doc.conditionLinks.length === 0 ? (
            <span className="text-muted-foreground text-xs">
              {t("documents.detail.noConditions")}
            </span>
          ) : null}
          {canManageDocuments && (episodes.data?.length ?? 0) > 0 ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-full px-2.5 text-xs"
                >
                  <Plus className="size-3" aria-hidden />
                  {t("documents.detail.linkCondition")}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-2">
                <ul className="max-h-56 space-y-0.5 overflow-y-auto overscroll-contain">
                  {episodes.data?.map((episode) => {
                    const linked = doc.conditionLinks.some(
                      (l) => l.episodeId === episode.id,
                    );
                    return (
                      <li key={episode.id}>
                        <button
                          type="button"
                          onClick={() => toggleEpisode(episode.id)}
                          className="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:ring-[3px] focus-visible:outline-none"
                          aria-pressed={linked}
                        >
                          <Check
                            className={cn(
                              "size-4 shrink-0",
                              linked ? "opacity-100" : "opacity-0",
                            )}
                            aria-hidden
                          />
                          <span className="truncate">{episode.label}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
    </>
  );
}

/**
 * The lab values read from this page, when Labs holds any, and the upload,
 * filename and import provenance meta lines.
 */
export function DocumentDetailMeta({
  doc,
  detail,
}: {
  doc: InboundDocumentDetailDto;
  detail: DocumentDetail;
}) {
  const { t, locale } = useTranslations();
  const format = useFormatters();
  const { labsModuleEnabled, labFactCount, sourceSystemName } = detail;
  return (
    <>
      {labsModuleEnabled && labFactCount > 0 ? (
        <Link
          href="/labs"
          data-slot="document-detail-lab-values-link"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1.5 self-start rounded-md text-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
        >
          <FlaskConical className="size-4" aria-hidden="true" />
          {t("documents.detail.labValuesLink", { count: labFactCount })}
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      ) : null}

      <p className="text-muted-foreground text-xs">
        {t("documents.detail.uploadedMeta", {
          date: format.date(doc.createdAt),
          size: formatBytes(doc.byteSize, locale),
        })}
      </p>
      {doc.filename ? (
        <p
          className="text-muted-foreground truncate text-xs"
          title={doc.filename}
        >
          {doc.filename}
        </p>
      ) : null}

      {/* Where an imported document came from (#1038). Meta, so
          muted like the line above; the id is what the person looks
          up in the other system. */}
      {doc.sourceSystem ? (
        <p
          className="text-muted-foreground text-xs break-all"
          data-slot="document-detail-provenance"
        >
          {doc.sourceId
            ? t("documents.detail.importedFromWithId", {
                system: sourceSystemName(doc.sourceSystem),
                id: doc.sourceId,
              })
            : t("documents.detail.importedFrom", {
                system: sourceSystemName(doc.sourceSystem),
              })}
        </p>
      ) : null}
      {/* The way back to the original (#1394). The server fills the link
          for the owner alone, from their own archive connection; every
          other view gets null and this stays absent. */}
      {doc.sourceSystem && isWebUrl(doc.sourceUrl) ? (
        <InlineAction asChild tone="muted" className="self-start text-xs">
          <a
            href={doc.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-slot="document-detail-source-link"
          >
            {t("documents.detail.openInSource", {
              system: sourceSystemName(doc.sourceSystem),
            })}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </InlineAction>
      ) : null}
    </>
  );
}

/** Only an http(s) address becomes a link; anything else renders nothing. */
function isWebUrl(value: string | null): value is string {
  return value !== null && /^https?:\/\//i.test(value);
}

/**
 * The sheet's one line about its own writes: the error when the last edit
 * failed, "Saving…" while one is in flight, and "Changes saved" once the
 * server took it. Edits save on commit with no Save button, so this line is
 * the only sign that closing the sheet loses nothing (#1403).
 */
export function DocumentSaveStatus({
  error,
  pending,
  saved,
}: {
  error: string | null;
  pending: boolean;
  saved: boolean;
}) {
  const { t } = useTranslations();
  if (error) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {error}
      </p>
    );
  }
  if (pending) {
    return (
      <p
        role="status"
        className="text-muted-foreground flex items-center gap-1.5 text-xs"
        data-slot="document-detail-saving"
      >
        <Loader2
          className="size-3.5 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
        {t("documents.detail.saving")}
      </p>
    );
  }
  if (!saved) return null;
  return (
    <p
      role="status"
      className="text-muted-foreground flex items-center gap-1.5 text-xs"
      data-slot="document-detail-saved"
    >
      <Check className="size-3.5" aria-hidden />
      {t("documents.detail.saved")}
    </p>
  );
}
