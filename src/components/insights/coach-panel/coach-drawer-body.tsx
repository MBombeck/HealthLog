"use client";

import { ChevronLeft, MessagesSquare, PanelLeftClose } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.20 phase B4 — pure presentational body for `<CoachDrawer>`.
 *
 * The drawer's outer Radix `<Sheet>` does not surface in SSR (its
 * portal is client-only), so the unit suite couldn't pin the
 * mobile-only rail-tray triggers via the `<CoachDrawer>` itself.
 * Lifting the body grid + chevron triggers + composer slot up here
 * gives the test a node-renderable surface; the `<CoachDrawer>`
 * itself stays the integrating shell that owns state + the trays.
 *
 * The component is stateless: the parent owns the tray state and
 * passes the open-toggles + slot content.
 *
 * v1.16.1 — two structural changes:
 *  - The sources rail lost its inline xl+ column. "What I draw on" is
 *    now hidden by default on every viewport and slides in as the
 *    right-edge tray when the user taps the toggle — the rail is a
 *    look-up surface, not something worth a permanent 280 px gutter.
 *  - The history affordance forked by surface: the drawer's
 *    "Conversations" button hands off to the full-page Coach route
 *    (the in-panel left tray kept breaking inside the sheet), while
 *    the page renders the conversation list inline as a left column
 *    on lg+ via the `historyRail` slot (tray below lg).
 *
 * v1.18.7 (W-coach C-UI) — the inline history rail on the page surface
 * is now COLLAPSIBLE and collapsed by default. The maintainer wanted a
 * calm, prompt-first surface (Claude/ChatGPT-like) rather than a
 * permanently-open list, and explicitly did not want the old top-left
 * "open side panel" affordance lingering in fullscreen. The rail folds
 * away to a zero-width column; a single clean toggle in the rail-tray
 * strip (lg+) reveals it, and a matching close control sits in the rail
 * heading. Below lg the conversation list stays a bottom tray.
 */
export interface CoachDrawerBodyProps {
  thread: React.ReactNode;
  composer: React.ReactNode;
  /** The New conversation button, floating above the composer. */
  newChat?: React.ReactNode;
  /**
   * Inline conversation list (page surface only). When set, it renders
   * as a collapsible left column on lg+ and the history button collapses
   * to the sub-lg tray trigger. The drawer omits it.
   */
  historyRail?: React.ReactNode;
  /**
   * v1.18.7 — page surface only: whether the inline history rail is
   * expanded (lg+). Defaults to collapsed via the parent. Ignored when
   * `historyRail` is omitted (the drawer surface).
   */
  historyOpen?: boolean;
  /**
   * v1.18.7 — page surface only: toggles the inline rail open/closed.
   * The rail-tray-strip control opens it; the rail-heading control
   * closes it. Below lg the strip button still opens the bottom tray.
   */
  onToggleHistory?: () => void;
  onHistoryClick: () => void;
  onOpenSourcesTray: () => void;
}

export function CoachDrawerBody({
  thread,
  composer,
  newChat,
  historyRail,
  historyOpen = false,
  onToggleHistory,
  onHistoryClick,
  onOpenSourcesTray,
}: CoachDrawerBodyProps) {
  const { t } = useTranslations();
  // The page surface (inline `historyRail`) carries the collapsible
  // grid; without a rail the body is a single column (drawer surface).
  const railExpanded = !!historyRail && historyOpen;
  return (
    <div
      data-slot="coach-drawer-body"
      data-history-open={
        historyRail ? (historyOpen ? "true" : "false") : undefined
      }
      // v1.18.7 — the inline rail column animates between 0 and a fixed
      // width so collapsing it hands the full width back to the thread
      // without a layout jump. Without a rail the body is a single
      // column. `transition-[grid-template-columns]` keeps the fold
      // smooth on the page surface; the thread column is always `1fr`.
      className={cn(
        "grid min-h-0 flex-1 grid-cols-1",
        historyRail &&
          "lg:grid-cols-[0px_1fr] lg:transition-[grid-template-columns] lg:duration-300 motion-reduce:lg:transition-none",
        railExpanded && "lg:grid-cols-[320px_1fr]",
      )}
    >
      {/* Inline history column — page surface, lg+ only, collapsible. */}
      {historyRail && (
        <aside
          data-slot="coach-drawer-history"
          data-open={historyOpen ? "true" : "false"}
          // Collapsed: zero-width + clipped so the list is fully hidden
          // and non-interactive; expanded: a bordered left column. The
          // `overflow-hidden` keeps the content from spilling during the
          // width transition.
          className={cn(
            "hidden h-full min-h-0 overflow-hidden lg:flex lg:flex-col",
            railExpanded
              ? "border-border/70 border-r opacity-100"
              : "pointer-events-none opacity-0",
          )}
          aria-hidden={!historyOpen}
        >
          {/* v1.18.7 — the rail heading shares the `h-14` band + `border-b`
              with the centre column's rail-tray strip so the two dividers
              land on one horizontal line, and carries the collapse
              control on its trailing edge. */}
          <div className="border-border/70 flex h-14 shrink-0 items-center justify-between border-b px-4">
            <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("insights.coach.historyTitle")}
            </h2>
            {onToggleHistory && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onToggleHistory}
                data-slot="coach-history-collapse"
                aria-label={t("insights.coach.hideConversations")}
                aria-expanded={historyOpen}
                title={t("insights.coach.hideConversations")}
                className="text-muted-foreground hover:text-foreground -mr-1 size-9 shrink-0"
              >
                <PanelLeftClose className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
          {/* v1.18.6 (CCH-01) — `<HistoryRail>` is itself a `flex h-full
              flex-col` with its OWN `overflow-y-auto` list, so a single
              bounded flex track here is all it needs; do not nest a
              second scroll container. */}
          <div className="flex min-h-0 flex-1 flex-col">{historyRail}</div>
        </aside>
      )}

      {/* Centre — message thread. */}
      <main
        data-slot="coach-drawer-thread"
        className="flex h-full min-h-0 min-w-0 flex-col"
      >
        {/* v1.4.27 R3d MB2 — rail-tray triggers lifted out of the
            absolute overlay into a sub-header strip so the buttons
            sit at a 44 px tap target and never overlay the first
            message bubble.
            v1.18.7 — fixed `h-14` so the strip's bottom border aligns
            with the history rail heading divider in the adjacent column.
            On the page surface the left control is the rail TOGGLE
            (clean show/hide) on lg+, falling back to the tray trigger
            below lg; the drawer keeps the plain conversations button. */}
        <div
          data-slot="coach-drawer-rail-tray-strip"
          className="border-border/70 flex h-14 shrink-0 items-center justify-between gap-2 border-b px-3 sm:px-4"
        >
          {/* Left control(s). On the page surface (inline rail) the
              affordance forks by breakpoint: below lg a tray trigger
              opens the bottom sheet; on lg+ a clean toggle shows/hides
              the inline rail (and the lg+ toggle hides once the rail is
              expanded, since the rail heading then owns the close
              control). Without an inline rail (drawer surface) the
              single button hands off via `onHistoryClick`. */}
          {historyRail && onToggleHistory ? (
            <>
              {/* Sub-lg: open the bottom tray. */}
              <Button
                type="button"
                variant="ghost"
                onClick={onHistoryClick}
                data-slot="coach-drawer-history-tray-trigger"
                aria-label={t("insights.coach.historyTitle")}
                className="text-muted-foreground hover:text-foreground min-h-11 gap-1.5 text-xs lg:hidden"
              >
                <MessagesSquare className="size-4" aria-hidden="true" />
                {t("insights.coach.historyTitle")}
              </Button>
              {/* lg+: toggle the inline rail (hidden while expanded). */}
              <Button
                type="button"
                variant="ghost"
                onClick={onToggleHistory}
                data-slot="coach-history-toggle"
                aria-label={t("insights.coach.showConversations")}
                aria-expanded={historyOpen}
                className={cn(
                  "text-muted-foreground hover:text-foreground hidden min-h-11 gap-1.5 text-xs lg:flex",
                  railExpanded && "lg:hidden",
                )}
              >
                <MessagesSquare className="size-4" aria-hidden="true" />
                {t("insights.coach.historyTitle")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              onClick={onHistoryClick}
              data-slot="coach-drawer-history-tray-trigger"
              aria-label={t("insights.coach.historyTitle")}
              className="text-muted-foreground hover:text-foreground min-h-11 gap-1.5 text-xs"
            >
              <MessagesSquare className="size-4" aria-hidden="true" />
              {t("insights.coach.historyTitle")}
            </Button>
          )}
          {/* Sources toggle — the rail is hidden by default on every
              viewport and opens as the right-edge tray. */}
          <Button
            type="button"
            variant="ghost"
            onClick={onOpenSourcesTray}
            data-slot="coach-drawer-sources-tray-trigger"
            aria-label={t("insights.coach.sourcesTitle")}
            className="text-muted-foreground hover:text-foreground ml-auto min-h-11 gap-1.5 text-xs"
          >
            {t("insights.coach.sourcesTitle")}
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {/* v1.18.6.1 — the thread wrapper must be a flex column itself so the
            `<MessageThread>` scroll region resolves a bounded height. */}
        <div className="flex min-h-0 flex-1 flex-col">{thread}</div>
        {/* Composer pinned to the bottom. */}
        <div
          data-slot="coach-drawer-composer"
          className="border-border/70 @container/composer relative flex flex-col gap-2 border-t p-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] sm:p-4 sm:pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]"
        >
          {composer}
          {newChat}
        </div>
      </main>
    </div>
  );
}
