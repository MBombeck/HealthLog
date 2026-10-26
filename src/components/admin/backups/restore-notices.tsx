import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { BackupScheduleStatus } from "@/lib/jobs/backup-schedule-status";
import type {
  MissingBackupSection,
  RestoreSkipSummary,
  SkippedCatalogue,
} from "@/lib/export/restore-skips";

/**
 * Which catalogue a skipped key belonged to, as a label.
 *
 * Spelled out with literal `t()` calls rather than an interpolated key, so
 * `i18n-call-site-coverage.test.ts` can see each one and prove the bundle has
 * it. An interpolated key is invisible to that guard and shows up as raw dot
 * notation in production the day someone renames a catalogue.
 */
function catalogueLabel(
  catalogue: SkippedCatalogue,
  t: ReturnType<typeof useTranslations>["t"],
) {
  if (catalogue === "cycleSymptom") {
    return t("admin.section.backups.restoreSkippedCycleSymptom");
  }
  if (catalogue === "illnessSymptom") {
    return t("admin.section.backups.restoreSkippedIllnessSymptom");
  }
  if (catalogue === "moodTag") {
    return t("admin.section.backups.restoreSkippedMoodTag");
  }
  if (catalogue === "visitReference") {
    return t("admin.section.backups.restoreSkippedVisitReference");
  }
  if (catalogue === "vaccinationReference") {
    return t("admin.section.backups.restoreSkippedVaccinationReference");
  }
  if (catalogue === "checkupClosure") {
    return t("admin.section.backups.restoreSkippedCheckupClosure");
  }
  if (catalogue === "reminderReference") {
    return t("admin.section.backups.restoreSkippedReminderReference");
  }
  if (catalogue === "coachAttachment") {
    return t("admin.section.backups.restoreSkippedCoachAttachment");
  }
  if (catalogue === "coachReference") {
    return t("admin.section.backups.restoreSkippedCoachReference");
  }
  if (catalogue === "documentConditionLink") {
    return t("admin.section.backups.restoreSkippedDocumentConditionLink");
  }
  if (catalogue === "relationLink") {
    return t("admin.section.backups.restoreSkippedRelationLink");
  }
  if (catalogue === "extractedFact") {
    return t("admin.section.backups.restoreSkippedExtractedFact");
  }
  if (catalogue === "factCommitment") {
    return t("admin.section.backups.restoreSkippedFactCommitment");
  }
  if (catalogue === "moodFactor") {
    return t("admin.section.backups.restoreSkippedMoodFactor");
  }
  if (catalogue === "personalRecordReference") {
    return t("admin.section.backups.restoreSkippedPersonalRecordReference");
  }
  if (catalogue === "ecgReference") {
    return t("admin.section.backups.restoreSkippedEcgReference");
  }
  if (catalogue === "symptomEpisodeReference") {
    return t("admin.section.backups.restoreSkippedSymptomEpisodeReference");
  }
  if (catalogue === "visitCiphertext") {
    return t("admin.section.backups.restoreSkippedVisitCiphertext");
  }
  if (catalogue === "vaccinationCiphertext") {
    return t("admin.section.backups.restoreSkippedVaccinationCiphertext");
  }
  if (catalogue === "environmentLocationCiphertext") {
    return t(
      "admin.section.backups.restoreSkippedEnvironmentLocationCiphertext",
    );
  }
  if (catalogue === "moodLabelCiphertext") {
    return t("admin.section.backups.restoreSkippedMoodLabelCiphertext");
  }
  if (catalogue === "cycleCiphertext") {
    return t("admin.section.backups.restoreSkippedCycleCiphertext");
  }
  if (catalogue === "medicationTarget") {
    return t("admin.section.backups.restoreSkippedMedicationTarget");
  }
  if (catalogue === "scheduleRevisionLink") {
    return t("admin.section.backups.restoreSkippedScheduleRevisionLink");
  }
  if (catalogue === "accountSetting") {
    return t("admin.section.backups.restoreSkippedAccountSetting");
  }
  // Not a fallback: the chain above is exhaustive and this line is what makes
  // the compiler say so. A catalogue added without a label here now stops the
  // build instead of shipping under a label that belongs to something else,
  // which is what three of them were already doing — a dropped Coach
  // attachment reached the operator's screen labelled "mood factor".
  const unlabelled: never = catalogue;
  return unlabelled;
}

/**
 * Which section a refused file claimed and did not carry, as a label.
 *
 * Spelled out with literal `t()` calls for the same reason as
 * `catalogueLabel` above — an interpolated key is invisible to
 * `i18n-call-site-coverage.test.ts`, and a renamed section would ship as raw
 * dot notation. The `never` at the foot is what makes the compiler say the
 * chain is exhaustive.
 */
function missingSectionLabel(
  section: MissingBackupSection,
  t: ReturnType<typeof useTranslations>["t"],
) {
  if (section === "documents") {
    return t("admin.section.backups.restoreMissingDocuments");
  }
  if (section === "workouts") {
    return t("admin.section.backups.restoreMissingWorkouts");
  }
  if (section === "mentalHealth") {
    return t("admin.section.backups.restoreMissingMentalHealth");
  }
  if (section === "consent") {
    return t("admin.section.backups.restoreMissingConsent");
  }
  const unlabelled: never = section;
  return unlabelled;
}

/**
 * The refused sections a failed restore job names, or none.
 *
 * Keyed on the failure's `code` and not on its message: the message is prose
 * the server may reword, and matching on it would turn a copy edit into a
 * silent loss of the panel.
 */
export function missingSectionsOf(
  failure: { code: string; sections?: readonly unknown[] } | null | undefined,
): MissingBackupSection[] {
  if (failure?.code !== "backup.section.missing") return [];
  const sections = failure.sections;
  if (!Array.isArray(sections)) return [];
  return sections.filter(
    (section): section is MissingBackupSection => typeof section === "string",
  );
}

/**
 * Why a file was refused, and what to do about it.
 *
 * Held on screen rather than left to the toast, exactly like the skip report
 * below it. The operator refused here is often holding the only copy of an
 * account; "restore failed" for four seconds is not enough to act on, and the
 * two facts that let them act — which section the file claimed and did not
 * carry, and that nothing was changed — have to survive long enough to be read.
 */
export function RestoreRefusalNotice({
  sections,
  onDismiss,
}: {
  sections: MissingBackupSection[];
  onDismiss: () => void;
}) {
  const { t } = useTranslations();
  if (sections.length === 0) return null;
  return (
    <div
      role="alert"
      data-slot="restore-refusal-notice"
      className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium">
              {t("admin.section.backups.restoreMissingTitle")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("admin.section.backups.restoreMissingDescription")}
            </p>
            <ul className="mt-2 space-y-1">
              {sections.map((section) => (
                <li key={section} className="text-xs">
                  {missingSectionLabel(section, t)}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-2 text-xs">
              {t("admin.section.backups.restoreMissingRemedy")}
            </p>
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

/**
 * What the last restore could not put back.
 *
 * Its own component, and exported, so it can be rendered against a report in a
 * test instead of only through a state transition the SSR smoke tests here
 * cannot drive. A report that reaches the response and never reaches the screen
 * is the same silence the reporting exists to end, so the render is worth
 * proving on its own.
 *
 * It names every key rather than totalling them away: an operator who cannot
 * see WHICH symptom went missing cannot decide whether it mattered.
 */
export function RestoreSkipReport({
  report,
  onDismiss,
}: {
  report: RestoreSkipSummary;
  onDismiss: () => void;
}) {
  const { t } = useTranslations();
  if (report.links === 0) return null;
  return (
    <div
      role="status"
      data-slot="restore-skip-report"
      className="border-warning/40 bg-warning/10 rounded-md border px-3 py-2 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium">
              {t("admin.section.backups.restoreSkippedTitle", {
                links: String(report.links),
              })}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("admin.section.backups.restoreSkippedDescription")}
            </p>
            <ul className="mt-2 space-y-1">
              {report.catalogueKeys.map((entry) => (
                <li key={`${entry.catalogue}:${entry.key}`} className="text-xs">
                  <span className="font-mono">{entry.key}</span>{" "}
                  <span className="text-muted-foreground">
                    {catalogueLabel(entry.catalogue, t)}
                    {" · "}
                    {t("admin.section.backups.restoreSkippedLinks", {
                      count: String(entry.links),
                    })}
                  </span>
                </li>
              ))}
            </ul>
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

/**
 * Says out loud whether the SCHEDULE is still alive.
 *
 * The weekly pass on the maintainer's own instance stopped producing copies
 * and nothing surfaced it for a month and a half: the table listed the rows it
 * had, each with an ordinary timestamp, and a copy from six weeks ago reads
 * exactly like one made on Sunday until somebody does the subtraction. Two
 * independent facts are shown, because they fail at different times — the age
 * of the newest scheduled copy never ages out, while the run's own outcome
 * carries the reason ("job timed out") and survives only as long as pg-boss
 * keeps the row.
 *
 * Not dismissible: it reflects live state, so the only way to clear it is to
 * make a backup succeed.
 */
export function ScheduleHealthNotice({
  schedule,
}: {
  schedule: BackupScheduleStatus;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  if (!schedule.stale && !schedule.lastRunFailed) return null;

  return (
    <div
      role="alert"
      data-slot="backup-schedule-notice"
      className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">
            {schedule.stale
              ? t("admin.section.backups.scheduleStaleTitle")
              : t("admin.section.backups.scheduleFailedTitle")}
          </p>
          {schedule.stale ? (
            <p className="text-xs">
              {t("admin.section.backups.scheduleStaleDescription", {
                days: schedule.lastSuccessAgeDays ?? 0,
                threshold: schedule.staleAfterDays,
              })}
            </p>
          ) : null}
          {schedule.lastRunFailed && schedule.lastRun ? (
            <p className="text-xs">
              {t("admin.section.backups.scheduleFailedDescription", {
                when: fmt.dateTime(schedule.lastRun.at),
                reason:
                  schedule.lastRun.error ||
                  t("admin.section.backups.scheduleFailedNoReason"),
              })}
            </p>
          ) : null}
          <p className="text-muted-foreground mt-2 text-xs">
            {t("admin.section.backups.scheduleRemedy")}
          </p>
        </div>
      </div>
    </div>
  );
}
