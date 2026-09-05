"use client";

/**
 * `<BackupsSection>` — admin view of the weekly `DataBackup` snapshots.
 *
 * Lists every snapshot row (one per user × backup-type) with size and age,
 * plus a "Run backup now" CTA that enqueues the pg-boss `data-backup` job.
 * The encrypted payload itself is never shipped to the browser; only the
 * size in bytes is surfaced.
 *
 * Folds in v1.4.6 deferred T2.6.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  Database,
  Download,
  History,
  Loader2,
  PlayCircle,
  Upload,
} from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ListRow } from "@/components/ui/list-row";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { randomId } from "@/lib/random-id";
import type { BackupRow, BackupsList } from "@/types/backups";
import type { BackupScheduleStatus } from "@/lib/jobs/backup-schedule-status";
import type {
  MissingBackupSection,
  RestoreSkipSummary,
  SkippedCatalogue,
} from "@/lib/export/restore-skips";
import { getApiErrorMessage } from "./_shared";
import {
  ApiError,
  apiFetch,
  apiFetchRaw,
  apiGet,
  apiPost,
} from "@/lib/api/api-fetch";

/**
 * Typed-confirmation dialog for restore. The destructive Restore button
 * is gated behind:
 *   1. Opening the dialog (one click).
 *   2. Reading the warning copy (Title + Description spell out exactly
 *      what's about to happen + which user it affects).
 *   3. Typing the literal string `RESTORE` into the prompt input —
 *      anything else keeps the confirm button disabled.
 *
 * Three independent steps before the request fires == "triple confirm".
 * Mirrors the wipe dialog's pattern but adds the typed gate because the
 * blast radius is bigger (re-creates rows, not just deletes).
 */
/**
 * v1.37.20 — the sections a restore preview names, in render order. Each
 * entry sums one or more `BackupSummary` counters under one human label;
 * every counter NOT named here still reaches the operator through the
 * trailing "other records" line, so a future summary key can be forgotten
 * here without silently vanishing from the preview.
 */
const RESTORE_PREVIEW_SECTIONS: ReadonlyArray<{
  labelKey: string;
  keys: readonly string[];
}> = [
  { labelKey: "previewMeasurements", keys: ["measurements"] },
  {
    labelKey: "previewMedications",
    keys: ["medications", "intakeEvents", "medicationSideEffects"],
  },
  { labelKey: "previewMood", keys: ["moodEntries"] },
  { labelKey: "previewLabs", keys: ["labResults", "biomarkers"] },
  { labelKey: "previewDocuments", keys: ["documents"] },
  { labelKey: "previewWorkouts", keys: ["workouts"] },
  { labelKey: "previewCycles", keys: ["cycles", "cycleDayLogs"] },
  {
    labelKey: "previewVisits",
    keys: ["encounters", "practitioners", "encounterLinks"],
  },
  {
    labelKey: "previewVaccinations",
    keys: ["vaccinations", "vaccinationLinks"],
  },
  {
    labelKey: "previewReminders",
    keys: ["measurementReminders", "measurementReminderEvents"],
  },
  {
    labelKey: "previewCustomMetrics",
    keys: ["customMetrics", "customMetricEntries"],
  },
  { labelKey: "previewHealthScores", keys: ["healthScoreRecords"] },
];

function RestoreRowDialog({
  row,
  pending,
  onConfirm,
}: {
  row: BackupRow;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const matched = typed.trim() === "RESTORE";

  // v1.37.20 — restore preview: fetch what the file contains the moment the
  // dialog opens, so the typed confirmation is an informed one. Derived from
  // the same decrypt + schema path the restore itself runs. A failed preview
  // never blocks the restore — it states its own absence instead.
  const preview = useQuery({
    queryKey: queryKeys.adminBackupSummary(row.id),
    queryFn: () =>
      apiGet<{ summary: Record<string, unknown> }>(
        `/api/admin/backups/${row.id}/summary`,
      ),
    enabled: open,
    staleTime: 60_000,
  });
  const numericSummary: Record<string, number> = {};
  if (preview.data?.summary) {
    for (const [key, value] of Object.entries(preview.data.summary)) {
      if (typeof value === "number") numericSummary[key] = value;
    }
  }
  const namedKeys = new Set(
    RESTORE_PREVIEW_SECTIONS.flatMap((section) => section.keys),
  );
  const previewRows = RESTORE_PREVIEW_SECTIONS.map((section) => ({
    labelKey: section.labelKey,
    count: section.keys.reduce(
      (sum, key) => sum + (numericSummary[key] ?? 0),
      0,
    ),
  })).filter((entry) => entry.count > 0);
  const otherCount = Object.entries(numericSummary)
    .filter(([key]) => !namedKeys.has(key))
    .reduce((sum, [, value]) => sum + value, 0);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTyped("");
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          aria-label={t("admin.section.backups.restoreAria", {
            username: row.username,
          })}
          className="min-h-11"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <History className="h-3.5 w-3.5" />
          )}
          {t("admin.section.backups.restore")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("admin.section.backups.restoreTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin.section.backups.restoreDescription", {
              username: row.username,
              when: fmt.dateTime(row.createdAt),
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* v1.37.20 — what the file contains, before the typed gate. */}
        <div
          className="rounded-md border p-3 text-sm"
          data-slot="restore-preview"
        >
          <p className="text-muted-foreground mb-1.5 font-medium">
            {t("admin.section.backups.previewTitle")}
          </p>
          {preview.isLoading && (
            <p className="text-muted-foreground">
              {t("admin.section.backups.previewLoading")}
            </p>
          )}
          {preview.isError && (
            <p className="text-muted-foreground">
              {t("admin.section.backups.previewUnavailable")}
            </p>
          )}
          {preview.isSuccess && (
            <ul className="grid list-none grid-cols-1 gap-x-4 gap-y-0.5 p-0 sm:grid-cols-2">
              {previewRows.map((entry) => (
                <li
                  key={entry.labelKey}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="text-muted-foreground">
                    {t(`admin.section.backups.${entry.labelKey}`)}
                  </span>
                  <span className="tabular-nums">
                    {fmt.integer(entry.count)}
                  </span>
                </li>
              ))}
              {otherCount > 0 && (
                <li className="flex items-baseline justify-between gap-2">
                  <span className="text-muted-foreground">
                    {t("admin.section.backups.previewOther")}
                  </span>
                  <span className="tabular-nums">
                    {fmt.integer(otherCount)}
                  </span>
                </li>
              )}
              {previewRows.length === 0 && otherCount === 0 && (
                <li className="text-muted-foreground">
                  {t("admin.section.backups.previewEmpty")}
                </li>
              )}
            </ul>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor={`restore-prompt-${row.id}`}>
            {t("admin.section.backups.restorePromptLabel")}
          </Label>
          <Input
            id={`restore-prompt-${row.id}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="RESTORE"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!matched || pending}
            variant="destructive"
            onClick={() => {
              if (!matched) return;
              setOpen(false);
              setTyped("");
              onConfirm();
            }}
          >
            {pending
              ? t("admin.section.backups.restoreInProgress")
              : t("admin.section.backups.restoreConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function formatBytes(bytes: number, fmt: ReturnType<typeof useFormatters>) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${fmt.integer(Math.round(bytes / 1024))} KB`;
  }
  return `${fmt.number(bytes / 1024 / 1024, 2)} MB`;
}

/**
 * Render the `DataBackup.type` enum (`WEEKLY_AUTO` / `MANUAL`) as a
 * human label. Unknown values fall through to the raw enum so a future
 * type added in the schema is still legible at a glance.
 */
function formatBackupType(
  type: string,
  t: ReturnType<typeof useTranslations>["t"],
) {
  if (type === "WEEKLY_AUTO") return t("admin.section.backups.typeWeeklyAuto");
  if (type === "MANUAL") return t("admin.section.backups.typeManual");
  return type;
}

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
  if (catalogue === "medicationTarget") {
    return t("admin.section.backups.restoreSkippedMedicationTarget");
  }
  if (catalogue === "scheduleRevisionLink") {
    return t("admin.section.backups.restoreSkippedScheduleRevisionLink");
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
 * Why a file was refused, and what to do about it.
 *
 * Held on screen rather than left to the toast, exactly like the skip report
 * below it. The operator refused here is often holding the only copy of an
 * account; "restore failed" for four seconds is not enough to act on, and the
 * two facts that let them act — which section the file claimed and did not
 * carry, and that nothing was changed — have to survive long enough to be read.
 */
/**
 * The refused sections carried on an `ApiError`, or none.
 *
 * Keyed on `meta.errorCode` and not on the message text: the message is prose
 * the server may reword, and matching on it would turn a copy edit into a
 * silent loss of the panel.
 */
export function missingSectionsOf(err: unknown): MissingBackupSection[] {
  if (!(err instanceof ApiError)) return [];
  if (err.meta?.errorCode !== "backup.section.missing") return [];
  const sections = err.meta?.sections;
  if (!Array.isArray(sections)) return [];
  return sections.filter(
    (section): section is MissingBackupSection => typeof section === "string",
  );
}

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
function ScheduleHealthNotice({
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

export function BackupsSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.adminBackups(),
    queryFn: async () => {
      return apiGet<BackupsList>("/api/admin/backups");
    },
  });

  const runBackup = useMutation({
    mutationFn: async () => {
      return apiPost<{ jobId: string | null }>("/api/admin/backups/run");
    },
    onSuccess: () => {
      toast.success(t("admin.section.backups.runEnqueued"));
      // The job runs async; refetch after a short delay so the new row
      // shows up without leaving the user wondering whether the click
      // did anything.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.adminBackups() });
      }, 2000);
    },
    onError: (err) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.backups.runFailed"),
      );
    },
  });

  const rows: BackupRow[] = data?.rows ?? [];

  // Per-row download in-flight state — keyed by backup id so two
  // parallel clicks on different rows don't share a single spinner.
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // Upload state — single-file flow, drives the file input + button.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      // apiFetch with a raw init: the multipart body must NOT be JSON
      // re-encoded, so the verb helper (which JSON-stringifies) is out.
      return apiFetch<{
        id: string;
        valid: true;
        summary: {
          measurements: number;
          medications: number;
          intakeEvents: number;
          moodEntries: number;
          // Optional for the same reason as the keys below: a file written
          // before side effects rode the wire carries no key at all.
          medicationSideEffects?: number;
          cycles?: number;
          cycleDayLogs?: number;
          // v1.28 backup-completeness — optional so an older-schema upload
          // (pre-v1.28) still totals correctly without these keys.
          labResults?: number;
          biomarkers?: number;
          illnessEpisodes?: number;
          illnessDayLogs?: number;
          allergies?: number;
          familyHistory?: number;
          workouts?: number;
          documents?: number;
          // Optional for the same reason: a file written before each of these
          // rode the wire carries no key, and an absent key must total as
          // nothing rather than break the count.
          nutrientDays?: number;
          healthProfile?: number;
          healthProfileFactRevisions?: number;
          customMetrics?: number;
          customMetricEntries?: number;
          intradayProfiles?: number;
        };
      }>("/api/admin/backups/upload", { method: "POST", body: fd });
    },
    onSuccess: (data) => {
      const total =
        data.summary.measurements +
        data.summary.medications +
        data.summary.intakeEvents +
        data.summary.moodEntries +
        (data.summary.medicationSideEffects ?? 0) +
        (data.summary.cycles ?? 0) +
        (data.summary.cycleDayLogs ?? 0) +
        (data.summary.labResults ?? 0) +
        (data.summary.biomarkers ?? 0) +
        (data.summary.illnessEpisodes ?? 0) +
        (data.summary.illnessDayLogs ?? 0) +
        (data.summary.allergies ?? 0) +
        (data.summary.familyHistory ?? 0) +
        (data.summary.workouts ?? 0) +
        (data.summary.documents ?? 0) +
        // The count the admin is shown has to be the count the file carries.
        // The nutrient day totals were added to the payload and never to this
        // sum, so an upload that restored them reported fewer records than it
        // held — a smaller version of the same defect, on the reporting side.
        (data.summary.nutrientDays ?? 0) +
        (data.summary.healthProfile ?? 0) +
        (data.summary.healthProfileFactRevisions ?? 0) +
        (data.summary.customMetrics ?? 0) +
        (data.summary.customMetricEntries ?? 0) +
        (data.summary.intradayProfiles ?? 0);
      toast.success(
        t("admin.section.backups.uploadSuccess", { count: String(total) }),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.adminBackups() });
    },
    onError: (err) => {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.backups.uploadFailed"),
      );
    },
    onSettled: () => {
      // Reset the file input so the same file can be re-selected after a
      // rejected upload (browsers keep the previous selection otherwise).
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
  });

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
  }

  // What the last restore could not put back. Held in state rather than left
  // to the toast: a toast for "twelve symptom links are gone" disappears in
  // four seconds and the operator has no way to get it back. This panel stays
  // until they dismiss it.
  const [skipped, setSkipped] = useState<RestoreSkipSummary | null>(null);

  // Why the last restore was refused before it touched anything. Same reason
  // the skip report is held rather than toasted: the operator has to be able to
  // read it after the four seconds are up.
  const [refusedSections, setRefusedSections] = useState<
    MissingBackupSection[]
  >([]);

  // Restore: typed-confirmation dialog. The mutation is keyed by row id
  // and used inline by `<RestoreRowDialog>` below — keeping the
  // mutation here lets the parent invalidate the list query on success.
  const restore = useMutation({
    mutationFn: async (row: BackupRow) => {
      // Idempotency-Key prevents a double-click from re-running the
      // destructive transaction. Include the row id so two different
      // backups can both be restored independently in the same minute.
      const idempotencyKey = `restore-${row.id}-${randomId()}`;
      return apiPost<{ restored: true; skipped?: RestoreSkipSummary }>(
        `/api/admin/backups/${row.id}/restore`,
        { confirm: "RESTORE" },
        { headers: { "Idempotency-Key": idempotencyKey } },
      );
    },
    onSuccess: (data) => {
      // A restore that dropped links is not a plain success and must not read
      // as one. The count and the exact keys go on screen; the same report is
      // in the audit row for anyone asking later.
      setRefusedSections([]);
      const report = data.skipped;
      if (report && report.links > 0) {
        setSkipped(report);
        toast.warning(
          t("admin.section.backups.restoreSkippedToast", {
            links: String(report.links),
          }),
        );
      } else {
        setSkipped(null);
        toast.success(t("admin.section.backups.restoreSuccess"));
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.adminBackups() });
      // Restore touches every personal-data table; nuke the broader
      // cache so dashboards / lists rebuild against the new state.
      queryClient.invalidateQueries();
    },
    onError: (err) => {
      // The server refuses an incomplete file before it deletes anything, and
      // names the sections in `meta`. That is the one restore failure the
      // operator can act on, so it gets the panel rather than only a toast.
      const sections = missingSectionsOf(err);
      if (sections.length > 0) {
        setRefusedSections(sections);
        toast.error(t("admin.section.backups.restoreMissingTitle"));
        return;
      }
      setRefusedSections([]);
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.backups.restoreFailed"),
      );
    },
  });

  async function handleDownload(row: BackupRow) {
    setDownloadingId(row.id);
    try {
      // apiFetchRaw: the download needs the raw Response for the blob +
      // the Content-Disposition filename header.
      const res = await apiFetchRaw(`/api/admin/backups/${row.id}/download`);
      if (!res.ok) {
        throw new Error(await getApiErrorMessage(res));
      }
      // Use the server-provided Content-Disposition filename if present,
      // otherwise fall back to a deterministic client-side name. The
      // server filename is more accurate (uses the actual createdAt).
      const cd = res.headers.get("content-disposition") ?? "";
      const match = cd.match(/filename="?([^";]+)"?/i);
      const fallback = `healthlog-backup-${row.userId}-${row.createdAt.slice(0, 10)}.json`;
      const filename = match?.[1] ?? fallback;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(t("admin.section.backups.downloadStarted"));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t("admin.section.backups.downloadFailed"),
      );
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <SettingsCard>
      {/* v1.18.1 E3 — the snapshot count leads (numbers first) and the
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
              href="https://docs.healthlog.dev/admin/backups"
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

      {data?.schedule ? (
        <ScheduleHealthNotice schedule={data.schedule} />
      ) : null}

      {/* Upload card — separate from the table so admins can ingest a
          backup file independently of any existing rows. The visible
          button proxies a hidden file input so the layout stays clean
          while keyboard / screen-reader users keep a labelled control. */}
      <div className="bg-muted/30 border-border flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium">
            {t("admin.section.backups.uploadTitle")}
          </div>
          <p className="text-muted-foreground text-xs">
            {t("admin.section.backups.uploadDescription")}{" "}
            <span
              data-slot="backup-upload-help"
              className="text-muted-foreground"
            >
              {t("admin.section.backups.uploadHelp")}
            </span>
          </p>
        </div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={handleFileChange}
            aria-label={t("admin.section.backups.uploadButton")}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={upload.isPending}
            onClick={() => fileInputRef.current?.click()}
            className="min-h-11"
          >
            {upload.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {t("admin.section.backups.uploadButton")}
          </Button>
        </div>
      </div>

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
          message={t("admin.section.backups.loadError")}
          onRetry={() => void refetch()}
        />
      ) : rows.length === 0 ? (
        // v1.4.15 phase-C5: replace bare text with the EmptyState
        // primitive. The header already exposes "Backup now" but a
        // brand-new admin lands inside the card and benefits from a
        // duplicate CTA right next to the explanation.
        <div>
          <EmptyState
            icon={<Database className="size-6" />}
            title={t("admin.section.backups.emptyTitle")}
            description={t("admin.section.backups.emptyDescription")}
            action={
              <Button
                size="sm"
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
          {/* Wide layout: the canonical table. Hidden below `md`, where the
              five columns push Download / Restore off-screen behind a
              horizontal scroll; the card list below takes over there. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-xs">
                  <th className="px-3 py-2 text-left font-medium">
                    {t("admin.section.backups.colUser")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("admin.section.backups.colType")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("admin.section.backups.colSize")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("admin.section.backups.colCreatedAt")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("admin.section.backups.colActions")}
                  </th>
                </tr>
              </thead>
              {/* `backup-rows` names the read rows. The three branches above
                  are a spinner, a load error and an empty state, so the
                  marker cannot stand for a page that has not answered yet.
                  The narrow-layout list below carries it too, so a wait on
                  it holds at any viewport. */}
              <tbody data-slot="backup-rows" className="divide-border divide-y">
                {rows.map((row, i) => (
                  <tr key={row.id} className={i % 2 === 0 ? "bg-muted/30" : ""}>
                    <td className="px-3 py-2 font-medium">{row.username}</td>
                    <td className="px-3 py-2">
                      <Badge variant="secondary" className="text-xs">
                        {formatBackupType(row.type, t)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                      {formatBytes(row.sizeBytes, fmt)}
                    </td>
                    <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                      {fmt.dateTime(row.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={downloadingId === row.id}
                          onClick={() => handleDownload(row)}
                          aria-label={t("admin.section.backups.downloadAria", {
                            username: row.username,
                          })}
                          className="min-h-11"
                        >
                          {downloadingId === row.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                          ) : (
                            <Download className="h-3.5 w-3.5" />
                          )}
                          {t("admin.section.backups.download")}
                        </Button>
                        <RestoreRowDialog
                          row={row}
                          pending={
                            restore.isPending &&
                            restore.variables?.id === row.id
                          }
                          onConfirm={() => restore.mutate(row)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Narrow layout: each backup as a self-contained card with the
              meta line + a flex-wrapping action row, so Download / Restore
              stay reachable on a phone instead of scrolling off-screen. */}
          <ul
            className="space-y-2 md:hidden"
            data-slot="backup-rows"
            data-testid="admin-backups-mobile-list"
          >
            {rows.map((row) => (
              <ListRow
                asChild
                key={row.id}
                className="bg-muted/30 border-border"
              >
                <li>
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{row.username}</span>
                    <Badge variant="secondary" className="text-xs">
                      {formatBackupType(row.type, t)}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {t("admin.section.backups.colSize")}:{" "}
                    {formatBytes(row.sizeBytes, fmt)} ·{" "}
                    {fmt.dateTime(row.createdAt)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={downloadingId === row.id}
                      onClick={() => handleDownload(row)}
                      aria-label={t("admin.section.backups.downloadAria", {
                        username: row.username,
                      })}
                      className="min-h-11"
                    >
                      {downloadingId === row.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      {t("admin.section.backups.download")}
                    </Button>
                    <RestoreRowDialog
                      row={row}
                      pending={
                        restore.isPending && restore.variables?.id === row.id
                      }
                      onConfirm={() => restore.mutate(row)}
                    />
                  </div>
                </li>
              </ListRow>
            ))}
          </ul>

          <p className="text-muted-foreground mt-2 text-xs">
            {t("admin.section.backups.retentionLabel", {
              days: data!.retentionDays,
            })}
          </p>
        </div>
      )}

      <SettingsCardActions>
        <Button
          size="sm"
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
