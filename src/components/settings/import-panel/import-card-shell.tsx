"use client";

import { useState, type RefObject } from "react";
import { Loader2, type LucideIcon } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { FileInput } from "@/components/ui/file-picker";
import { InfoPopover } from "@/components/ui/info-popover";
import { ListGroup, ListItem } from "@/components/ui/list-row";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

export interface ImportCardShellProps {
  testId: string;
  /** Deep-link anchor for the card (`/settings/export#<anchor>`). */
  anchor: string;
  icon: LucideIcon;
  title: string;
  description?: string;
  /** The label the folded body opens under; "Import" by default. */
  foldLabel?: string;
  /** The (i) after the title, holding the card's sentence and steps; by
   *  default the (i) holds `description` alone. */
  titleAccessory?: React.ReactNode;
  /** The body is rows (`ImportRows`), edge to edge under the header, with
   *  no fold of its own. Without it the body folds under one "Import" row. */
  rows?: boolean;
  children: React.ReactNode;
}

export function ImportCardShell({
  testId,
  anchor,
  icon: Icon,
  title,
  description,
  foldLabel,
  titleAccessory,
  rows = false,
  children,
}: ImportCardShellProps) {
  const { t } = useTranslations();
  // Every import card is a title and rows. Its one sentence sits behind the
  // (i), inline after the title so a narrow card does not push the (i) onto
  // a line of its own. A card without picker rows (the paste forms) keeps
  // its form under one "Import" row that folds open.
  const info =
    titleAccessory ??
    (description ? <ImportInfo lines={[description]} /> : null);
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
          info ? (
            <>
              {title} <span className="align-middle">{info}</span>
            </>
          ) : (
            title
          )
        }
        className="p-4 md:p-6"
      />
      {rows ? (
        children
      ) : (
        <Disclosure
          data-fold
          summary={foldLabel ?? t("common.import")}
          className="border-t px-4 [&>summary]:min-h-14"
        >
          <div className="flex flex-col gap-3 pb-4">{children}</div>
        </Disclosure>
      )}
    </SettingsCard>
  );
}

/**
 * The live region a file import card reports its progress and outcome in,
 * announced to assistive tech. When the last import's status could not be
 * read it says so first, with Retry, rather than looking like nothing ever
 * ran; uploading stays possible (the server refuses a second run itself).
 */
export function ImportStatusRegion({
  query,
  children,
}: {
  query: { isError: boolean; error: unknown; refetch: () => unknown };
  children: React.ReactNode;
}) {
  return (
    <div aria-live="polite" className="space-y-2">
      {query.isError && (
        <QueryErrorRow
          inset
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {children}
    </div>
  );
}

/**
 * The rows of a `rows` card: the shared `ListGroup`, drawn flush with the
 * card (a line above, none around), so the card holds rows, not a second card.
 */
export function ImportRows({
  children,
  ...props
}: React.ComponentProps<typeof ListGroup>) {
  return (
    <ListGroup
      {...props}
      className="rounded-none border-0 border-t bg-transparent shadow-none"
    >
      {children}
    </ListGroup>
  );
}

/**
 * The (i) beside a `rows` card's title: what the card is for and how to get
 * the file, one line each. The card itself carries none of it.
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
 * The picker as a row: "File" or "Files" left, "Choose" right, and a meta
 * line that says what the row takes or, while something runs, where it
 * stands. The row also takes a drop. The hidden input sits in the row.
 */
export function ImportPickerRow({
  multiple = false,
  busy,
  inputRef,
  accept,
  inputLabel,
  meta,
  actionTestId,
  onFiles,
}: {
  multiple?: boolean;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  accept: string;
  /** Accessible name of the file input. */
  inputLabel: string;
  meta: React.ReactNode;
  actionTestId: string;
  onFiles: (files: File[]) => void;
}) {
  const { t } = useTranslations();
  const [dragActive, setDragActive] = useState(false);
  return (
    <ListItem
      data-import-picker=""
      className={cn(dragActive && "bg-primary/5")}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length > 0 && !busy)
          onFiles(multiple ? files : files.slice(0, 1));
      }}
      title={
        multiple
          ? t("settings.sections.export.import.pickerFiles")
          : t("settings.sections.export.import.pickerFile")
      }
      meta={meta}
      trailing={
        <>
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
          <FileInput
            ref={inputRef}
            accept={accept}
            multiple={multiple}
            className="sr-only"
            aria-label={inputLabel}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) onFiles(files);
              // Reset so choosing the same file again fires once more.
              e.target.value = "";
            }}
          />
        </>
      }
    />
  );
}

/**
 * What a finished import adds beyond its count rows (notes, skipped types),
 * at the meta size, under the rows.
 */
export function ImportDetails({
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      className="text-muted-foreground space-y-1 border-t px-4 py-3 text-xs"
    >
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
    <div className="px-4 pb-4 md:px-6">
      <QueryErrorRow
        inset
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    </div>
  );
}
