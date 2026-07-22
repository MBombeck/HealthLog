"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Loader2,
  MessagesSquare,
  Paperclip,
  Search,
  Target,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { COACH_SCROLLBAR } from "@/components/insights/coach-panel/message-thread";
import { ConversationRename } from "@/components/insights/coach-panel/conversation-rename";
import {
  useCoachConversationHistory,
  useDeleteCoachConversationWithUndo,
} from "@/components/insights/coach-panel/use-coach";
import type { CoachConversationDTO } from "@/lib/ai/coach/types";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useDisableCoach } from "@/hooks/use-disable-coach";
import { useLoadMoreSentinel } from "@/hooks/use-load-more-sentinel";
import { useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";
import { cn } from "@/lib/utils";

/**
 * v1.21.4 (Coach-UI B) — dedicated conversation-history page.
 *
 * Replaces the left slide-in `<Sheet>` drawer that the `+` menu's
 * "Conversations" affordance used to open. The list now reads as a
 * sibling of the Coach page itself: a search field at the top, then the
 * recent conversations grouped by recency (Today / Yesterday / This week
 * / Earlier). Selecting a row routes to `/coach?c=<id>` — the existing
 * deep-link open mechanism. Reuses the SAME `/coach?c=<id>` open
 * mechanism the rail uses.
 *
 * v1.30.2 (QoL H1) — the page is a thin read over
 * `useCoachConversationHistory()` (cursor-paginated + server-searched, see
 * the route's doc comment), which the drawer's `<HistoryRail>` also
 * consumes — the two surfaces can no longer drift onto different
 * pagination behaviour.
 *
 * Gating mirrors `/coach`: the operator master flag OR a per-user opt-out
 * hides the Coach entirely and redirects back to `/insights` rather than
 * painting a dead shell. The full-bleed sizing wrapper matches the Coach
 * page so the two surfaces share one chrome.
 */

type RecencyGroupId = "today" | "yesterday" | "thisWeek" | "earlier";

interface RecencyGroup {
  id: RecencyGroupId;
  labelKey: string;
  conversations: CoachConversationDTO[];
}

/**
 * Bucket conversations by LOCAL calendar recency. `updatedAt` is an ISO
 * string; comparisons run against local day boundaries so "Today" tracks
 * the user's own midnight, not UTC.
 */
function groupByRecency(conversations: CoachConversationDTO[]): RecencyGroup[] {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  // "This week" = the six days before yesterday (a rolling 7-day window
  // that already excludes today + yesterday, which have their own groups).
  const startOfWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;

  const groups: Record<RecencyGroupId, CoachConversationDTO[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };

  for (const conversation of conversations) {
    const updated = new Date(conversation.updatedAt).getTime();
    if (updated >= startOfToday) groups.today.push(conversation);
    else if (updated >= startOfYesterday) groups.yesterday.push(conversation);
    else if (updated >= startOfWeek) groups.thisWeek.push(conversation);
    else groups.earlier.push(conversation);
  }

  return (
    [
      { id: "today", labelKey: "insights.coach.history.groupToday" },
      { id: "yesterday", labelKey: "insights.coach.history.groupYesterday" },
      { id: "thisWeek", labelKey: "insights.coach.history.groupThisWeek" },
      { id: "earlier", labelKey: "insights.coach.history.groupEarlier" },
    ] as const
  )
    .map((g) => ({ ...g, conversations: groups[g.id] }))
    .filter((g) => g.conversations.length > 0);
}

function CoachConversationsBody() {
  const { t, locale } = useTranslations();
  const router = useRouter();
  const [filter, setFilter] = useState<string>("");
  // v1.30.2 (QoL H1) — search now drives the server-side title query;
  // debounce the keystroke draft instead of re-issuing a request per key.
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
  // window — the server already resolved the rest of `visible` against the
  // search term.
  const visible = useMemo(
    () => conversations.filter((c) => !pendingDeleteIds.has(c.id)),
    [conversations, pendingDeleteIds],
  );
  const isSearching = debouncedFilter.trim().length > 0;

  const groups = useMemo(() => groupByRecency(visible), [visible]);

  // Same callback-ref pattern as the rail: a `useState` setter (not a plain
  // `useRef`) so the sentinel hook's `root` re-fires its effect once the
  // real scroll-container node exists (null on the very first render).
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useLoadMoreSentinel({
    enabled: hasNextPage && !isFetchingNextPage,
    onLoadMore: fetchNextPage,
    root: listNode,
  });

  function handleSelect(id: string) {
    // Reuse the existing `?c=<id>` open mechanism on the Coach page.
    router.push(`/coach?c=${id}`);
  }

  // v1.30.1 M5 — one tap deletes (with an Undo toast); see
  // `use-coach.ts`'s `useDeleteCoachConversationWithUndo` for the
  // rationale — this mirrors the rail's identical fix.
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
    <div className="mx-auto flex h-full min-h-0 w-full max-w-screen-xl flex-col gap-4 px-4 pt-6 pb-4 md:px-6">
      <header className="flex flex-col gap-3">
        <PageHeader
          title={
            <span data-slot="coach-conversations-heading">
              {t("insights.coach.historyTitle")}
            </span>
          }
          actions={
            // Surface the sibling Plans ledger — otherwise it is reachable
            // only from the composer's `+` menu.
            <Button asChild variant="outline" size="sm">
              <Link
                href="/coach/plans"
                data-slot="coach-conversations-plans-link"
              >
                <Target className="size-4" aria-hidden="true" />
                {t("coach.plans.title")}
              </Link>
            </Button>
          }
        />
        <div className="relative">
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("insights.coach.historySearchPlaceholder")}
            data-slot="coach-conversations-search"
            className="h-11 pl-9"
          />
        </div>
      </header>

      <div
        ref={setListNode}
        data-slot="coach-conversations-list"
        className={cn(
          "-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1",
          COACH_SCROLLBAR,
        )}
      >
        {isLoading && visible.length === 0 ? (
          <p
            data-slot="coach-conversations-loading"
            className="text-muted-foreground px-1 py-3 text-sm"
          >
            {t("common.loading")}
          </p>
        ) : isError && visible.length === 0 ? (
          // A load failure must not masquerade as "no conversations yet" —
          // that reads as a data-loss scare and offers no way back. Mirror
          // /coach/plans and surface a retry.
          <QueryErrorCard onRetry={() => refetch()} />
        ) : groups.length === 0 ? (
          <div
            data-slot="coach-conversations-empty"
            className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center"
          >
            <span className="bg-muted/40 text-muted-foreground flex size-12 items-center justify-center rounded-full">
              <MessagesSquare className="size-6" aria-hidden="true" />
            </span>
            <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
              {isSearching
                ? t("insights.coach.historySearchEmpty")
                : t("insights.coach.historyEmpty")}
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <section
              key={group.id}
              data-slot="coach-conversations-group"
              data-group={group.id}
              className="flex flex-col gap-1.5"
            >
              <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
                {t(group.labelKey)}
              </h2>
              <ul className="flex flex-col gap-1">
                {group.conversations.map((c) => {
                  return (
                    <li
                      key={c.id}
                      data-slot="coach-conversations-item"
                      className={cn(
                        "group relative flex items-center gap-1.5 rounded-xl px-3 py-2.5",
                        "text-sm transition-colors",
                        "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => handleSelect(c.id)}
                        className="flex min-h-11 min-w-0 flex-1 flex-col justify-center text-left"
                        data-slot="coach-conversations-select"
                      >
                        <span className="flex min-w-0 items-center gap-1.5 font-medium">
                          {/* v1.29.x (S7) — badge fenced threads (they run on
                              the hardened fenced endpoint over their attached
                              documents) with a paperclip + attachment count. */}
                          {c.fenced ? (
                            <span
                              className="text-primary inline-flex shrink-0 items-center gap-0.5"
                              aria-label={t("insights.coach.attach.railBadge")}
                            >
                              <Paperclip
                                className="size-3.5"
                                aria-hidden="true"
                              />
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
                      <ConversationRename id={c.id} title={c.title} />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-lg"
                        onClick={() => handleDeleteRequest(c.id)}
                        aria-label={t("insights.coach.historyDeleteAria")}
                        data-slot="coach-conversations-delete"
                        className="shrink-0"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
        {/* v1.30.2 (QoL H1) — same IntersectionObserver sentinel as the
            drawer rail: scrolling this div into view pulls the next cursor
            page. Empty + aria-hidden; the status row below is the a11y
            signal. */}
        {visible.length > 0 && hasNextPage ? (
          <div ref={sentinelRef} aria-hidden="true" className="h-px" />
        ) : null}
        {isFetchingNextPage ? (
          <div
            data-slot="coach-conversations-loading-more"
            role="status"
            className="text-muted-foreground flex items-center justify-center gap-2 py-3 text-xs"
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

export default function CoachConversationsPage() {
  const router = useRouter();
  const launch = useCoachLaunch();
  const flags = useFeatureFlags();
  const disableCoach = useDisableCoach();

  const coachUnavailable = !flags.coach || disableCoach;

  // Same gating as `/coach`: operator master flag OR per-user opt-out
  // redirects back to the Insights mother page so the route is never a
  // dead-end.
  useEffect(() => {
    if (coachUnavailable) {
      router.replace("/insights");
    }
  }, [coachUnavailable, router]);

  // Keep the launch context referenced so the shared FAB drawer the page
  // hands back to stays mounted (mirrors `/coach`).
  void launch;

  if (coachUnavailable) return null;

  return (
    <div
      data-slot="coach-conversations-page"
      // Match `/coach`'s full-bleed sizing: cancel the AuthShell padding
      // and claim the viewport height below the top bar (minus the
      // mobile-only BottomNav band). L4 fix
      // (`.planning/audits/2026-07-18-qa-ui.md`) — this had dropped the
      // `safe-area-inset-top` term `/coach` subtracts, overshooting by
      // ~50px on notched devices; restored to match exactly.
      className="bg-background -mx-4 -mt-6 -mb-20 flex h-[calc(100dvh-8rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] min-h-[32rem] flex-col overflow-hidden md:-mx-6 md:h-[calc(100dvh-4rem)]"
    >
      <CoachConversationsBody />
    </div>
  );
}
