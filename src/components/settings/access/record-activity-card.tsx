"use client";

import { History, Loader2 } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { recordActivityVerbLine } from "@/lib/record-activity/activity-verb";
import { accountLabel } from "@/lib/sharing/account-access-view";
import {
  useRecordActivity,
  type RecordActivityEntry,
} from "@/lib/queries/use-account-grants";
import { ListCapNotice } from "@/components/ui/list-cap-notice";

/**
 * v1.36.0 — when this record was opened, and by whom.
 *
 * ## The card says how far back it can see
 *
 * Access rows are purged on a retention schedule (365 days by default, and the
 * operator can shorten it). A view titled "activity" with no window stated
 * would imply a completeness it does not have — somebody checking whether
 * their record was opened last spring would read an empty list as "no" when
 * the honest answer is "that is further back than this can see". So the bound
 * is printed under the heading, and it is the number the SERVER resolved from
 * the same setting the purge job reads, never a constant compiled in here. An
 * instance running a 90-day window says 90.
 *
 * ## What a row is
 *
 * One row per delegate per day, with a count — not one row per request. A
 * hundred identical lines saying "she read your record" is a way of answering
 * nothing; "she was in your record on Tuesday, 40 times" is the answer somebody
 * actually wants. Rows the owner performed themselves never appear here: this
 * is the record of what SOMEBODY ELSE did, and the account's own security
 * activity has its own surface.
 */
export function RecordActivityCard() {
  const { t } = useTranslations();
  const { data, isLoading, isError, error, refetch } = useRecordActivity();

  const entries = data?.entries ?? [];

  return (
    <SettingsCard data-slot="record-activity-card">
      <SettingsCardHeader
        anchor="record-activity"
        icon={History}
        title={t("recordSharing.activity.title")}
        description={t("recordSharing.activity.description")}
      />
      <div className="space-y-3">
        {/* The window, stated. Rendered only once the server has said what it
            is — a placeholder number here would be exactly the invented value
            the sentence exists to avoid. */}
        {data && (
          <p
            data-slot="record-activity-retention"
            className="text-muted-foreground text-xs"
          >
            {t("recordSharing.activity.retention", {
              days: data.retentionDays,
            })}
          </p>
        )}
        {/* The second completeness claim: the window says how far back this
            can see, the cap how many rows came back. Rendered only when the
            ceiling was actually hit. */}
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
            title={t("recordSharing.activity.emptyTitle")}
          />
        )}
        {entries.length > 0 && (
          <ul data-slot="record-activity-list" className="divide-y">
            {entries.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </SettingsCard>
  );
}

function ActivityRow({ entry }: { entry: RecordActivityEntry }) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  // A deleted account renders as one. The audit column is deliberately not a
  // foreign key, so the id outlives the person; showing nothing would read as
  // though the owner had done it themselves.
  const who = entry.actor
    ? accountLabel(entry.actor)
    : t("recordSharing.activity.deletedAccount");

  return (
    <li
      data-slot="record-activity-row"
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
    >
      <span className="text-foreground text-sm">
        {entry.accesses === null
          ? recordActivityVerbLine(t, entry.action, who)
          : t("recordSharing.activity.opened", {
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
