"use client";

/**
 * `<EncryptionSection>` — admin view of encryption coverage + key-rotation
 * status, with a guarded rotation trigger.
 *
 * Reads `GET /api/admin/encryption/status` (per-column rows-per-key-id, legacy
 * counts, overall rotation progress). NEVER surfaces key material — only key
 * ids (operator labels) and row counts. The rotation trigger POSTs to
 * `/api/admin/encryption/rotate`, which is step-up gated server-side; a 401
 * here means the admin needs a fresh second factor (or has none enrolled, in
 * which case the documented CLI is the path).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  KeyRound,
  Loader2,
  RotateCw,
  ShieldCheck,
} from "lucide-react";
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
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { StatTile } from "@/components/admin/_stat-tile";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { getApiErrorMessage } from "./_shared";
import { KeyBackupCard } from "./key-backup-card";
import { useKeyBackupStatus } from "./use-key-backup-status";

interface ColumnScan {
  model: string;
  field: string;
  kind: "string" | "bytes";
  total: number;
  byKeyId: Record<string, number>;
  legacy: number;
}

interface EncryptionStatus {
  activeKeyId: string;
  configuredKeyCount: number;
  rotationComplete: boolean;
  totalRows: number;
  activeRows: number;
  staleRows: number;
  columns: ColumnScan[];
  rotation: {
    state: "idle" | "running" | "completed" | "failed";
    lastRequestedAt: string | null;
    lastCompletedAt: string | null;
    lastResult: { scanned: number; rotated: number; errors: number } | null;
  };
  /** Which keys the backups still need; see the status route. */
  backups: {
    stored: Array<{ keyId: string; copies: number; oldestAt: string }>;
    unrecorded: { copies: number; oldestAt: string | null };
    offhost: Array<{
      keyId: string;
      firstWrittenAt: string;
      lastWrittenAt: string;
      neededUntil: string | null;
    }>;
    offhostExpirationDays: number | null;
    retiredKeysStillNeeded: string[];
  };
  safeToDropRetiredKeys: boolean;
}

export function EncryptionSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();

  // Same query as the card's own (deduplicated by key): read here only to
  // know when the page can paint the cards below it in one step.
  const keyBackup = useKeyBackupStatus();
  const statusQuery = useQuery({
    queryKey: queryKeys.adminEncryptionStatus(),
    queryFn: async (): Promise<EncryptionStatus> => {
      return apiGet<EncryptionStatus>("/api/admin/encryption/status", {
        credentials: "include",
      });
    },
    staleTime: 15_000,
  });

  const rotate = useMutation({
    mutationFn: async () => {
      const res = await apiFetchRaw("/api/admin/encryption/rotate", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error(t("admin.section.encryption.stepUpNeeded"));
        }
        throw new Error(await getApiErrorMessage(res));
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success(t("admin.section.encryption.rotateEnqueued"));
      queryClient.invalidateQueries({
        queryKey: queryKeys.adminEncryptionStatus(),
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || t("admin.section.encryption.rotateFailed"));
    },
  });

  // The card + header stay rendered across every query state so the heading
  // keeps a constant Y-offset — the loading branch used to return a bare
  // spinner row and the error branch a bare paragraph, so the section jumped
  // downward the moment the status resolved. Same shape as
  // `coach-feedback-section.tsx`, which fixed this for itself and never had
  // the fix carried across.
  // Until both reads land, only the key-backup card paints. It is the first
  // card and grows into its loaded shape with nothing under it yet; painting
  // the coverage card below it while the backup card was still a one-line
  // loader moved that card down the page when the backup status arrived.
  if (statusQuery.isLoading || keyBackup.isLoading) {
    return (
      <div className="space-y-6">
        <KeyBackupCard />
      </div>
    );
  }

  if (statusQuery.isError || !statusQuery.data) {
    return (
      <div className="space-y-6">
        <KeyBackupCard />
        <SettingsCard>
          <SettingsCardHeader
            icon={ShieldCheck}
            title={t("admin.section.encryption.coverageTitle")}
            description={t("admin.section.encryption.coverageDescription")}
          />
          <p className="text-sm">
            {t("admin.section.encryption.coverageDetail")}
          </p>

          <p role="alert" className="text-destructive text-sm">
            {t("admin.section.encryption.loadError")}
          </p>
        </SettingsCard>
      </div>
    );
  }

  const s = statusQuery.data;
  const running = s.rotation.state === "running" || rotate.isPending;
  const hasRetiredKey = s.configuredKeyCount > 1;
  // Only the rows that share a coverage view need the per-column table; sort
  // stale-first so an operator sees what still needs rotating.
  const columns = [...s.columns].sort((a, b) => b.legacy - a.legacy);

  return (
    <div className="space-y-6">
      <KeyBackupCard />
      {/* ── Coverage summary ───────────────────────────────────────── */}
      <SettingsCard>
        <SettingsCardHeader
          icon={ShieldCheck}
          title={t("admin.section.encryption.coverageTitle")}
          description={t("admin.section.encryption.coverageDescription")}
        />
        <p className="text-sm">
          {t("admin.section.encryption.coverageDetail")}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat
            label={t("admin.section.encryption.activeKeyId")}
            value={s.activeKeyId}
          />
          <Stat
            label={t("admin.section.encryption.configuredKeys")}
            value={String(s.configuredKeyCount)}
          />
          <Stat
            label={t("admin.section.encryption.totalRows")}
            value={s.totalRows.toLocaleString()}
          />
          <Stat
            label={t("admin.section.encryption.staleRows")}
            value={s.staleRows.toLocaleString()}
          />
        </div>
        {/* "Safe to drop the legacy key" needs a legacy key to drop. With a
            single configured key the server's flag is vacuously true, and
            the badge named a key that does not exist. */}
        {hasRetiredKey && s.safeToDropRetiredKeys ? (
          <Badge className="border-success/40 bg-success/15 text-success">
            {t("admin.section.encryption.safeToDropLegacy")}
          </Badge>
        ) : s.rotationComplete ? (
          // Every row is on the active key, and that is not the whole
          // answer: a backup keeps the key its content was written under.
          !hasRetiredKey &&
          s.backups.retiredKeysStillNeeded.length === 0 ? null : (
            <Badge variant="secondary" data-slot="encryption-backups-need-keys">
              {s.backups.retiredKeysStillNeeded.length > 0
                ? t("admin.section.encryption.backupsStillNeed", {
                    keys: s.backups.retiredKeysStillNeeded.join(", "),
                  })
                : t("admin.section.encryption.backupsUnrecordedBadge")}
            </Badge>
          )
        ) : (
          <Badge variant="secondary">
            {t("admin.section.encryption.rotationIncomplete", {
              count: s.staleRows,
            })}
          </Badge>
        )}
      </SettingsCard>

      {/* ── Keys the backups still need ───────────────────────────── */}
      <SettingsCard>
        <SettingsCardHeader
          icon={Archive}
          title={t("admin.section.encryption.backupsTitle")}
          description={t("admin.section.encryption.backupsDescription")}
        />
        <p className="text-sm">{t("admin.section.encryption.backupsDetail")}</p>
        <ul className="space-y-1 text-sm" data-slot="encryption-backup-keys">
          {s.backups.stored.map((row) => (
            <li key={`stored-${row.keyId}`}>
              {t("admin.section.encryption.backupsStoredLine", {
                key: row.keyId,
                count: row.copies,
                when: fmt.dateTime(row.oldestAt),
              })}
            </li>
          ))}
          {s.backups.unrecorded.copies > 0 && s.backups.unrecorded.oldestAt ? (
            <li>
              {t("admin.section.encryption.backupsUnrecordedLine", {
                count: s.backups.unrecorded.copies,
                when: fmt.dateTime(s.backups.unrecorded.oldestAt),
              })}
            </li>
          ) : null}
          {s.backups.offhost.map((row) => (
            <li key={`offhost-${row.keyId}`}>
              {row.neededUntil
                ? t("admin.section.encryption.backupsOffhostLine", {
                    key: row.keyId,
                    when: fmt.dateTime(row.lastWrittenAt),
                    until: fmt.dateTime(row.neededUntil),
                  })
                : t("admin.section.encryption.backupsOffhostLineUnknown", {
                    key: row.keyId,
                    when: fmt.dateTime(row.lastWrittenAt),
                  })}
            </li>
          ))}
          {s.backups.stored.length === 0 &&
          s.backups.unrecorded.copies === 0 &&
          s.backups.offhost.length === 0 ? (
            <li className="text-muted-foreground">
              {t("admin.section.encryption.backupsNone")}
            </li>
          ) : null}
        </ul>
      </SettingsCard>

      {/* ── Rotation status + trigger ──────────────────────────────── */}
      <SettingsCard>
        <SettingsCardHeader
          icon={KeyRound}
          title={t("admin.section.encryption.rotationTitle")}
          description={t("admin.section.encryption.rotationDescription")}
        />
        <div className="text-muted-foreground space-y-1 text-sm">
          <p>
            {t("admin.section.encryption.rotationState")}:{" "}
            <span className="text-foreground font-medium">
              {t(`admin.section.encryption.state.${s.rotation.state}`)}
            </span>
          </p>
          {s.rotation.lastResult && (
            <p>
              {t("admin.section.encryption.lastRun", {
                scanned: s.rotation.lastResult.scanned,
                rotated: s.rotation.lastResult.rotated,
                errors: s.rotation.lastResult.errors,
              })}
            </p>
          )}
        </div>

        <p className="text-muted-foreground text-xs">
          {t("admin.section.encryption.cliNote")}
        </p>

        <SettingsCardActions>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={running}
                data-testid="admin-encryption-rotate"
              >
                {running ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RotateCw className="h-3.5 w-3.5" />
                )}
                {t("admin.section.encryption.rotateNow")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("admin.section.encryption.rotateConfirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("admin.section.encryption.rotateConfirmDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("admin.section.encryption.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction onClick={() => rotate.mutate()}>
                  {t("admin.section.encryption.rotateConfirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </SettingsCardActions>
      </SettingsCard>

      {/* ── Per-column coverage table ──────────────────────────────── */}
      <SettingsCard>
        <SettingsCardHeader
          icon={ShieldCheck}
          title={t("admin.section.encryption.columnsTitle")}
          description={t("admin.section.encryption.columnsDescription")}
        />
        {/* Focusable, named scroll region: on a phone the table scrolls
            sideways, and a keyboard user has to be able to reach it
            (axe scrollable-region-focusable). */}
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label={t("admin.section.encryption.columnsTitle")}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-left">
                <th className="py-2 pr-3 font-medium">
                  {t("admin.section.encryption.colColumn")}
                </th>
                <th className="py-2 pr-3 font-medium">
                  {t("admin.section.encryption.colTotal")}
                </th>
                <th className="py-2 pr-3 font-medium">
                  {t("admin.section.encryption.colActive")}
                </th>
                <th className="py-2 font-medium">
                  {t("admin.section.encryption.colStale")}
                </th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c) => {
                const active = c.byKeyId[s.activeKeyId] ?? 0;
                const stale = c.total - active;
                return (
                  <tr key={`${c.model}.${c.field}`} className="border-b">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {c.model}.{c.field}
                    </td>
                    <td className="py-2 pr-3">{c.total.toLocaleString()}</td>
                    <td className="py-2 pr-3">{active.toLocaleString()}</td>
                    <td className="py-2">
                      {stale > 0 ? (
                        <Badge variant="secondary">
                          {stale.toLocaleString()}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SettingsCard>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <StatTile label={label} value={value} valueClassName="font-mono" />;
}
