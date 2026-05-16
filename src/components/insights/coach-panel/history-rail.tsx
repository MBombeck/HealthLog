"use client";

import { useMemo, useState } from "react";
import { MessagesSquare, Search, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";

import { useCoachConversations, useDeleteCoachConversation } from "./use-coach";

/**
 * v1.4.20 phase B2b — conversation history rail.
 *
 * Lives in the left column of the Coach drawer on `lg+`. Renders the
 * paginated list returned by `GET /api/insights/chat`, lets the user
 * filter by title (substring match), select one to resume, and delete
 * with a confirm-then-go flow.
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
}

export function HistoryRail({
  activeId,
  onSelect,
  className,
}: HistoryRailProps) {
  const { t } = useTranslations();
  const { conversations, isLoading } = useCoachConversations();
  const deleteMutation = useDeleteCoachConversation();
  const [filter, setFilter] = useState<string>("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, filter]);

  function handleDeleteRequest(id: string) {
    if (confirmId === id) {
      deleteMutation.mutate(id);
      setConfirmId(null);
      // If the user just deleted the active thread, the drawer is
      // listening to `onSelect` for navigation; we leave it to the
      // parent to clear `activeId` when the conversation disappears.
    } else {
      setConfirmId(id);
    }
  }

  return (
    <div
      data-slot="coach-history-rail"
      className={cn("flex h-full min-h-0 flex-col gap-2 p-3", className)}
    >
      {/* v1.4.33 — promote the rail label from a `<span>` to a real
          `<h3>` so the drawer carries a semantic outline on desktop
          where the rail is mounted inline (no `SheetTitle` wrapper).
          The mobile rail-tray still wraps the rail inside its own
          `SheetTitle`, so screen-reader users hear the section twice
          when the tray is open — that's intentional Radix behaviour
          (the rail still has to stand alone on desktop). */}
      <h3
        data-slot="coach-history-rail-heading"
        className="text-muted-foreground flex items-center gap-1.5 px-1 text-[11px] font-medium tracking-wide uppercase"
      >
        <MessagesSquare
          className="text-muted-foreground size-3.5"
          aria-hidden="true"
        />
        {t("insights.coach.historyTitle")}
      </h3>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
        />
        <Input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("insights.coach.historySearchPlaceholder")}
          data-slot="coach-history-search"
          className="h-8 pl-7 text-xs"
        />
      </div>
      <div
        data-slot="coach-history-list"
        className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1"
      >
        {isLoading && conversations.length === 0 ? (
          <p
            data-slot="coach-history-loading"
            className="text-muted-foreground px-2 py-3 text-xs"
          >
            {t("common.loading")}
          </p>
        ) : filtered.length === 0 ? (
          <p
            data-slot="coach-history-empty"
            className="text-muted-foreground px-2 py-3 text-xs leading-relaxed"
          >
            {t("insights.coach.historyEmpty")}
          </p>
        ) : (
          filtered.map((c) => {
            const isActive = c.id === activeId;
            const isConfirming = confirmId === c.id;
            return (
              <div
                key={c.id}
                data-slot="coach-history-item"
                data-active={isActive ? "true" : undefined}
                className={cn(
                  "group flex items-center gap-1.5 rounded-md px-2 py-1.5",
                  "text-xs transition-colors",
                  isActive
                    ? "bg-dracula-purple/15 text-foreground"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className="min-w-0 flex-1 truncate text-left"
                  data-slot="coach-history-select"
                >
                  <span className="block truncate font-medium">{c.title}</span>
                  <span className="text-muted-foreground block text-[10px]">
                    {formatRelativeTime(c.updatedAt, t)}
                  </span>
                </button>
                {/* v1.4.27 R3d MB2 — drop the hover-only `opacity-0`
                    reveal: touch surfaces have no hover, so the delete
                    affordance was invisible on mobile. The button now
                    sits at 44 px always-visible per the WCAG 2.5.5
                    floor; confirming state stays styled via the
                    `data-confirming` attribute. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDeleteRequest(c.id)}
                  aria-label={
                    isConfirming
                      ? t("insights.coach.historyDeleteConfirm")
                      : t("insights.coach.historyDeleteAria")
                  }
                  data-slot="coach-history-delete"
                  data-confirming={isConfirming ? "true" : undefined}
                  className={cn(
                    "size-11 shrink-0",
                    isConfirming &&
                      "text-dracula-red hover:text-dracula-red",
                  )}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
