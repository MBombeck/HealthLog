import { Download, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { formatBytes } from "@/lib/format/bytes";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { BackupRow } from "@/types/backups";

import { RestoreRowDialog } from "./restore-dialog";
import { isPreWipeBackupType } from "@/lib/account-deletion/pre-wipe-type";

/** What a row's Download and Restore controls act through. */
export type BackupRowActionProps = {
  downloadingId: string | null;
  onDownload: (row: BackupRow) => void;
  restorePending: (row: BackupRow) => boolean;
  onRestore: (
    row: BackupRow,
    options: { restoreInstanceSettings: boolean },
  ) => void;
};

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
  // The copy "Delete all entries" takes first; restorable until the deletion
  // grace window ends, when the purge job deletes it.
  if (isPreWipeBackupType(type)) return t("admin.section.backups.typePreWipe");
  return type;
}

/** Download and Restore for one copy; the same pair in both layouts. */
function BackupRowActions({
  row,
  downloadingId,
  onDownload,
  restorePending,
  onRestore,
}: BackupRowActionProps & { row: BackupRow }) {
  const { t } = useTranslations();
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid="backup-download"
        disabled={downloadingId === row.id}
        onClick={() => onDownload(row)}
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
        pending={restorePending(row)}
        onConfirm={(options) => onRestore(row, options)}
      />
    </>
  );
}

/**
 * Wide layout: the canonical table. Hidden below `md`, where the five
 * columns push Download / Restore off-screen behind a horizontal scroll; the
 * card list takes over there.
 */
export function BackupRowsTable({
  rows,
  ...actions
}: BackupRowActionProps & { rows: BackupRow[] }) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  return (
    <div className="relative hidden overflow-x-auto md:block">
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
            <tr
              key={row.id}
              data-backup-id={row.id}
              data-backup-username={row.username}
              className={i % 2 === 0 ? "bg-muted/30" : ""}
            >
              <td className="px-3 py-2 font-medium">{row.username}</td>
              <td className="px-3 py-2">
                <Badge variant="secondary" className="text-xs">
                  {formatBackupType(row.type, t)}
                </Badge>
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                {formatBytes(row.sizeBytes, locale)}
              </td>
              <td className="text-muted-foreground px-3 py-2 text-right text-xs whitespace-nowrap">
                {fmt.dateTime(row.createdAt)}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <div className="flex items-center justify-end gap-2">
                  <BackupRowActions row={row} {...actions} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Narrow layout: each backup as a self-contained card with the meta line and
 * a flex-wrapping action row, so Download / Restore stay reachable on a phone
 * instead of scrolling off-screen.
 */
export function BackupRowsCards({
  rows,
  ...actions
}: BackupRowActionProps & { rows: BackupRow[] }) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  return (
    <ul
      className="space-y-2 md:hidden"
      data-slot="backup-rows"
      data-testid="admin-backups-mobile-list"
    >
      {rows.map((row) => (
        <ListRow asChild key={row.id} className="bg-muted/30 border-border">
          <li data-backup-id={row.id} data-backup-username={row.username}>
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{row.username}</span>
              <Badge variant="secondary" className="text-xs">
                {formatBackupType(row.type, t)}
              </Badge>
            </div>
            <p className="text-muted-foreground text-xs">
              {t("admin.section.backups.colSize")}:{" "}
              {formatBytes(row.sizeBytes, locale)} ·{" "}
              {fmt.dateTime(row.createdAt)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <BackupRowActions row={row} {...actions} />
            </div>
          </li>
        </ListRow>
      ))}
    </ul>
  );
}
