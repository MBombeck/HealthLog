"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { MessagesSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { ConversationTranscript } from "@/components/insights/coach-panel/conversation-transcript";
import {
  useCoachConversationHistory,
  useDeleteCoachConversationWithUndo,
} from "@/components/insights/coach-panel/use-coach";
import { useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";

/**
 * The Coach's stored conversations, readable and deletable from Settings.
 *
 * A conversation is the person's own record, not a cache, so it stays
 * reachable whatever the Coach's state: switched off by the operator, hidden
 * by the person, without a provider or without consent. Each row opens its
 * transcript in place and can be deleted (with the same undo window the
 * conversation list uses). Reading and deleting never ask the Coach; the
 * routes behind them are data routes.
 *
 * The card links to `/coach/conversations`, which stays reachable and
 * read-only with the Coach off, so the full list and its search are one step
 * away even when no navigation entry leads there.
 *
 * `hideWhenEmpty`: the card renders nothing when there is nothing stored.
 * Settings → AI mounts it that way while the Coach is off, so it appears only
 * when there is something to see.
 */
export function CoachConversationsMemoryCard({
  isAuthenticated,
  hideWhenEmpty = false,
}: {
  isAuthenticated: boolean;
  hideWhenEmpty?: boolean;
}) {
  const { t, locale } = useTranslations();
  const [openId, setOpenId] = useState<string | null>(null);
  const history = useCoachConversationHistory({ enabled: isAuthenticated });
  const { pendingDeleteIds, requestDelete, undoDelete } =
    useDeleteCoachConversationWithUndo();

  const visible = useMemo(
    () => history.conversations.filter((c) => !pendingDeleteIds.has(c.id)),
    [history.conversations, pendingDeleteIds],
  );

  if (hideWhenEmpty && (history.isLoading || history.isError)) return null;
  if (hideWhenEmpty && visible.length === 0) return null;

  function remove(id: string) {
    requestDelete(id);
    if (openId === id) setOpenId(null);
    toast.success(t("insights.coach.historyDeleted"), {
      action: { label: t("common.undo"), onClick: () => undoDelete(id) },
    });
  }

  return (
    <SettingsCard
      as="section"
      aria-labelledby="settings-coach-conversations-title"
      data-testid="settings-coach-conversations-card"
    >
      <SettingsCardHeader
        anchor="coach-conversations"
        icon={MessagesSquare}
        titleId="settings-coach-conversations-title"
        title={t("settings.ai.coachConversations.title")}
        description={t("settings.ai.coachConversations.description")}
      />
      {history.isError ? (
        <QueryErrorRow onRetry={() => void history.refetch()} />
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {history.isLoading
            ? t("common.loading")
            : t("insights.coach.historyEmpty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((c) => (
            <li
              key={c.id}
              data-testid="settings-coach-conversation"
              className="border-border bg-background rounded-lg border"
            >
              <div className="flex items-center gap-2 p-1.5 pl-3">
                <button
                  type="button"
                  onClick={() =>
                    setOpenId((current) => (current === c.id ? null : c.id))
                  }
                  aria-expanded={openId === c.id}
                  data-slot="settings-coach-conversation-open"
                  className="flex min-h-11 min-w-0 flex-1 flex-col justify-center text-left"
                >
                  <span className="truncate text-sm font-medium">
                    {c.title}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {formatRelativeTime(c.updatedAt, t, locale)}
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  onClick={() => remove(c.id)}
                  aria-label={t("insights.coach.historyDeleteAria")}
                  data-slot="settings-coach-conversation-delete"
                  className="shrink-0"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
              {openId === c.id ? <ConversationTranscript id={c.id} /> : null}
            </li>
          ))}
        </ul>
      )}
      <SettingsCardActions align="start">
        {history.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {t("settings.ai.coachConversations.more")}
          </Button>
        ) : null}
        {visible.length > 0 ? (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
          >
            <Link
              href="/coach/conversations"
              data-slot="settings-coach-conversations-open-all"
            >
              {t("settings.ai.coachConversations.openAll")}
            </Link>
          </Button>
        ) : null}
      </SettingsCardActions>
    </SettingsCard>
  );
}
