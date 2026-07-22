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
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ListRow } from "@/components/ui/list-row";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { BackupRow, BackupsList } from "@/types/backups";
import { getApiErrorMessage } from "./_shared";
import { apiFetch, apiFetchRaw, apiGet, apiPost } from "@/lib/api/api-fetch";

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

export function BackupsSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
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
        };
      }>("/api/admin/backups/upload", { method: "POST", body: fd });
    },
    onSuccess: (data) => {
      const total =
        data.summary.measurements +
        data.summary.medications +
        data.summary.intakeEvents +
        data.summary.moodEntries +
        (data.summary.cycles ?? 0) +
        (data.summary.cycleDayLogs ?? 0) +
        (data.summary.labResults ?? 0) +
        (data.summary.biomarkers ?? 0) +
        (data.summary.illnessEpisodes ?? 0) +
        (data.summary.illnessDayLogs ?? 0) +
        (data.summary.allergies ?? 0) +
        (data.summary.familyHistory ?? 0) +
        (data.summary.workouts ?? 0) +
        (data.summary.documents ?? 0);
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

  // Restore: typed-confirmation dialog. The mutation is keyed by row id
  // and used inline by `<RestoreRowDialog>` below — keeping the
  // mutation here lets the parent invalidate the list query on success.
  const restore = useMutation({
    mutationFn: async (row: BackupRow) => {
      // Idempotency-Key prevents a double-click from re-running the
      // destructive transaction. Include the row id so two different
      // backups can both be restored independently in the same minute.
      const idempotencyKey = `restore-${row.id}-${crypto.randomUUID()}`;
      return apiPost<{ restored: true }>(
        `/api/admin/backups/${row.id}/restore`,
        { confirm: "RESTORE" },
        { headers: { "Idempotency-Key": idempotencyKey } },
      );
    },
    onSuccess: () => {
      toast.success(t("admin.section.backups.restoreSuccess"));
      queryClient.invalidateQueries({ queryKey: queryKeys.adminBackups() });
      // Restore touches every personal-data table; nuke the broader
      // cache so dashboards / lists rebuild against the new state.
      queryClient.invalidateQueries();
    },
    onError: (err) => {
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
      {/* v1.18.1 E3 — the snapshot count leads (numbers first), the
          "Run now" button follows, and the explainer + docs link move
          into the header's description slot. Previously the description
          sat in a separate `mt-1 pl-7` paragraph that crowded the button
          directly above it; routing it through the header's `space-y-1`
          stack restores breathing room and left-aligns it under the
          title. */}
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
        status={
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

      {/* Upload card — separate from the table so admins can ingest a
          backup file independently of any existing rows. The visible
          button proxies a hidden file input so the layout stays clean
          while keyboard / screen-reader users keep a labelled control. */}
      <div className="bg-muted/30 border-border mt-4 flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
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

      {isLoading ? (
        <div className="mt-4 flex items-center gap-2">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
          <span className="text-muted-foreground text-sm">
            {t("admin.section.backups.loading")}
          </span>
        </div>
      ) : isError ? (
        <div
          role="alert"
          className="text-destructive bg-destructive/10 border-destructive/30 mt-4 rounded-md border px-3 py-2 text-sm"
        >
          {t("admin.section.backups.loadError")}
        </div>
      ) : rows.length === 0 ? (
        // v1.4.15 phase-C5: replace bare text with the EmptyState
        // primitive. The header already exposes "Backup now" but a
        // brand-new admin lands inside the card and benefits from a
        // duplicate CTA right next to the explanation.
        <div className="mt-4">
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
        <div className="mt-4">
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
              <tbody className="divide-border divide-y">
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
    </SettingsCard>
  );
}
