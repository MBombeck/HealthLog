"use client";

import Link from "next/link";
import {
  ArrowRight,
  Check,
  ExternalLink,
  FlaskConical,
  Loader2,
  Share2,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { InlineAction } from "@/components/ui/inline-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ListGroup, ListItem } from "@/components/ui/list-row";
import { NativeSelect } from "@/components/ui/native-select";
import { INBOUND_DOCUMENT_KINDS } from "@/lib/documents/inbound-constants";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { cn } from "@/lib/utils";
import type {
  InboundDocumentDetailDto,
  InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";

import { DocumentDownloadButton, DocumentOpenInTabItem } from "./original-file";
import type { DocumentDetail } from "./use-document-detail";

/**
 * The sheet's footer: one pair, Share (the owner's alone) and Download, after
 * the "⋯" the sheet passes in, which `ActionPair` stands in the header. A hook
 * returning the bare fragment, not a component: the footer lays out the
 * children it is handed, and a wrapper would read as one button.
 */
export function useDocumentDetailFooter({
  doc,
  detail,
  menu,
}: {
  doc: InboundDocumentDetailDto | null | undefined;
  detail: DocumentDetail;
  /** The `ActionMenu`, or null when it would hold nothing. */
  menu: React.ReactNode;
}): React.ReactNode {
  const { t } = useTranslations();
  const { ownsVault, setShareOpen, inlineSrc, inlineFailed } = detail;
  if (!doc) return undefined;
  return (
    <>
      {menu}
      {ownsVault ? (
        <Button
          variant="outline"
          onClick={() => setShareOpen(true)}
          data-slot="document-share"
        >
          <Share2 className="size-4" aria-hidden />
          {t("documents.detail.share")}
        </Button>
      ) : null}
      <DocumentDownloadButton
        documentId={doc.id}
        filename={doc.filename}
        readyUrl={inlineSrc}
        unavailable={inlineFailed}
        slot="document-download"
      />
    </>
  );
}

/**
 * The "⋯" entries that are not AI reads: the Coach about this page, the
 * original in a new tab (types the browser draws itself), and Delete. A hook
 * so the sheet knows whether the menu holds anything at all.
 */
export function useDocumentDetailMenuItems({
  doc,
  detail,
  aiEnabled,
  coachAvailable,
  onOpenChange,
  onOpenChat,
}: {
  doc: InboundDocumentDetailDto | null | undefined;
  detail: DocumentDetail;
  aiEnabled: boolean;
  coachAvailable: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the document's own chat (a managed profile's guardian). */
  onOpenChat: () => void;
}): React.ReactNode[] {
  const { t } = useTranslations();
  // The vault's "Ask the Coach" opens the fenced conversation scoped to this
  // document in the shared side drawer. `launch` is null inside somebody
  // else's record (the shell mounts no drawer there).
  const launch = useCoachLaunch();
  const {
    canManageDocuments,
    ownsVault,
    setConfirmDeleteOpen,
    remove,
    inlineSrc,
    inlineFailed,
  } = detail;
  const items: React.ReactNode[] = [];
  if (!doc) return items;
  if (aiEnabled && coachAvailable && launch) {
    // Every doc turn runs on the fenced document endpoint, never the coach
    // tool route; only where the conversation renders is the drawer. The
    // sheet closes so the drawer owns the surface.
    items.push(
      <DropdownMenuItem
        key="coach"
        data-slot="document-chat-open"
        onSelect={() => {
          onOpenChange(false);
          launch.askCoach(null, undefined, false, doc.id);
        }}
      >
        <Sparkles aria-hidden />
        {t("documents.chat.openButton")}
      </DropdownMenuItem>,
    );
  } else if (
    aiEnabled &&
    !launch &&
    !ownsVault &&
    canManageDocuments &&
    doc.hasContentIndex
  ) {
    // #1403: a managed profile's guardian has no Coach drawer, so the same
    // question opens the document's own chat.
    items.push(
      <DropdownMenuItem
        key="chat"
        data-slot="document-chat-open"
        onSelect={onOpenChat}
      >
        <Sparkles aria-hidden />
        {t("documents.chat.openButton")}
      </DropdownMenuItem>,
    );
  }
  // A blob tab on a browser with no PDF viewer would only start the same
  // download the footer offers.
  if (detail.previewInline) {
    items.push(
      <DocumentOpenInTabItem
        key="tab"
        readyUrl={inlineSrc}
        unavailable={inlineFailed}
      />,
    );
  }
  // Deleting is the owner's and a managed profile's guardian's.
  if (canManageDocuments) {
    items.push(
      <DropdownMenuItem
        key="delete"
        variant="destructive"
        data-slot="document-detail-delete"
        disabled={remove.isPending}
        onSelect={() => setConfirmDeleteOpen(true)}
      >
        <Trash2 aria-hidden />
        {t("documents.detail.delete")}
      </DropdownMenuItem>,
    );
  }
  return items;
}

/**
 * A control standing as a row's value: no frame, the value in the row's
 * value weight, its chevron or calendar the only sign it opens.
 */
const ROW_CONTROL =
  "h-9 w-auto border-transparent bg-transparent font-normal shadow-none";

/**
 * Title, kind and filing date as three rows of one card, each saving on
 * commit. A tap on the title row turns it into the field; kind and date
 * carry their control on the right.
 */
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
  } = detail;
  const titleText = doc.title ?? t("documents.detail.titlePlaceholder");
  return (
    <ListGroup data-slot="document-detail-fields">
      {editingTitle ? (
        <li className="flex min-h-14 items-center gap-2.5 px-4 py-2">
          <Label htmlFor="document-title-input" className="shrink-0">
            {t("documents.detail.titleLabel")}
          </Label>
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
        </li>
      ) : (
        <ListItem
          data-slot="document-detail-title-row"
          title={t("documents.detail.titleLabel")}
          actionLabel={`${t("documents.detail.titleLabel")}, ${titleText}`}
          {...(canManageDocuments
            ? {
                onSelect: () => {
                  setTitleDraft(doc.title ?? "");
                  setEditingTitle(true);
                },
              }
            : {})}
          trailing={
            <span
              title={titleText}
              className={cn(
                "max-w-[55vw] truncate font-normal sm:max-w-sm",
                doc.title === null && "text-muted-foreground",
              )}
            >
              {titleText}
            </span>
          }
        />
      )}
      {/* Read-only rather than absent for a delegate: the value IS the
          content they came to read. */}
      <ListItem
        title={
          <Label htmlFor="document-kind-select">
            {t("documents.detail.kindLabel")}
          </Label>
        }
        trailing={
          <NativeSelect
            id="document-kind-select"
            value={doc.kind}
            disabled={!canManageDocuments}
            className={ROW_CONTROL}
            onChange={(e) =>
              patch.mutate({
                kind: e.target.value as InboundDocumentKindValue,
              })
            }
          >
            {INBOUND_DOCUMENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`documents.kind.${kind}`)}
              </option>
            ))}
          </NativeSelect>
        }
      />
      <ListItem
        title={
          <Label htmlFor="document-date-field">
            {t("documents.detail.dateLabel")}
          </Label>
        }
        trailing={
          <DateField
            id="document-date-field"
            className={cn(ROW_CONTROL, "w-36")}
            disabled={!canManageDocuments}
            value={doc.documentDate ?? ""}
            onChange={(value) =>
              patch.mutate({
                documentDate: value === "" ? null : value,
              })
            }
            aria-label={t("documents.detail.dateLabel")}
          />
        }
      />
    </ListGroup>
  );
}

/**
 * The lab values read from this page, when Labs holds any, and where an
 * imported document came from.
 */
export function DocumentDetailMeta({
  doc,
  detail,
}: {
  doc: InboundDocumentDetailDto;
  detail: DocumentDetail;
}) {
  const { t } = useTranslations();
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
