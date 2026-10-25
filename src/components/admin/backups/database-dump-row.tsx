"use client";

/**
 * The nightly whole-database dump, as one row on the backups card.
 *
 * The account copies below it restore one account on this server; the dump is
 * the copy that rebuilds the server. So the row leads the card and says three
 * things: when the newest good dump was taken and where it is, whether the
 * newest run failed, and whether this server can keep a dump at all.
 */
import { AlertTriangle, HardDrive } from "lucide-react";

import { SettingsInfoTile } from "@/components/settings/_info-tile";
import { formatBytes } from "@/lib/format/bytes";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { DatabaseBackupHealth } from "@/lib/database-backup/health";

function whereKept(
  good: NonNullable<DatabaseBackupHealth["lastGood"]>,
  t: ReturnType<typeof useTranslations>["t"],
) {
  if (good.local && good.offhost) {
    return t("admin.section.backups.database.whereBoth");
  }
  if (good.offhost) return t("admin.section.backups.database.whereOffhost");
  return t("admin.section.backups.database.whereLocal");
}

export function DatabaseDumpRow({ health }: { health: DatabaseBackupHealth }) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const good = health.lastGood;
  const failure = health.lastFailure;
  const failedSinceGood =
    failure !== null && (good === null || failure.at > good.at);

  let setupProblem: string | null = null;
  if (!health.enabled) {
    setupProblem = t("admin.section.backups.database.disabled");
  } else if (!health.localDirWritable) {
    setupProblem = health.offhostConfigured
      ? t("admin.section.backups.database.noDirectoryOffhost", {
          dir: health.directory,
        })
      : t("admin.section.backups.database.noDirectory", {
          dir: health.directory,
        });
  }

  return (
    <div className="space-y-2" data-slot="database-dump">
      <div className="flex items-start gap-2">
        <HardDrive
          className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-medium">
            {t("admin.section.backups.database.title")}
          </p>
          <p
            className="text-muted-foreground text-xs"
            data-slot="database-dump-last-good"
          >
            {good
              ? t("admin.section.backups.database.lastGood", {
                  when: fmt.dateTime(good.at),
                  size: formatBytes(good.sizeBytes ?? 0, locale),
                  where: whereKept(good, t),
                })
              : t("admin.section.backups.database.none")}
          </p>
        </div>
      </div>

      {failedSinceGood && failure ? (
        <div
          role="alert"
          data-slot="database-dump-failed"
          className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-sm"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium">
                {t("admin.section.backups.database.failedTitle")}
              </p>
              <p className="text-xs">
                {t("admin.section.backups.database.failedDescription", {
                  when: fmt.dateTime(failure.at),
                  reason: failure.error,
                })}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {setupProblem ? (
        <SettingsInfoTile
          icon={AlertTriangle}
          tone="warning"
          role="alert"
          data-slot="database-dump-setup"
        >
          {setupProblem}
        </SettingsInfoTile>
      ) : null}
    </div>
  );
}
