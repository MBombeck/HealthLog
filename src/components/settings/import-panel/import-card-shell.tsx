"use client";

import { useEffect, useState, type RefObject } from "react";
import { Loader2, type LucideIcon } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { FileInput } from "@/components/ui/file-picker";
import { InfoPopover } from "@/components/ui/info-popover";
import { ListItem } from "@/components/ui/list-row";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { StatusChip } from "@/components/ui/status-chip";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/** What a source row shows on its right instead of "Choose". */
export type SourceRowStatus = "running" | "failed" | null;

/**
 * A file source: the row's "Choose" opens the file dialog straight away.
 * The input's ref travels beside this as `fileInputRef`, not inside it, so
 * reading these fields during render never reads a ref.
 */
export interface SourceFileInput {
  accept: string;
  multiple?: boolean;
  /** Accessible name of the file input. */
  inputLabel: string;
  onFiles: (files: File[]) => void;
}

/** The neutral icon tile a source or export row leads with. */
export function SourceIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="bg-muted text-foreground flex size-8 items-center justify-center rounded-lg">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

/**
 * A row that takes a dropped file: the drag highlight and the drop. A drop
 * while something runs is ignored, as "Choose" is disabled then.
 */
function useFileDrop(
  onFiles: ((files: File[]) => void) | undefined,
  { multiple = false, busy = false }: { multiple?: boolean; busy?: boolean },
) {
  const [active, setActive] = useState(false);
  if (!onFiles) return { active: false, handlers: {} };
  return {
    active,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        if (!busy) setActive(true);
      },
      onDragLeave: () => setActive(false),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setActive(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length > 0 && !busy)
          onFiles(multiple ? files : files.slice(0, 1));
      },
    },
  };
}

/** Open the sheet when the page is reached through the row's own anchor. */
export function useOpenOnAnchor(anchor: string, open: () => void): void {
  useEffect(() => {
    if (window.location.hash === `#${anchor}`) open();
    // Once, on arrival; a later hash change is the reader's own scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);
}

/**
 * One source of the import list: a row on the page (icon, name, one meta
 * line, "Choose" or a status chip on the right) and the sheet that holds the
 * source's step. The row is the whole tap target and opens the sheet; "Choose"
 * on a file source opens the file dialog first and the sheet once files are
 * picked, and a file dropped on the row does the same. The file input lives
 * in the row, so it stays mounted while the sheet is closed, and the
 * source's state lives in its component, so an upload keeps running with the
 * sheet closed. UI standards §20.
 */
export function ImportSource({
  testId,
  anchor,
  icon,
  title,
  info,
  meta,
  status = null,
  open,
  onOpenChange,
  file,
  fileInputRef,
  query,
  chooseTestId,
  footer,
  children,
}: {
  testId: string;
  /** Deep-link anchor of the row (`/settings/export#<anchor>`). */
  anchor: string;
  icon: LucideIcon;
  title: string;
  /** The (i) after the sheet's title: what the source is, how to get the file. */
  info?: readonly string[];
  /** The row's one meta line: format and limit, or the last result. */
  meta: React.ReactNode;
  status?: SourceRowStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file?: SourceFileInput;
  /** The file input of a file source, which "Choose" clicks. */
  fileInputRef?: RefObject<HTMLInputElement | null>;
  /**
   * The source's status read. When it fails the row says so with the Error
   * chip, and the sheet opens on the failure with Retry; choosing a file
   * stays possible (the server refuses a second run itself).
   */
  query?: { isError: boolean; error: unknown; refetch: () => unknown };
  chooseTestId: string;
  /** The sheet's actions; none by default, since the header X closes it. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useTranslations();
  useOpenOnAnchor(anchor, () => onOpenChange(true));
  const readFailed = query?.isError === true;
  const rowStatus = status ?? (readFailed ? "failed" : null);
  const drop = useFileDrop(
    file
      ? (files) => {
          file.onFiles(files);
          onOpenChange(true);
        }
      : undefined,
    { multiple: file?.multiple, busy: status === "running" },
  );
  return (
    <>
      <ListItem
        id={anchor}
        data-testid={testId}
        data-status={rowStatus ?? "idle"}
        className={cn("scroll-mt-28", drop.active && "bg-primary/5")}
        {...drop.handlers}
        icon={<SourceIcon icon={icon} />}
        title={title}
        meta={readFailed && status === null ? t("common.loadFailed") : meta}
        onSelect={() => onOpenChange(true)}
        trailing={
          <>
            {rowStatus ? (
              <StatusChip
                tone={rowStatus === "running" ? "running" : "error"}
              />
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="relative z-10"
                data-testid={chooseTestId}
                onClick={() =>
                  file ? fileInputRef?.current?.click() : onOpenChange(true)
                }
              >
                {t("settings.sections.export.import.pickerChoose")}
              </Button>
            )}
            {file ? (
              <FileInput
                ref={fileInputRef}
                accept={file.accept}
                multiple={file.multiple}
                className="sr-only"
                aria-label={file.inputLabel}
                tabIndex={-1}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  // Reset so choosing the same file again fires once more.
                  e.target.value = "";
                  if (files.length === 0) return;
                  file.onFiles(files);
                  onOpenChange(true);
                }}
              />
            ) : null}
          </>
        }
      />
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        contentWidth="lg"
        title={
          info && info.length > 0 ? (
            <>
              {title}{" "}
              <span className="align-middle">
                <ImportInfo lines={info} />
              </span>
            </>
          ) : (
            title
          )
        }
        footer={footer}
      >
        <div data-testid={`${testId}-sheet`} className="space-y-4">
          {query ? <ImportQueryErrorRow query={query} /> : null}
          {children}
        </div>
      </ResponsiveSheet>
    </>
  );
}

/**
 * The fold-open card the folder source under Settings › Integrations still
 * uses: a title, its (i), and the form under one row that opens.
 */
export function ImportCardShell({
  testId,
  anchor,
  icon: Icon,
  title,
  description,
  foldLabel,
  status,
  children,
}: {
  testId: string;
  anchor: string;
  icon: LucideIcon;
  title: string;
  description?: string;
  foldLabel?: string;
  /** A `StatusChip` for a card that is a connection (the remote folder). */
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useTranslations();
  return (
    <SettingsCard
      data-testid={testId}
      flush
      className="flex flex-col self-start"
    >
      <SettingsCardHeader
        anchor={anchor}
        icon={Icon}
        title={
          description ? (
            <>
              {title}{" "}
              <span className="align-middle">
                <ImportInfo lines={[description]} />
              </span>
            </>
          ) : (
            title
          )
        }
        status={status}
        className="p-4 md:p-6"
      />
      <Disclosure
        data-fold
        summary={foldLabel ?? t("common.import")}
        className="border-t px-4 [&>summary]:min-h-14"
      >
        <div className="flex flex-col gap-3 pb-4">{children}</div>
      </Disclosure>
    </SettingsCard>
  );
}

/**
 * The (i) beside a sheet's title: what the source is for and how to get the
 * file, one line each.
 */
export function ImportInfo({ lines }: { lines: readonly string[] }) {
  return (
    <InfoPopover
      align="start"
      content={lines.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    />
  );
}

/**
 * The picker as the first row of a sheet's list: "File" or "Files" left,
 * "Choose" right, and a meta line that says what the row takes or, while
 * something runs, where it stands. It clicks the input the source row holds,
 * and takes a dropped file like the source row does.
 */
export function ImportPickerRow({
  multiple = false,
  busy,
  inputRef,
  meta,
  actionTestId,
  onFiles,
}: {
  multiple?: boolean;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  meta: React.ReactNode;
  actionTestId: string;
  /** What a file dropped on the row does; the same as choosing it. */
  onFiles: (files: File[]) => void;
}) {
  const { t } = useTranslations();
  const drop = useFileDrop(onFiles, { multiple, busy });
  return (
    <ListItem
      data-import-picker=""
      className={cn(drop.active && "bg-primary/5")}
      {...drop.handlers}
      title={
        multiple
          ? t("settings.sections.export.import.pickerFiles")
          : t("settings.sections.export.import.pickerFile")
      }
      meta={meta}
      trailing={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          data-testid={actionTestId}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : null}
          {t("settings.sections.export.import.pickerChoose")}
        </Button>
      }
    />
  );
}

/**
 * What a finished import adds beyond its rows (notes, skipped types), at the
 * meta size, under the list.
 */
export function ImportDetails({
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div {...props} className="text-muted-foreground space-y-1 text-xs">
      {children}
    </div>
  );
}

/** A status read that failed, said with Retry, above the rows. */
export function ImportQueryErrorRow({
  query,
}: {
  query: { isError: boolean; error: unknown; refetch: () => unknown };
}) {
  if (!query.isError) return null;
  return (
    <QueryErrorRow
      inset
      error={query.error}
      onRetry={() => void query.refetch()}
    />
  );
}

/**
 * The row's meta line once a job has finished: the day and what it wrote,
 * or the day and that it failed. `null` when there is no finished job, so
 * the caller falls back to what the source takes.
 */
export function useFinishedJobMeta(): (
  job: {
    status: string;
    completedAt?: string | null;
    written: number;
  } | null,
) => string | null {
  const { t } = useTranslations();
  const fmt = useFormatters();
  return (job) => {
    if (!job?.completedAt) return null;
    const date = fmt.dateShortSmart(new Date(job.completedAt));
    if (job.status === "failed")
      return t("settings.sections.export.import.row.failed", { date });
    if (job.status === "done")
      return t("settings.sections.export.import.row.done", {
        date,
        count: job.written,
      });
    return null;
  };
}
