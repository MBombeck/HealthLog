"use client";

import { useMemo, useState } from "react";
import {
  Loader2,
  MessagesSquare,
  Paperclip,
  RotateCw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLoadMoreSentinel } from "@/hooks/use-load-more-sentinel";

import { COACH_SCROLLBAR } from "./message-thread";
import { ConversationRename } from "./conversation-rename";
import {
  useCoachConversationHistory,
  useDeleteCoachConversationWithUndo,
} from "./use-coach";

/**
 * v1.4.20 phase B2b — conversation history rail.
 *
 * Lives in the left column of the Coach drawer on `lg+`. Renders the
 * caller's FULL conversation history (v1.30.2 — cursor-paginated via
 * `useInfiniteQuery`, loaded incrementally as the list scrolls near its
 * end), lets the user search by title (server-side, debounced 200 ms),
 * select one to resume, and delete with an undo-able confirm.
 *
 * Selection / activeId is a controlled prop so the drawer owns the
 * authoritative state across the message thread + composer.
 *
 * Empty + loading + error states are all rendered inline — the rail
 * never collapses to "0 px" so the layout stays predictable.
 */
export interface HistoryRailProps {
  activeId: string | null;
  onSelect: (id: string) => void;
  /**
   * Optional className passthrough so the parent can override the
   * default layout (currently the drawer wraps it in an `<aside>`).
   */
  className?: string;
  /**
   * v1.18.1 — suppress the rail's own `<h3>` "Conversations" label. The
   * page surface wraps the rail in an `<aside>` that already renders an
   * `<h2>` band heading with the same text, so the inline rail must not
   * stack a second identical heading. Defaults to `false` (the mobile
   * tray + standalone uses keep the heading).
   */
  hideHeading?: boolean;
}

export function HistoryRail({
  activeId,
  onSelect,
  className,
  hideHeading = false,
}: HistoryRailProps) {
  const { t, locale } = useTranslations();
  const [filter, setFilter] = useState<string>("");
  // v1.30.2 (QoL H1) — the search box now drives a SERVER-side query
  // (title-only substring, see the route doc comment), so debounce the
  // keystroke draft rather than re-issuing a request per character.
  const debouncedFilter = useDebouncedValue(filter, 200);
  const {
    conversations,
    isLoading,
    isError,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useCoachConversationHistory({ search: debouncedFilter });
  const { pendingDeleteIds, requestDelete, undoDelete } =
    useDeleteCoachConversationWithUndo();

  // pendingDeleteIds is a client-only hide filter for the just-armed undo
  // window — the server-side search already resolved the rest of `visible`.
  const visible = useMemo(
    () => conversations.filter((c) => !pendingDeleteIds.has(c.id)),
    [conversations, pendingDeleteIds],
  );
  const isSearching = debouncedFilter.trim().length > 0;

  // A `useState`-backed callback ref (not a plain `useRef`) so the
  // container's assignment itself triggers a re-render — the sentinel
  // hook's effect depends on `root` and must re-run once the real DOM
  // node exists (it's null during the very first render pass).
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useLoadMoreSentinel({
    enabled: hasNextPage && !isFetchingNextPage,
    onLoadMore: fetchNextPage,
    root: listNode,
  });

  // v1.30.1 M5 — a single tap hides the row and schedules the real
  // delete; the toast's Undo action cancels it within the grace
  // window. Replaces the old arm-then-tap-again confirm, which never
  // disarmed. If the user just deleted the active thread, the drawer
  // is listening to `onSelect` for navigation; we leave it to the
  // parent to clear `activeId` when the conversation disappears.
  function handleDeleteRequest(id: string) {
    requestDelete(id);
    toast.success(t("insights.coach.historyDeleted"), {
      action: {
        label: t("common.undo"),
        onClick: () => undoDelete(id),
      },
    });
  }

  return (
    <div
      data-slot="coach-history-rail"
      // v1.18.1 (W-COACH-UI C1/C3) — a touch more horizontal padding so
      // the list rows clear the rail edge and the search field breathes.
      // L5 fix (`.planning/audits/2026-07-18-qa-ui.md`) — `gap-2.5 p-3.5`
      // was off the `1/1.5/2/3/4/6/8/10` spacing scale.
      className={cn("flex h-full min-h-0 flex-col gap-2 p-3", className)}
    >
      {/* v1.4.33 — promote the rail label from a `<span>` to a real
          `<h3>` so the drawer carries a semantic outline on desktop
          where the rail is mounted inline (no `SheetTitle` wrapper).
          The mobile rail-tray still wraps the rail inside its own
          `SheetTitle`, so screen-reader users hear the section twice
          when the tray is open — that's intentional Radix behaviour
          (the rail still has to stand alone on desktop). */}
      {!hideHeading && (
        <h3
          data-slot="coach-history-rail-heading"
          className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase"
        >
          <MessagesSquare
            className="text-muted-foreground size-3.5"
            aria-hidden="true"
          />
          {t("insights.coach.historyTitle")}
        </h3>
      )}
      <div className="relative w-full">
        <Search
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
        />
        <Input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("insights.coach.historySearchPlaceholder")}
          data-slot="coach-history-search"
          // Full-width, comfortable field (matches the standalone
          // conversations page) instead of the old thin h-9 strip.
          className="h-10 w-full pl-9"
        />
      </div>
      <div
        ref={setListNode}
        data-slot="coach-history-list"
        className={cn(
          "-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1",
          // v1.18.7 — same thin/rounded/subtle scrollbar as the thread.
          COACH_SCROLLBAR,
        )}
      >
        {isLoading && visible.length === 0 ? (
          <p
            data-slot="coach-history-loading"
            className="text-muted-foreground px-2 py-3 text-sm"
          >
            {t("common.loading")}
          </p>
        ) : isError && visible.length === 0 ? (
          // A load failure must not masquerade as "no conversations yet" —
          // offer a retry instead of the empty copy.
          <div
            data-slot="coach-history-error"
            className="text-muted-foreground flex flex-col items-start gap-2 px-2 py-3 text-sm"
          >
            <p>{t("common.loadFailed")}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RotateCw className="size-3.5" aria-hidden="true" />
              {t("common.retry")}
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <p
            data-slot="coach-history-empty"
            className="text-muted-foreground px-2 py-3 text-sm leading-relaxed"
          >
            {isSearching
              ? t("insights.coach.historySearchEmpty")
              : t("insights.coach.historyEmpty")}
          </p>
        ) : (
          visible.map((c) => {
            const isActive = c.id === activeId;
            return (
              <div
                key={c.id}
                data-slot="coach-history-item"
                data-active={isActive ? "true" : undefined}
                className={cn(
                  "group relative flex items-center gap-1.5 rounded-lg px-2.5 py-2",
                  "text-sm transition-colors",
                  isActive
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className="min-w-0 flex-1 truncate text-left"
                  data-slot="coach-history-select"
                >
                  <span className="flex min-w-0 items-center gap-1.5 font-medium">
                    {/* v1.29.x (S7) — a fenced thread runs on the hardened
                        fenced endpoint over its attached documents; badge it
                        with a paperclip (+ count when more than one) so it
                        reads as distinct in the rail. */}
                    {c.fenced ? (
                      <span
                        className="text-primary inline-flex shrink-0 items-center gap-0.5"
                        aria-label={t("insights.coach.attach.railBadge")}
                      >
                        <Paperclip className="size-3.5" aria-hidden="true" />
                        {(c.attachments?.length ?? 0) > 1 ? (
                          <span className="text-[10px] font-semibold tabular-nums">
                            {c.attachments?.length}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                    <span className="truncate">{c.title}</span>
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {formatRelativeTime(c.updatedAt, t, locale)}
                  </span>
                </button>
                <ConversationRename id={c.id} title={c.title} compact />
                {/* v1.4.27 R3d MB2 — drop the hover-only `opacity-0`
                    reveal: touch surfaces have no hover, so the delete
                    affordance was invisible on mobile. The button
                    sits at 44 px always-visible per the WCAG 2.5.5
                    floor. v1.30.1 M5 — one tap deletes (with an Undo
                    toast); the old arm/confirm double-tap is gone. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDeleteRequest(c.id)}
                  aria-label={t("insights.coach.historyDeleteAria")}
                  data-slot="coach-history-delete"
                  className="size-11 shrink-0"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            );
          })
        )}
        {/* v1.30.2 (QoL H1) — IntersectionObserver sentinel: scrolling this
            div into the rail's own scrollport pulls the next cursor page.
            Empty + aria-hidden — the loading row right below it is the
            a11y-visible signal. */}
        {visible.length > 0 && hasNextPage ? (
          <div ref={sentinelRef} aria-hidden="true" className="h-px" />
        ) : null}
        {isFetchingNextPage ? (
          <div
            data-slot="coach-history-loading-more"
            role="status"
            className="text-muted-foreground flex items-center justify-center gap-2 px-2 py-3 text-xs"
          >
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t("insights.coach.historyLoadingMore")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
