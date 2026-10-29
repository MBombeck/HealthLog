"use client";

/**
 * `<BackupsSection>` — admin view of the weekly `DataBackup` snapshots.
 *
 * Lists every snapshot row (one per user × backup-type) with size and age,
 * plus a "Run backup now" CTA that enqueues the pg-boss `data-backup` job.
 * The encrypted payload itself is never shipped to the browser; only the
 * size in bytes is surfaced.
 */

import { useQuery } from "@tanstack/react-query";
import { BookOpen, Database, Loader2, PlayCircle } from "lucide-react";

import { BackupPassActivityNotice } from "@/components/admin/backup-pass-activity";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useRecentProof } from "@/components/settings/security-section/use-recent-proof";
import { SettingsCard } from "@/components/settings/settings-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { BackupRow, BackupsList } from "@/types/backups";

import { RestoreJobStatus, visibleRestoreJobs } from "./backup-restore-status";
import { BackupRowsCards, BackupRowsTable } from "./backups/backup-rows";
import { DatabaseDumpRow } from "./backups/database-dump-row";
import { BackupUpload } from "./backups/backup-upload-card";
import {
  RestoreRefusalNotice,
  RestoreSkipReport,
  ScheduleHealthNotice,
} from "./backups/restore-notices";
import { useBackupDownload, useRunBackup } from "./backups/use-backup-actions";
import { useBackupRestores } from "./backups/use-backup-restores";

export function BackupsSection() {
  const { t } = useTranslations();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.adminBackups(),
    queryFn: async () => {
      return apiGet<BackupsList>("/api/admin/backups");
    },
  });
  const runBackup = useRunBackup();
  const rows: BackupRow[] = data?.rows ?? [];

  // Download, upload and restore reach every account's data, so each asks for
  // a fresh proof unless this session signed in or re-proved within minutes.
  const recentProof = useRecentProof();
  const { downloadingId, handleDownload } = useBackupDownload(recentProof);
  const {
    restoreJobs,
    dismissedRestores,
    dismissRestore,
    restore,
    restorePending,
    skipped,
    setSkipped,
    refusedSections,
    setRefusedSections,
  } = useBackupRestores(recentProof);
  const rowActions = {
    downloadingId,
    onDownload: (row: BackupRow) => void handleDownload(row),
    restorePending,
    onRestore: (
      row: BackupRow,
      options: { restoreInstanceSettings: boolean },
    ) => restore.mutate({ row, ...options }),
  };

  return (
    <SettingsCard>
      {recentProof.dialog}
      {/* The snapshot count leads (numbers first) and the
          "Run now" button follows. */}
      <SettingsCardHeader
        icon={Database}
        title={t("admin.section.backups.title")}
        titleAccessory={
          data ? (
            <Badge variant="secondary" className="text-xs">
              {rows.length}
            </Badge>
          ) : null
        }
        description={
          <p>
            {t("admin.section.backups.description")}{" "}
            {/* External docs link — `noopener noreferrer` because this
                leaves the admin shell. */}
            <a
              href="https://docs.healthlog.dev/guides/backups/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              <BookOpen className="h-3 w-3" aria-hidden="true" />
              {t("admin.section.backups.docsLink")}
            </a>
          </p>
        }
      />

      {data?.database ? (
        <DatabaseDumpRow
          health={data.database}
          bucketLifecycle={
            data.offhost.configured ? data.offhost.lifecycle.database : null
          }
        />
      ) : null}
      {data?.schedule ? (
        <ScheduleHealthNotice schedule={data.schedule} />
      ) : null}
      {data?.scheduleActivity ? (
        <BackupPassActivityNotice activity={data.scheduleActivity} />
      ) : null}

      <BackupUpload recentProof={recentProof} />

      {visibleRestoreJobs(restoreJobs, dismissedRestores).map((job) => (
        <RestoreJobStatus
          key={job.id}
          job={job}
          onDismiss={() => dismissRestore(job.id)}
        />
      ))}

      <RestoreRefusalNotice
        sections={refusedSections}
        onDismiss={() => setRefusedSections([])}
      />

      {skipped ? (
        <RestoreSkipReport
          report={skipped}
          onDismiss={() => setSkipped(null)}
        />
      ) : null}

      {isLoading ? (
        <div className="flex items-center gap-2">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
          <span className="text-muted-foreground text-sm">
            {t("admin.section.backups.loading")}
          </span>
        </div>
      ) : isError ? (
        <QueryErrorRow
          inset
          error={error}
          message={t("admin.section.backups.loadError")}
          onRetry={() => void refetch()}
        />
      ) : rows.length === 0 ? (
        // Replace bare text with the EmptyState
        // primitive. The header already exposes "Backup now" but a
        // brand-new admin lands inside the card and benefits from a
        // duplicate CTA right next to the explanation.
        //
        // Its own test id, because both buttons are in the tree while the list
        // is empty and they do the same thing: one id on two elements forces
        // every caller to pick one blind, and a third button would join the
        // pick without anything failing.
        <div>
          <EmptyState
            icon={<Database className="size-6" />}
            title={t("admin.section.backups.emptyTitle")}
            description={t("admin.section.backups.emptyDescription")}
            action={
              <Button
                size="sm"
                data-testid="backup-run-now-empty"
                disabled={runBackup.isPending}
                onClick={() => runBackup.mutate()}
                className="min-h-11"
              >
                {runBackup.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <PlayCircle className="h-3.5 w-3.5" />
                )}
                {t("admin.section.backups.runNow")}
              </Button>
            }
          />
        </div>
      ) : (
        <div>
          <BackupRowsTable rows={rows} {...rowActions} />

          <BackupRowsCards rows={rows} {...rowActions} />

          <p className="text-muted-foreground mt-2 text-xs">
            {data!.preWipeCopyDays > 0
              ? t("admin.section.backups.retentionNote", {
                  days: data!.preWipeCopyDays,
                })
              : t("admin.section.backups.retentionNoteNoGrace")}
          </p>
        </div>
      )}

      <SettingsCardActions>
        <Button
          size="sm"
          data-testid="backup-run-now"
          disabled={runBackup.isPending}
          onClick={() => runBackup.mutate()}
          className="min-h-11"
        >
          {runBackup.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <PlayCircle className="h-3.5 w-3.5" />
          )}
          {t("admin.section.backups.runNow")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}
