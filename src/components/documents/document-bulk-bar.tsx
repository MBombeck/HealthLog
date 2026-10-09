"use client";

/**
 * Floating bulk-action bar for the vault's multi-select mode. Appears once
 * at least one document is selected, pinned above the bottom nav on phones
 * and near the bottom edge on desktop.
 *
 * Two tight lines. The first carries the selected count and, at its right
 * edge, the X that clears the selection. The second is the one action row:
 * set type, link condition, file against a visit and share lead from the
 * left, and Delete sits alone at the right edge in the destructive style.
 * Delete never deletes from here — it asks the page, which confirms first
 * (`onRequestDelete`), the same path the card's Delete key takes.
 *
 * The two link verbs are the same shape and stay that way: each renders only
 * when the account HAS something to link to, so an empty menu is never
 * offered.
 *
 * Below `lg` every verb is icon-only with its name in `aria-label` and
 * `title`, at the 44 px tap floor, so the row stays one line at 360 px; the
 * labels return where the bar is wide enough to hold them on one line. A
 * `role="toolbar"`; the bar is a deliberate hand-rolled shell (a floating
 * toolbar is not a Card surface): dense-tile padding `p-3` per the standards.
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

/** Shared shape of the leading verbs: icon-only below `lg`, labelled from it. */
const VERB_CLASS = "min-h-11 min-w-11 sm:min-h-9 sm:min-w-9";

function VerbLabel({ children }: { children: string }) {
  // Icon-only again while a day is docked: the bar then shares the width
  // with the day panel and the labelled row would no longer fit one line.
  return (
    <span className="hidden lg:inline [body:has([data-slot=day-strip][data-state=open])_&]:hidden">
      {children}
    </span>
  );
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
  onRequestDelete,
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
  /** Ask to delete the selection. The page confirms before anything goes. */
  onRequestDelete: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslations();

  return (
    // The outer slot is the data-list selection bar's: the Coach launcher
    // watches for it and steps aside while a selection is open, so it never
    // sits over Delete at the bar's right edge. `contents` keeps the wrapper
    // out of the layout.
    <div data-slot="selection-action-bar" className="contents">
      <div
        data-slot="document-bulk-bar"
        role="toolbar"
        aria-label={t("documents.bulk.barLabel")}
        className={cn(
          // Clear of the bottom bar (and the home indicator) for as long as
          // the bar shows, which is the shell's call, not a width's: a phone
          // held sideways is wider than `md` and still has the bar.
          "bg-card border-border shell-desktop:bottom-6 fixed bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] left-1/2 z-40 -translate-x-1/2",
          // v1.42 — while a day is docked on the right (its strip open), the
          // bar sits against the page's right edge instead of the window's
          // centre, clear of the day's footer actions, its strip and an
          // expanded sidebar.
          "[body:has([data-slot=day-strip][data-state=open])_&]:right-[calc(26.25rem+2.5rem+1rem)] [body:has([data-slot=day-strip][data-state=open])_&]:left-auto [body:has([data-slot=day-strip][data-state=open])_&]:max-w-[calc(100vw-46.75rem)] [body:has([data-slot=day-strip][data-state=open])_&]:translate-x-0",
          "flex w-[calc(100%-2rem)] max-w-3xl flex-col gap-2 rounded-xl border p-3 shadow-lg",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <p
            className="px-1 text-sm font-medium whitespace-nowrap"
            role="status"
            data-slot="document-bulk-count"
          >
            {t("documents.selection.count", { count: selectedCount })}
          </p>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-11 sm:size-9"
            onClick={onClear}
            data-slot="document-bulk-clear"
            aria-label={t("documents.selection.clear")}
            title={t("documents.selection.clear")}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>

        <div
          data-slot="document-bulk-actions"
          className="flex items-center gap-1.5"
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                className={VERB_CLASS}
                data-slot="document-bulk-set-kind"
                aria-label={t("documents.bulk.setKind")}
                title={t("documents.bulk.setKind")}
              >
                <Tag className="size-4" aria-hidden />
                <VerbLabel>{t("documents.bulk.setKind")}</VerbLabel>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
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
                  className={VERB_CLASS}
                  data-slot="document-bulk-link-condition"
                  aria-label={t("documents.bulk.linkCondition")}
                  title={t("documents.bulk.linkCondition")}
                >
                  <FolderPlus className="size-4" aria-hidden />
                  <VerbLabel>{t("documents.bulk.linkCondition")}</VerbLabel>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
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
                  className={VERB_CLASS}
                  data-slot="document-bulk-link-visit"
                  aria-label={t("documents.bulk.linkVisit")}
                  title={t("documents.bulk.linkVisit")}
                >
                  <CalendarClock className="size-4" aria-hidden />
                  <VerbLabel>{t("documents.bulk.linkVisit")}</VerbLabel>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
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
            className={VERB_CLASS}
            data-slot="document-bulk-share"
            aria-label={t("documents.bulk.share")}
            title={t("documents.bulk.share")}
          >
            <Share2 className="size-4" aria-hidden />
            <VerbLabel>{t("documents.bulk.share")}</VerbLabel>
          </Button>

          {/* Solid destructive (matching the detail sheet's Delete) — the
            outline variant's destructive text on the card surface fails the
            WCAG contrast gate. Alone at the right edge, away from the safe
            verbs. */}
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={onRequestDelete}
            className={cn("ml-auto", VERB_CLASS)}
            data-slot="document-bulk-delete"
            aria-label={t("documents.bulk.delete")}
            title={t("documents.bulk.delete")}
          >
            <Trash2 className="size-4" aria-hidden />
            <VerbLabel>{t("documents.bulk.delete")}</VerbLabel>
          </Button>
        </div>
      </div>
    </div>
  );
}
