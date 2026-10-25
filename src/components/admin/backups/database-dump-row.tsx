"use client";

/**
 * The nightly whole-database dump, as one row on the backups card.
 *
 * The account copies below it restore one account on this server; the dump is
 * the copy that rebuilds the server. So the row leads the card and says three
 * things: when the newest good dump was taken and where it is, whether the
 * newest run failed, and whether this server can keep a dump at all. A
 * directory inside the container (the image's own, without the volume) is
 * writable and still keeps nothing past the next update, so "kept on this
 * server" is only said of a directory that survives it.
 */
import { AlertTriangle, HardDrive } from "lucide-react";

import { SettingsInfoTile } from "@/components/settings/_info-tile";
import { formatBytes } from "@/lib/format/bytes";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { DatabaseBackupHealth } from "@/lib/database-backup/health";
import type { LifecycleVerdict } from "@/lib/jobs/offhost-lifecycle";

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

export function DatabaseDumpRow({
  health,
  bucketLifecycle,
}: {
  health: DatabaseBackupHealth;
  /** The bucket's rule for `database/`; null when nothing goes off-host. */
  bucketLifecycle: LifecycleVerdict | null;
}) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const good = health.lastGood;
  const failure = health.lastFailure;
  const failedSinceGood =
    failure !== null && (good === null || failure.at > good.at);

  let setupProblem: string | null = null;
  if (!health.enabled) {
    setupProblem = t("admin.section.backups.database.disabled");
  } else if (health.localDirWritable && !health.localPersistent) {
    setupProblem = health.offhostConfigured
      ? t("admin.section.backups.database.notPersistentOffhost", {
          dir: health.directory,
        })
      : t("admin.section.backups.database.notPersistent", {
          dir: health.directory,
        });
  } else if (!health.localPersistent) {
    setupProblem = health.offhostConfigured
      ? t("admin.section.backups.database.noDirectoryOffhost", {
          dir: health.directory,
        })
      : t("admin.section.backups.database.noDirectory", {
          dir: health.directory,
        });
  }

  const retention = [
    health.localPersistent
      ? t("admin.section.backups.database.retentionLocal", {
          nights: health.keepNightly,
        })
      : null,
    bucketLifecycle?.state === "configured"
      ? t("admin.section.backups.database.retentionOffhost", {
          days: bucketLifecycle.expirationDays ?? 0,
        })
      : null,
  ].filter((line): line is string => line !== null);

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
          {/* How long a deleted account stays in the dumps: the operator's
              side of the deletion promise (GDPR retention of backups). */}
          {retention.length > 0 ? (
            <p
              className="text-muted-foreground text-xs"
              data-slot="database-dump-retention"
            >
              {retention.join(" ")}
            </p>
          ) : null}
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

      {bucketLifecycle?.state === "missing" ? (
        <SettingsInfoTile
          icon={AlertTriangle}
          tone="warning"
          role="alert"
          data-slot="database-dump-no-lifecycle"
        >
          {t("admin.section.backups.database.retentionOffhostMissing")}
        </SettingsInfoTile>
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
