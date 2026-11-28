"use client";

import { useState } from "react";
import { History, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListCapNotice } from "@/components/ui/list-cap-notice";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useAuth } from "@/hooks/use-auth";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { useManagedProfileActivity } from "@/lib/queries/use-managed-profiles";
import type { RecordActivityEntry } from "@/lib/queries/use-account-grants";
import { recordActivityVerbLine } from "@/lib/record-activity/activity-verb";
import { accountLabel } from "@/lib/sharing/account-access-view";

/**
 * #1403 — who did what in a managed profile, from the guardian's own account.
 *
 * Nobody signs in to a managed profile, so every line here is a guardian's,
 * the reader's own included ("you"). Collapsed until asked for: the read runs
 * only when the panel opens, and the window it can see is printed under it,
 * the number the server resolved from the retention setting.
 */
export function ManagedProfileActivityEntry({
  profileId,
  profileName,
}: {
  profileId: string;
  profileName: string;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <div
      data-slot="managed-profile-activity-entry"
      className="space-y-3 border-t pt-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">
            {t("recordSharing.managedActivity.title", { name: profileName })}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("recordSharing.managedActivity.hint")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 shrink-0 sm:min-h-9"
          data-slot="managed-profile-activity-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {t("recordSharing.managedActivity.action")}
        </Button>
      </div>
      {open && <ManagedProfileActivityList profileId={profileId} />}
    </div>
  );
}

function ManagedProfileActivityList({ profileId }: { profileId: string }) {
  const { t } = useTranslations();
  const { data, isLoading, isError, error, refetch } =
    useManagedProfileActivity(profileId);
  const entries = data?.entries ?? [];
  return (
    <div className="space-y-3">
      {data && (
        <p className="text-muted-foreground text-xs">
          {t("recordSharing.activity.retention", { days: data.retentionDays })}
        </p>
      )}
      <ListCapNotice cap={data?.cap} />
      {isLoading && (
        <Loader2
          className="text-muted-foreground size-5 animate-spin motion-reduce:animate-none"
          aria-label={t("common.loading")}
        />
      )}
      {isError && (
        <QueryErrorCard
          error={error}
          title={t("recordSharing.activity.loadError")}
          onRetry={() => void refetch()}
        />
      )}
      {!isLoading && !isError && entries.length === 0 && (
        <EmptyState
          icon={<History className="size-6" />}
          title={t("recordSharing.managedActivity.emptyTitle")}
        />
      )}
      {entries.length > 0 && (
        <ul data-slot="managed-profile-activity-list" className="divide-y">
          {entries.map((entry) => (
            <ActivityRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityRow({ entry }: { entry: RecordActivityEntry }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  const who = !entry.actor
    ? t("recordSharing.activity.deletedAccount")
    : entry.actor.id === user?.id
      ? t("recordSharing.managedActivity.you")
      : accountLabel(entry.actor);
  return (
    <li
      data-slot="managed-profile-activity-row"
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
    >
      <span className="text-foreground text-sm">
        {entry.accesses === null
          ? managedActivityLine(t, entry.action, who)
          : t("recordSharing.managedActivity.opened", {
              name: who,
              count: entry.accesses,
            })}
      </span>
      <span className="text-muted-foreground text-xs">
        {fmt.dateTime(new Date(entry.createdAt))}
      </span>
    </li>
  );
}

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** The feed's sentence for a managed profile: its own fallback and settings line. */
export function managedActivityLine(
  t: Translator,
  action: string,
  who: string,
): string {
  if (action.startsWith("record-settings.") && action.endsWith(".update")) {
    return t("recordSharing.managedActivity.settingsUpdate", { name: who });
  }
  const line = recordActivityVerbLine(t, action, who);
  // The owner's feed says "made a change in your record" for an action it
  // has no verb for; this is not the reader's record.
  return line === t("recordSharing.activity.acted", { name: who })
    ? t("recordSharing.managedActivity.acted", { name: who })
    : line;
}
