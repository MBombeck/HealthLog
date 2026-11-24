"use client";

/**
 * Admin > System status: which build runs, from which image line, and where
 * the database stands against it. The version comes from `/api/version`, the
 * migrations from `/api/admin/migrations`. After an update the first question
 * is whether the new image is the one running and its migrations all applied;
 * both answers are here, in one card.
 */
import { useQuery } from "@tanstack/react-query";
import { DatabaseZap } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Badge } from "@/components/ui/badge";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { UPDATE_CHANNEL_TAG } from "@/lib/admin/update-channel";
import type { MigrationStatus } from "@/lib/admin/migration-status";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { usePublicVersion } from "./_shared";

export function VersionMigrationsCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const version = usePublicVersion();
  const migrations = useQuery({
    queryKey: queryKeys.adminMigrations(),
    queryFn: () => apiGet<MigrationStatus>("/api/admin/migrations"),
    staleTime: 60_000,
  });
  const k = "admin.versionMigrations";
  // Resolved by the server; the card only names it.
  const channel = version.data?.channel ?? null;
  const tag = channel ? UPDATE_CHANNEL_TAG[channel] : null;
  const m = migrations.data;

  return (
    <SettingsCard data-slot="version-migrations">
      <SettingsCardHeader
        icon={DatabaseZap}
        title={t(`${k}.title`)}
        description={t(`${k}.description`)}
      />
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div className="space-y-1">
          <dt className="text-muted-foreground text-xs">{t(`${k}.version`)}</dt>
          <dd className="flex flex-wrap items-center gap-2 font-medium">
            {version.data ? (
              <>
                <span className="tabular-nums">{version.data.version}</span>
                {channel ? (
                  <Badge variant="secondary" data-slot="update-channel">
                    {t(`${k}.channel.${channel}`)}
                    {tag ? ` (${tag})` : ""}
                  </Badge>
                ) : null}
              </>
            ) : (
              <Skeleton className="h-4 w-32" />
            )}
          </dd>
          {version.data?.builtAt ? (
            <dd className="text-muted-foreground text-xs">
              {t(`${k}.built`, {
                sha: version.data.buildSha ?? "",
                time: fmt.dateTime(version.data.builtAt),
              })}
            </dd>
          ) : null}
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground text-xs">
            {t(`${k}.migrations`)}
          </dt>
          {migrations.isError ? (
            <dd>
              <QueryErrorRow
                inset
                error={migrations.error}
                message={t(`${k}.loadError`)}
                onRetry={() => void migrations.refetch()}
              />
            </dd>
          ) : !m ? (
            <dd>
              <Skeleton className="h-4 w-40" />
            </dd>
          ) : (
            <>
              <dd className="font-medium" data-slot="migrations-summary">
                {m.shipped === null
                  ? t(`${k}.appliedOnly`, { applied: m.applied })
                  : t(`${k}.applied`, {
                      applied: m.applied,
                      shipped: m.shipped,
                    })}
              </dd>
              <dd
                className={
                  m.pending > 0 || m.failedNames.length > 0
                    ? "text-destructive text-xs"
                    : "text-muted-foreground text-xs"
                }
                data-slot="migrations-pending"
                data-pending={m.pending}
              >
                {m.failedNames.length > 0
                  ? t(`${k}.failed`, { names: m.failedNames.join(", ") })
                  : m.pending > 0
                    ? t(`${k}.pending`, {
                        count: m.pending,
                        names: m.pendingNames.join(", "),
                      })
                    : t(`${k}.upToDate`)}
              </dd>
              {m.lastApplied ? (
                <dd className="text-muted-foreground text-xs">
                  {t(`${k}.lastApplied`, {
                    name: m.lastApplied.name,
                    time: fmt.dateTime(m.lastApplied.at),
                  })}
                </dd>
              ) : null}
            </>
          )}
        </div>
      </dl>
    </SettingsCard>
  );
}
