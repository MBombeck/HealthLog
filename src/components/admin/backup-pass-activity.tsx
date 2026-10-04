"use client";

/**
 * What a backup pass is doing now, and which accounts a run died under.
 *
 * A pass whose process died (a restart, or a container out of memory) used
 * to leave nothing on this page: the job sat `active` until its expiry and
 * the last finished run still read fine. The run in progress and the
 * accounts whose last attempt started and never finished are both recorded
 * now (`backup-pass-attempts.ts`), so the page says so while it matters.
 */
import { AlertTriangle } from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { BackupPassActivity } from "@/lib/jobs/backup-pass-attempts";

export function BackupPassActivityNotice({
  activity,
}: {
  activity: BackupPassActivity;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  if (activity.runningSince === null && activity.interrupted.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2" data-slot="backup-pass-activity">
      {activity.runningSince !== null ? (
        <p
          role="status"
          className="text-muted-foreground text-xs"
          data-slot="backup-pass-running"
        >
          {t("admin.section.backups.activity.running", {
            when: fmt.dateTime(activity.runningSince),
          })}
        </p>
      ) : null}
      {activity.interrupted.length > 0 ? (
        <div
          role="alert"
          data-slot="backup-pass-interrupted"
          className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-sm"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium">
                {t("admin.section.backups.activity.interruptedTitle")}
              </p>
              <ul className="text-xs">
                {activity.interrupted.map((attempt) => (
                  <li
                    key={attempt.userId}
                    data-interrupted-username={attempt.username}
                  >
                    {t("admin.section.backups.activity.interruptedAccount", {
                      username: attempt.username,
                      when: fmt.dateTime(attempt.startedAt),
                    })}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground mt-2 text-xs">
                {t("admin.section.backups.activity.interruptedRemedy")}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
