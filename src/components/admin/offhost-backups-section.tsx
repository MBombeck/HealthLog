"use client";

/**
 * `<OffhostBackupsSection>` — per-account freshness of the off-host copies.
 *
 * The card above it lists the copies that live in THIS database. This one
 * answers the different question: for each account, how long ago did this host
 * put an encrypted copy in the operator's bucket, and is that inside what the
 * nightly schedule promises. The two fail independently — a database whose
 * weekly rows are current tells an operator nothing about a bucket that has
 * been refusing the worker's signature since March.
 *
 * Every verdict is computed server-side from the ledger the worker writes. The
 * page never lists the bucket: the worker's grant is deliberately PutObject +
 * GetObject, and putting a credentialed listing call on the render path of an
 * admin page would be a poor trade for a number the database already holds.
 */

import { useQuery } from "@tanstack/react-query";
import { CloudUpload } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { cn } from "@/lib/utils";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { OffhostBackupFreshness } from "@/lib/jobs/offhost-backup-freshness";
import type { BackupsList, OffhostAccountRow } from "@/types/backups";
import { formatBytes } from "./backups-section";

/**
 * Status wash per verdict. `never` and `unknown` are deliberately neutral
 * rather than alarming: a host that turned the off-host job on this afternoon
 * has not failed at anything yet, and painting every row red on day one is how
 * an operator learns to stop reading the colour.
 */
const FRESHNESS_STYLE: Record<OffhostBackupFreshness, string> = {
  fresh: "border-success/30 bg-success/10 text-success",
  due: "border-warning/30 bg-warning/10 text-warning",
  stale: "border-destructive/30 bg-destructive/10 text-destructive",
  never: "border-border bg-muted text-muted-foreground",
  unknown: "border-border bg-muted text-muted-foreground",
};

function freshnessLabel(
  freshness: OffhostBackupFreshness,
  t: ReturnType<typeof useTranslations>["t"],
): string {
  // Literal keys, one per arm: a template-built key resolves at runtime and is
  // invisible to the call-site coverage guard.
  switch (freshness) {
    case "fresh":
      return t("admin.section.backups.offhost.stateFresh");
    case "due":
      return t("admin.section.backups.offhost.stateDue");
    case "stale":
      return t("admin.section.backups.offhost.stateStale");
    case "never":
      return t("admin.section.backups.offhost.stateNever");
    case "unknown":
      return t("admin.section.backups.offhost.stateUnknown");
  }
}

function AccountRow({ row }: { row: OffhostAccountRow }) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  return (
    <ListRow asChild className="bg-muted/30 border-border">
      <li
        data-slot="offhost-backup-row"
        data-offhost-username={row.username}
        data-offhost-freshness={row.freshness}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1 truncate font-medium">
            {row.username}
          </span>
          <Badge
            variant="outline"
            className={cn("shrink-0", FRESHNESS_STYLE[row.freshness])}
          >
            {freshnessLabel(row.freshness, t)}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">
          {row.lastAttemptAt === null
            ? // No run has recorded this account. Saying "never" here would
              // claim the bucket is empty when what is empty is the ledger,
              // which is exactly what every account looks like between the
              // upgrade that adds it and the first nightly run after that.
              t("admin.section.backups.offhost.unknownDetail")
            : row.lastSuccessAt === null || row.sizeBytes === null
              ? t("admin.section.backups.offhost.neverDetail", {
                  when: fmt.dateTime(row.lastAttemptAt),
                })
              : `${fmt.dateTime(row.lastSuccessAt)} · ${formatBytes(
                  row.sizeBytes,
                  fmt,
                )} · ${t("admin.section.backups.offhost.age", {
                  hours: row.ageHours ?? 0,
                })}`}
        </p>
      </li>
    </ListRow>
  );
}

export function OffhostBackupsSection() {
  const { t } = useTranslations();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.adminBackups(),
    queryFn: async () => apiGet<BackupsList>("/api/admin/backups"),
  });

  const offhost = data?.offhost;

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={CloudUpload}
        title={t("admin.section.backups.offhost.title")}
        description={t("admin.section.backups.offhost.description")}
        status={
          offhost && offhost.configured ? (
            <Badge variant="secondary" className="text-xs">
              {offhost.rows.length}
            </Badge>
          ) : null
        }
      />

      {isLoading ? (
        <div className="space-y-2" data-slot="offhost-backup-loading">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : isError ? (
        <QueryErrorRow
          message={t("admin.section.backups.offhost.loadError")}
          onRetry={() => void refetch()}
        />
      ) : offhost && !offhost.configured ? (
        <EmptyState
          icon={<CloudUpload className="size-6" />}
          title={t("admin.section.backups.offhost.notConfiguredTitle")}
          description={t(
            "admin.section.backups.offhost.notConfiguredDescription",
          )}
        />
      ) : offhost ? (
        <div className="space-y-2">
          <ul className="space-y-2" data-slot="offhost-backup-rows">
            {offhost.rows.map((row) => (
              <AccountRow key={row.userId} row={row} />
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            {t("admin.section.backups.offhost.scheduleNote", {
              hours: offhost.periodHours,
            })}
          </p>
        </div>
      ) : null}
    </SettingsCard>
  );
}
