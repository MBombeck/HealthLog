import { useQuery } from "@tanstack/react-query";
import { History, Loader2 } from "lucide-react";
import { useState } from "react";

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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { isPreWipeBackupType } from "@/lib/account-deletion/pre-wipe-type";
import type { BackupRow } from "@/types/backups";

/**
 * How long the restore dialog waits for the contents of a copy. A copy's
 * counts are kept with it and come back at once; this only runs out on a copy
 * from an earlier version that the server is still reading whole, and stays
 * under the minute a reverse proxy commonly allows a request.
 */
const PREVIEW_TIMEOUT_MS = 55_000;

/**
 * What the restore dialog says when the contents did not come back: the key
 * the copy needs and this server lacks, a copy from an earlier version still
 * being read when the dialog stopped waiting, or anything else.
 */
export function restorePreviewFailure(
  error: unknown,
): "keyMissing" | "stillReading" | "unavailable" {
  if (
    error instanceof ApiError &&
    error.meta?.errorCode === "backup.key.missing"
  ) {
    return "keyMissing";
  }
  // `AbortSignal.timeout` rejects the fetch with a DOMException of this name.
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TimeoutError"
  ) {
    return "stillReading";
  }
  return "unavailable";
}

/**
 * The sections a restore preview names, in render order. Each
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
    keys: ["vaccinations", "vaccinationLinks", "customVaccines"],
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

/**
 * What a copy contains, fetched the moment the restore dialog opens, so the
 * typed confirmation is an informed one. A failed preview never blocks the
 * restore; it states its own absence instead.
 */
export function RestorePreview({
  backupId,
  open,
}: {
  backupId: string;
  open: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // Never retried. The server answers from counts kept with the copy, at
  // once; only a copy from an earlier version is read whole, and that read
  // goes on (and is kept) after this request gives up. A retry would only
  // start the same read a second time (#1031).
  const preview = useQuery({
    queryKey: queryKeys.adminBackupSummary(backupId),
    queryFn: () =>
      apiGet<{ summary: Record<string, unknown> }>(
        `/api/admin/backups/${backupId}/summary`,
        { signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS) },
      ),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  const previewFailure = restorePreviewFailure(preview.error);
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
    <div className="rounded-md border p-3 text-sm" data-slot="restore-preview">
      <p className="text-muted-foreground mb-1.5 font-medium">
        {t("admin.section.backups.previewTitle")}
      </p>
      {preview.isLoading && (
        <p className="text-muted-foreground">
          {t("admin.section.backups.previewLoading")}
        </p>
      )}
      {preview.isError &&
        (previewFailure === "keyMissing" &&
        preview.error instanceof ApiError ? (
          // The one preview failure the restore would repeat: say which
          // key, so the operator can put it back before trying.
          <p role="alert" className="text-destructive">
            {t("admin.section.backups.previewKeyMissing", {
              keys: Array.isArray(preview.error.meta?.keyIds)
                ? preview.error.meta.keyIds.map(String).join(", ")
                : "",
            })}
          </p>
        ) : previewFailure === "stillReading" ? (
          <p className="text-muted-foreground">
            {t("admin.section.backups.previewStillReading")}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {t("admin.section.backups.previewUnavailable")}
          </p>
        ))}
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
              <span className="tabular-nums">{fmt.integer(entry.count)}</span>
            </li>
          ))}
          {otherCount > 0 && (
            <li className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">
                {t("admin.section.backups.previewOther")}
              </span>
              <span className="tabular-nums">{fmt.integer(otherCount)}</span>
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
  );
}

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
 * What the restore does, and for a copy a data wipe took, what undoing the
 * wipe with it does not bring back.
 */
export function restoreDescription(
  row: Pick<BackupRow, "username" | "type">,
  t: ReturnType<typeof useTranslations>["t"],
  when: string,
): string {
  const replaces = t("admin.section.backups.restoreDescription", {
    username: row.username,
    when,
  });
  return isPreWipeBackupType(row.type)
    ? `${replaces} ${t("admin.section.backups.restorePreWipeLimits")}`
    : replaces;
}

export function RestoreRowDialog({
  row,
  pending,
  onConfirm,
}: {
  row: BackupRow;
  pending: boolean;
  onConfirm: (options: { restoreInstanceSettings: boolean }) => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const matched = typed.trim() === "RESTORE";
  // Off unless the operator says otherwise. A disaster-recovery snapshot
  // carries the host's own settings alongside the account's data, and putting
  // one account back is not a reason to reconfigure the installation for
  // everybody on it — so the second effect is a second decision.
  const [withInstanceSettings, setWithInstanceSettings] = useState(false);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setTyped("");
          setWithInstanceSettings(false);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="destructive"
          data-testid="backup-restore-trigger"
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
            {restoreDescription(row, t, fmt.dateTime(row.createdAt))}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* What the file contains, before the typed gate. */}
        <RestorePreview backupId={row.id} open={open} />
        {/* The second decision, before the typed gate rather than after it:
            the account's data comes back either way, the host's settings only
            if this is ticked. */}
        <label
          className="flex items-start gap-2 text-sm"
          data-slot="restore-instance-settings"
        >
          <Checkbox
            data-testid="backup-restore-instance-settings"
            checked={withInstanceSettings}
            onCheckedChange={(next) => setWithInstanceSettings(next === true)}
            className="mt-0.5"
          />
          <span>
            {t("admin.section.backups.restoreInstanceSettingsLabel")}
            <span className="text-muted-foreground block text-xs">
              {t("admin.section.backups.restoreInstanceSettingsHint")}
            </span>
          </span>
        </label>
        <div className="space-y-2">
          <Label htmlFor={`restore-prompt-${row.id}`}>
            {t("admin.section.backups.restorePromptLabel")}
          </Label>
          <Input
            id={`restore-prompt-${row.id}`}
            data-testid="backup-restore-prompt"
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
            data-testid="backup-restore-confirm"
            disabled={!matched || pending}
            variant="destructive"
            onClick={() => {
              if (!matched) return;
              setOpen(false);
              setTyped("");
              onConfirm({ restoreInstanceSettings: withInstanceSettings });
              setWithInstanceSettings(false);
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
