"use client";

/**
 * Floating bulk-action bar for the vault's multi-select mode. Appears once
 * at least one document is selected, pinned above the bottom nav on phones
 * and near the bottom edge on desktop. Carries the selected count and the
 * bulk verbs — set type, link condition, file against a visit, share (one
 * link for the whole selection), delete (undo-able), clear — all driving the
 * page's handlers.
 *
 * The two link verbs are the same shape and stay that way: each renders only
 * when the account HAS something to link to, so an empty menu is never
 * offered.
 *
 * A `role="toolbar"` with proper labels; the destructive verb sits last
 * before Clear so a stray tap sequence never ends on Delete. Share sits just
 * before Delete (the safe actions lead). The bar is a deliberate hand-rolled
 * shell (a floating toolbar is not a Card surface): dense-tile padding `p-3`
 * per the standards.
 */
import {
  CalendarClock,
  FolderPlus,
  Share2,
  Tag,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";
import { DOCUMENT_KIND_ICONS, DOCUMENT_KIND_ORDER } from "./document-kind-meta";

export interface BulkEpisodeOption {
  id: string;
  label: string;
}

/** One visit the selection can be filed against. Label resolved by the page. */
export interface BulkEncounterOption {
  id: string;
  label: string;
}

export function DocumentBulkBar({
  selectedCount,
  episodes,
  encounters,
  busy,
  onSetKind,
  onLinkEpisode,
  onLinkEncounter,
  onShare,
  onDelete,
  onClear,
}: {
  selectedCount: number;
  /** The caller's live illness episodes — the link-condition targets. */
  episodes: BulkEpisodeOption[];
  /** The caller's recent visits — the file-against-a-visit targets. */
  encounters: BulkEncounterOption[];
  /** A bulk call is in flight — the verbs disable, Clear stays live. */
  busy: boolean;
  onSetKind: (kind: InboundDocumentKindValue) => void;
  onLinkEpisode: (episodeId: string) => void;
  onLinkEncounter: (encounterId: string) => void;
  /**
   * Share the whole selection as ONE documents-only link. The page caps the
   * selection at `SHARE_LINK_MAX_DOCUMENTS` and surfaces the over-cap hint —
   * this handler just opens the share sheet seeded with the selection.
   */
  onShare: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslations();

  return (
    <div
      data-slot="document-bulk-bar"
      role="toolbar"
      aria-label={t("documents.bulk.barLabel")}
      className={cn(
        "bg-card border-border fixed bottom-20 left-1/2 z-40 -translate-x-1/2 md:bottom-6",
        // v1.42 — while a day is docked on the right, the bar sits against
        // the page's right edge instead of the window's centre, clear of the
        // day's footer actions and of an expanded sidebar.
        "[body:has([data-slot=day-panel][data-shell=docked])_&]:right-[calc(26.25rem+1rem)] [body:has([data-slot=day-panel][data-shell=docked])_&]:left-auto [body:has([data-slot=day-panel][data-shell=docked])_&]:max-w-[calc(100vw-44.25rem)] [body:has([data-slot=day-panel][data-shell=docked])_&]:translate-x-0",
        "flex w-[calc(100%-2rem)] max-w-2xl flex-wrap items-center gap-2 rounded-xl border p-3 shadow-lg",
      )}
    >
      <p className="px-1 text-sm font-medium whitespace-nowrap" role="status">
        {t("documents.selection.count", { count: selectedCount })}
      </p>

      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        {/* v1.30 mobile audit (DO-1) — five labelled buttons wrapped into a
            2–3-row floating slab at ~360 px. Below `sm` every verb collapses
            to icon-only (`aria-label` carries the accessible name; the
            visible label returns at `sm+`) — the `document-detail-sheet`
            footer's established icon-collapse pattern. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={t("documents.bulk.setKind")}
            >
              <Tag className="size-4" aria-hidden />
              <span className="hidden sm:inline">
                {t("documents.bulk.setKind")}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {DOCUMENT_KIND_ORDER.map((kind) => {
              const Icon = DOCUMENT_KIND_ICONS[kind];
              return (
                <DropdownMenuItem key={kind} onSelect={() => onSetKind(kind)}>
                  <Icon className="size-4" aria-hidden />
                  {t(`documents.kind.${kind}`)}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {episodes.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label={t("documents.bulk.linkCondition")}
              >
                <FolderPlus className="size-4" aria-hidden />
                <span className="hidden sm:inline">
                  {t("documents.bulk.linkCondition")}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {episodes.map((episode) => (
                <DropdownMenuItem
                  key={episode.id}
                  onSelect={() => onLinkEpisode(episode.id)}
                >
                  <span className="max-w-56 truncate">{episode.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {encounters.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                data-slot="document-bulk-link-visit"
                aria-label={t("documents.bulk.linkVisit")}
              >
                <CalendarClock className="size-4" aria-hidden />
                <span className="hidden sm:inline">
                  {t("documents.bulk.linkVisit")}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {encounters.map((encounter) => (
                <DropdownMenuItem
                  key={encounter.id}
                  onSelect={() => onLinkEncounter(encounter.id)}
                >
                  <span className="max-w-56 truncate">{encounter.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onShare}
          data-slot="document-bulk-share"
          aria-label={t("documents.bulk.share")}
        >
          <Share2 className="size-4" aria-hidden />
          <span className="hidden sm:inline">{t("documents.bulk.share")}</span>
        </Button>

        {/* Solid destructive (matching the detail sheet's Delete) — the
            outline variant's destructive text on the card surface fails the
            WCAG contrast gate. */}
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={onDelete}
          aria-label={t("documents.bulk.delete")}
        >
          <Trash2 className="size-4" aria-hidden />
          <span className="hidden sm:inline">{t("documents.bulk.delete")}</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={onClear}
          aria-label={t("documents.selection.clear")}
        >
          <X className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">
            {t("documents.selection.clear")}
          </span>
        </Button>
      </div>
    </div>
  );
}
