"use client";

/**
 * `<RestoreJobStatus>` — one restore job as the backups console shows it.
 *
 * A restore runs on the server as a background job (see
 * `src/lib/jobs/backup-restore.ts`). The console polls
 * `GET /api/admin/backups/restores` while a job is queued or running and
 * renders each one here: what it is doing and how far it has got, then how it
 * ended. Because the list comes from the server, a reload during a restore
 * picks it up again where the page left it.
 *
 * Three rules, each for a way the synchronous restore misled an operator:
 *
 *   - A running restore says the account still shows its current data. It
 *     does: nothing the restore writes is visible until it commits.
 *   - A failed restore says whether anything changed, and every failure but
 *     one changed nothing. It also says the backup is kept, because the next
 *     question is "do I have to upload it again", and the answer is no.
 *   - Only the job's own row decides the outcome. A poll that fails on the
 *     network is not a failed restore and is never shown as one.
 */
import { AlertTriangle, Loader2 } from "lucide-react";

import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type {
  BackupRestoreFailureCode,
  BackupRestoreJobView,
} from "@/lib/jobs/backup-restore";

/** Whether a job still holds its account's one restore slot. */
export function isActiveRestore(job: BackupRestoreJobView): boolean {
  return job.status === "queued" || job.status === "running";
}

/**
 * The jobs worth a panel: every active one, and the newest finished one the
 * operator has not dismissed.
 */
export function visibleRestoreJobs(
  jobs: readonly BackupRestoreJobView[],
  dismissed: ReadonlySet<string>,
): BackupRestoreJobView[] {
  const active = jobs.filter(isActiveRestore);
  const finished = jobs.find(
    (job) => !isActiveRestore(job) && !dismissed.has(job.id),
  );
  return finished ? [...active, finished] : active;
}

/** Total records a succeeded restore wrote, from its summary counts. */
function restoredCount(job: BackupRestoreJobView): number {
  let total = 0;
  for (const value of Object.values(job.result?.summary ?? {})) {
    if (typeof value === "number") total += value;
  }
  return total;
}

/**
 * The failure as a sentence in the operator's language.
 *
 * Literal `t()` calls, so `i18n-call-site-coverage.test.ts` sees every key.
 * The `never` at the foot makes the compiler say the chain is exhaustive: a
 * failure code added on the server without a sentence here stops the build.
 */
function failureText(
  code: BackupRestoreFailureCode,
  t: ReturnType<typeof useTranslations>["t"],
): string {
  switch (code) {
    case "backup_not_found":
      return t("admin.section.backups.restoreFailureNotFound");
    case "backup_changed":
      return t("admin.section.backups.restoreFailureChanged");
    case "backup.payload.undecryptable":
      return t("admin.section.backups.restoreFailureUndecryptable");
    case "schema_invalid":
      return t("admin.section.backups.restoreFailureSchema");
    case "incompatible_schema_version":
      return t("admin.section.backups.restoreFailureVersion");
    case "owner_mismatch":
      return t("admin.section.backups.restoreFailureOwnerMismatch");
    case "owner_not_found":
      return t("admin.section.backups.restoreFailureOwnerMissing");
    case "backup.section.missing":
      return t("admin.section.backups.restoreFailureSectionMissing");
    case "document_ciphertext_missing":
      return t("admin.section.backups.restoreFailureDocument");
    case "time_budget":
      return t("admin.section.backups.restoreFailureTimeBudget");
    case "transaction_failed":
      return t("admin.section.backups.restoreFailureTransaction");
    case "interrupted":
      return t("admin.section.backups.restoreFailureInterrupted");
    case "not_started":
      return t("admin.section.backups.restoreFailureNotStarted");
    case "enqueue_failed":
      return t("admin.section.backups.restoreFailureEnqueue");
    case "failed_after_commit":
      return t("admin.section.backups.restoreFailureAfterCommit");
    case "unexpected":
      return t("admin.section.backups.restoreFailureUnexpected");
    default: {
      const unhandled: never = code;
      return unhandled;
    }
  }
}

/** What a running job is doing, and the share of it done when that is known. */
function runningLine(
  job: BackupRestoreJobView,
  t: ReturnType<typeof useTranslations>["t"],
  fmt: ReturnType<typeof useFormatters>,
): { text: string; percent: number | null } {
  const progress = job.progress;
  switch (job.phase) {
    case "clearing":
      return {
        text: t("admin.section.backups.restoreJobPhaseClearing"),
        percent: null,
      };
    case "measurements": {
      const total = progress?.measurementsTotal ?? 0;
      const done = progress?.measurementsWritten ?? 0;
      return {
        text: t("admin.section.backups.restoreJobPhaseMeasurements", {
          done: fmt.integer(done),
          total: fmt.integer(total),
        }),
        percent: total > 0 ? Math.min(100, (done / total) * 100) : null,
      };
    }
    case "sections": {
      const total = progress?.sectionsTotal ?? 0;
      const done = progress?.sectionsDone ?? 0;
      return {
        text: t("admin.section.backups.restoreJobPhaseSections", {
          done: fmt.integer(done),
          total: fmt.integer(total),
        }),
        percent: total > 0 ? Math.min(100, (done / total) * 100) : null,
      };
    }
    case "rebuilding":
      return {
        text: t("admin.section.backups.restoreJobPhaseRebuilding"),
        percent: null,
      };
    case "validating":
    default:
      return {
        text: t("admin.section.backups.restoreJobPhaseValidating", {
          checked: fmt.integer(progress?.measurementsChecked ?? 0),
        }),
        percent: null,
      };
  }
}

export function RestoreJobStatus({
  job,
  onDismiss,
}: {
  job: BackupRestoreJobView;
  onDismiss: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const username = job.username ?? job.userId;

  if (isActiveRestore(job)) {
    const line =
      job.status === "running"
        ? runningLine(job, t, fmt)
        : {
            text: t("admin.section.backups.restoreJobQueuedNote"),
            percent: null,
          };
    return (
      <div
        role="status"
        aria-live="polite"
        data-slot="restore-job-status"
        data-status={job.status}
        className="border-border bg-muted/30 space-y-2 rounded-md border px-3 py-2 text-sm"
      >
        <div className="flex items-start gap-2">
          <Loader2
            className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium">
              {job.status === "queued"
                ? t("admin.section.backups.restoreJobQueuedTitle", {
                    username,
                  })
                : t("admin.section.backups.restoreJobRunningTitle", {
                    username,
                  })}
            </p>
            <p>{line.text}</p>
            {line.percent !== null ? (
              <Progress
                value={line.percent}
                aria-label={line.text}
                data-slot="restore-job-progress"
              />
            ) : null}
            {job.attempts > 1 ? (
              <p className="text-muted-foreground text-xs">
                {t("admin.section.backups.restoreJobResumed")}
              </p>
            ) : null}
            <p className="text-muted-foreground text-xs">
              {t("admin.section.backups.restoreJobRunningNote")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (job.status === "succeeded") {
    const count = restoredCount(job);
    return (
      <div
        data-slot="restore-job-status"
        data-status={job.status}
        className="border-success/40 bg-success/10 rounded-md border px-3 py-2 text-sm"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1">
            <p className="font-medium">
              {t("admin.section.backups.restoreJobSucceededTitle", {
                username,
              })}
            </p>
            {/* An empty file restores to an empty account: honest, and not a
                tick. The outcome module decides which it looks like. */}
            <WrittenOutcomeLine
              outcome={count > 0 ? "success" : "empty"}
              testId="restore-job-outcome"
              message={t(
                "admin.section.backups.restoreJobSucceededDescription",
                {
                  count: fmt.integer(count),
                  when: job.completedAt ? fmt.dateTime(job.completedAt) : "",
                },
              )}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDismiss}
            className="min-h-11"
          >
            {t("common.dismiss")}
          </Button>
        </div>
      </div>
    );
  }

  const code = job.failure?.code ?? "unexpected";
  const changedNothing = code !== "failed_after_commit";
  return (
    <div
      role="alert"
      data-slot="restore-job-status"
      data-status={job.status}
      data-failure-code={code}
      className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium">
              {t("admin.section.backups.restoreJobFailedTitle", { username })}
            </p>
            <p className="text-xs">{failureText(code, t)}</p>
            {changedNothing ? (
              <p className="text-muted-foreground mt-1 text-xs">
                {t("admin.section.backups.restoreJobFailedKept")}
              </p>
            ) : null}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          className="min-h-11"
        >
          {t("common.dismiss")}
        </Button>
      </div>
    </div>
  );
}
