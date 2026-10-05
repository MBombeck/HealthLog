"use client";

import { useMemo, useRef, useState } from "react";
import {
  Loader2,
  MessagesSquare,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RotateCw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLoadMoreSentinel } from "@/hooks/use-load-more-sentinel";
import type { CoachConversationDTO } from "@/lib/ai/coach/types";
import { groupConversationsByRecency } from "@/lib/insights/coach-conversation-groups";

import { COACH_SCROLLBAR } from "./message-thread";
import { ConversationRename } from "./conversation-rename";
import {
  useCoachConversationHistory,
  useDeleteCoachConversationWithUndo,
} from "./use-coach";

/**
 * The Coach's conversation list: search, the full history grouped by recency
 * (Today / Yesterday / This week / Earlier), and one row per conversation with
 * a "⋯" menu for Rename and Delete.
 *
 * It fills the Coach page's conversations panel and the drawer's history
 * tray. The history is cursor-paginated (`useInfiniteQuery`, loaded as the
 * list scrolls near its end) and searched server-side on the title, debounced
 * 200 ms.
 *
 * Rename edits the title in place (`ConversationRename`, Enter saves, Escape
 * cancels without closing the panel around it) and returns focus to the row's
 * menu button. Delete hides the row at once and commits after the undo window
 * (`useDeleteCoachConversationWithUndo`); the toast carries the Undo. A
 * surface that can unmount the list while a delete is pending (the panel's
 * sheet) passes its own `deletion` from a component that stays mounted, so
 * closing the sheet does not cut the undo window short.
 *
 * Selection is a controlled prop: the surface owns the active conversation.
 * Loading, error and empty states render inline so the list never collapses.
 */
export interface HistoryRailProps {
  activeId: string | null;
  onSelect: (id: string) => void;
  className?: string;
  /**
   * Suppress the list's own `<h3>` label when the surface already titles it
   * (the conversations panel has its own header).
   */
  hideHeading?: boolean;
  /**
   * The delete-with-undo state, owned by a component that outlives this list.
   * Omitted, the list keeps its own.
   */
  deletion?: ReturnType<typeof useDeleteCoachConversationWithUndo>;
  /**
   * Called when the conversation being deleted is the open one, before the
   * row hides, so the surface can move off it; `onUndo` puts it back.
   */
  onDeleteActive?: (id: string) => void;
  onUndoDeleteActive?: (id: string) => void;
}

export function HistoryRail({
  activeId,
  onSelect,
  className,
  hideHeading = false,
  deletion,
  onDeleteActive,
  onUndoDeleteActive,
}: HistoryRailProps) {
  const { t } = useTranslations();
  const [filter, setFilter] = useState<string>("");
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
  const ownDeletion = useDeleteCoachConversationWithUndo();
  const { pendingDeleteIds, requestDelete, undoDelete } =
    deletion ?? ownDeletion;

  // `pendingDeleteIds` hides rows inside the undo window; the server-side
  // search already resolved everything else.
  const visible = useMemo(
    () => conversations.filter((c) => !pendingDeleteIds.has(c.id)),
    [conversations, pendingDeleteIds],
  );
  const groups = useMemo(() => groupConversationsByRecency(visible), [visible]);
  const isSearching = debouncedFilter.trim().length > 0;

  // A `useState`-backed callback ref so the sentinel hook re-runs once the
  // scroll container exists (null on the very first render).
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useLoadMoreSentinel({
    enabled: hasNextPage && !isFetchingNextPage,
    onLoadMore: fetchNextPage,
    root: listNode,
  });

  function handleDeleteRequest(id: string) {
    const wasActive = id === activeId;
    if (wasActive) onDeleteActive?.(id);
    requestDelete(id);
    toast.success(t("insights.coach.historyDeleted"), {
      action: {
        label: t("common.undo"),
        onClick: () => {
          undoDelete(id);
          if (wasActive) onUndoDeleteActive?.(id);
        },
      },
    });
  }

  return (
    <div
      data-slot="coach-history-rail"
      className={cn("flex h-full min-h-0 flex-col gap-2 p-3", className)}
    >
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
          aria-label={t("insights.coach.historySearchPlaceholder")}
          data-slot="coach-history-search"
          className="h-10 w-full pl-9"
        />
      </div>
      <div
        ref={setListNode}
        data-slot="coach-history-list"
        className={cn(
          // `pb-20` keeps the last row clear of the panel's floating New
          // chat button; it pads this list's own scroll area, not `main`.
          "-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-1 pb-20",
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
          // A load failure must not read as "no conversations yet".
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
        ) : groups.length === 0 ? (
          <p
            data-slot="coach-history-empty"
            className="text-muted-foreground px-2 py-3 text-sm leading-relaxed"
          >
            {isSearching
              ? t("insights.coach.historySearchEmpty")
              : t("insights.coach.historyEmpty")}
          </p>
        ) : (
          groups.map((group) => (
            <section
              key={group.id}
              data-slot="coach-history-group"
              data-group={group.id}
              aria-label={t(group.labelKey)}
              className="flex flex-col gap-1"
            >
              {/* h3: one step under the panel's h2 title, and a sibling of the
                  list's own h3 label where that shows (heading order). */}
              <h3 className="text-muted-foreground px-2 text-xs font-medium tracking-wide uppercase">
                {t(group.labelKey)}
              </h3>
              <ul className="flex flex-col gap-0.5">
                {group.conversations.map((c) => (
                  <HistoryRow
                    key={c.id}
                    conversation={c}
                    active={c.id === activeId}
                    onSelect={onSelect}
                    onDelete={handleDeleteRequest}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
        {/* IntersectionObserver sentinel: scrolling it into the list's own
            scrollport pulls the next cursor page. */}
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

function HistoryRow({
  conversation: c,
  active,
  onSelect,
  onDelete,
}: {
  conversation: CoachConversationDTO;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslations();
  const [renaming, setRenaming] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  // Set when the menu closes INTO the rename editor, so the menu does not
  // hand focus back to its trigger and steal it from the title field.
  const openingRenameRef = useRef(false);

  function endRename() {
    setRenaming(false);
    // Back to the row's menu button, where the edit started.
    requestAnimationFrame(() => menuTriggerRef.current?.focus());
  }

  return (
    <li
      data-slot="coach-history-item"
      data-active={active ? "true" : undefined}
      className="group/row relative"
    >
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        aria-current={active ? "true" : undefined}
        title={c.title}
        data-slot="coach-history-select"
        className={cn(
          "flex min-h-11 w-full min-w-0 items-center gap-1.5 rounded-md py-2 pr-11 pl-2 text-left text-sm transition-colors pointer-fine:min-h-9",
          "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
          // The open conversation reads like the open page in the left
          // navigation: the same primary wash, so the two rails agree.
          active
            ? "bg-primary/10 text-primary font-medium"
            : "text-foreground hover:bg-muted/60",
        )}
      >
        {/* A fenced thread runs on the hardened document endpoint over its
            attachments; the paperclip (with a count above one) marks it. */}
        {c.fenced ? (
          <span
            className="text-primary inline-flex shrink-0 items-center gap-0.5"
            aria-label={t("insights.coach.attach.railBadge")}
          >
            <Paperclip className="size-3.5" aria-hidden="true" />
            {(c.attachments?.length ?? 0) > 1 ? (
              <span className="text-2xs font-semibold tabular-nums">
                {c.attachments?.length}
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="min-w-0 truncate">{c.title}</span>
      </button>

      {renaming ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={menuTriggerRef}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("insights.coach.frame.rowActions", {
                title: c.title,
              })}
              data-slot="coach-history-row-menu"
              className={cn(
                "text-muted-foreground hover:text-foreground absolute top-1/2 right-0 size-11 -translate-y-1/2 pointer-fine:right-1 pointer-fine:size-9",
                // Pointer devices reveal it on hover or focus; touch shows it
                // always, since there is no hover to reveal it with.
                "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/row:opacity-100 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:data-[state=open]:opacity-100",
              )}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-44"
            onCloseAutoFocus={(event) => {
              if (openingRenameRef.current) {
                openingRenameRef.current = false;
                event.preventDefault();
              }
            }}
          >
            <DropdownMenuItem
              data-slot="coach-history-rename"
              onSelect={() => {
                openingRenameRef.current = true;
                setRenaming(true);
              }}
            >
              <Pencil aria-hidden="true" />
              {t("insights.coach.frame.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              data-slot="coach-history-delete"
              onSelect={() => onDelete(c.id)}
            >
              <Trash2 aria-hidden="true" />
              {t("insights.coach.frame.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <ConversationRename
        id={c.id}
        title={c.title}
        editing={renaming}
        onEditingChange={(next) => {
          if (!next) endRename();
        }}
      />
    </li>
  );
}
