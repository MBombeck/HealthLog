"use client";

import { useId, useMemo, useState } from "react";
import { Download, FileSpreadsheet, FlaskConical, Pill } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Switch } from "@/components/ui/switch";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { apiFetch, ApiError } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  RECORD_IMPORT_TEMPLATES,
  fieldsFor,
  guessFormat,
  guessMapping,
  readHead,
  type FieldKey,
  type FileHead,
  type RecordImportKind,
} from "@/lib/import/csv-mapping";
import type { RecordImportResult } from "@/lib/validations/record-import";

import { ImportCardShell } from "./import-card-shell";

/** The head of the file the mapping screen reads: enough for six rows. */
const HEAD_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

type Delimiter = "comma" | "semicolon" | "tab";

function delimiterName(d: string): Delimiter {
  return d === ";" ? "semicolon" : d === "\t" ? "tab" : "comma";
}

function downloadTemplate(kind: RecordImportKind) {
  const blob = new Blob([RECORD_IMPORT_TEMPLATES[kind]], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `healthlog-${kind}-template.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Settings > Export & Import: lab results and medications from a spreadsheet
 * (#1215). The card opens a sheet that reads the head of the file, suggests
 * the column for each field, lets the person correct every choice, checks
 * the whole file on the server (nothing written) and then imports it.
 */
export function RecordCsvImportCard() {
  const { t } = useTranslations();
  const [open, setOpen] = useState<RecordImportKind | null>(null);
  const [session, setSession] = useState(0);
  return (
    <ImportCardShell
      testId="import-card-records-csv"
      anchor="import-records-csv"
      icon={FileSpreadsheet}
      title={t("recordImport.title")}
      description={t("recordImport.description")}
    >
      <p className="text-sm">{t("recordImport.detail")}</p>
      <SettingsCardActions align="start">
        {(["labs", "medications"] as const).map((kind) => (
          <Button
            key={kind}
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            data-slot={`record-import-open-${kind}`}
            onClick={() => {
              setSession((n) => n + 1);
              setOpen(kind);
            }}
          >
            {kind === "labs" ? (
              <FlaskConical className="size-4" aria-hidden="true" />
            ) : (
              <Pill className="size-4" aria-hidden="true" />
            )}
            {t(`recordImport.kind.${kind}`)}
          </Button>
        ))}
      </SettingsCardActions>
      {open ? (
        <RecordCsvImportSheet
          key={session}
          kind={open}
          onOpenChange={(next) => !next && setOpen(null)}
        />
      ) : null}
    </ImportCardShell>
  );
}

/** What the sheet says about reading the file, below the format choices. */
function ImportNotes({ kind }: { kind: RecordImportKind }) {
  const { t } = useTranslations();
  return (
    <>
      <p className="text-muted-foreground text-xs">
        {t("recordImport.timezoneNote")}
      </p>
      {kind === "labs" ? (
        <p
          className="text-muted-foreground text-xs"
          data-slot="record-import-unitless-hint"
        >
          {t("recordImport.unitlessHint")}
        </p>
      ) : null}
    </>
  );
}

function RecordCsvImportSheet({
  kind,
  onOpenChange,
}: {
  kind: RecordImportKind;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [head, setHead] = useState<FileHead | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<FieldKey, number>>>({});
  const [delimiter, setDelimiter] = useState<Delimiter>("comma");
  const [decimal, setDecimal] = useState<"dot" | "comma">("dot");
  const [dateOrder, setDateOrder] = useState<"iso" | "dmy" | "mdy">("iso");
  const [header, setHeader] = useState(true);
  const [reminders, setReminders] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<RecordImportResult | null>(null);
  const [done, setDone] = useState<RecordImportResult | null>(null);

  const fields = fieldsFor(kind);
  const columns = useMemo(() => {
    if (!head) return [] as string[];
    const width = Math.max(...head.rows.map((r) => r.length), 0);
    return Array.from({ length: width }, (_, i) =>
      header && head.rows[0]?.[i]?.trim()
        ? head.rows[0][i].trim()
        : t("recordImport.column", { n: i + 1 }),
    );
  }, [head, header, t]);
  const missing = fields.filter(
    (f) => f.required && mapping[f.key] === undefined,
  );

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    e.target.value = "";
    setCheck(null);
    setDone(null);
    setError(null);
    if (!picked) return;
    if (picked.size > MAX_FILE_BYTES) {
      setError(t("recordImport.error.tooLarge"));
      return;
    }
    const text = await picked.slice(0, HEAD_BYTES).text();
    const parsedHead = readHead(text);
    const guessed = guessMapping(parsedHead.rows[0] ?? [], kind);
    const format = guessFormat(
      parsedHead,
      guessed[kind === "labs" ? "date" : "startsOn"],
    );
    setFile(picked);
    setHead(parsedHead);
    setMapping(guessed);
    setDelimiter(delimiterName(parsedHead.delimiter));
    setDecimal(format.decimal);
    setDateOrder(format.dateOrder);
  }

  async function send(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const params = new URLSearchParams({
      dryRun: dryRun ? "1" : "0",
      header: header ? "1" : "0",
      delimiter,
      decimal,
      dateOrder,
    });
    if (kind === "medications") params.set("reminders", reminders ? "1" : "0");
    for (const f of fields) {
      const index = mapping[f.key];
      if (index !== undefined) params.set(f.key, String(index));
    }
    try {
      const result = await apiFetch<RecordImportResult>(
        `/api/import/${kind}-csv?${params}`,
        {
          method: "POST",
          headers: { "Content-Type": "text/csv" },
          body: file,
          // A large file is read and written row by row; give it time.
          signal: AbortSignal.timeout(5 * 60_000),
        },
      );
      if (dryRun) setCheck(result);
      else setDone(result);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        status === 429
          ? t("recordImport.error.rateLimited")
          : status === 413
            ? t("recordImport.error.tooLarge")
            : status === 422
              ? t("recordImport.error.invalid")
              : t("recordImport.error.failed"),
      );
    } finally {
      setBusy(false);
    }
  }

  const result = done ?? check;

  return (
    <ResponsiveSheet
      open
      onOpenChange={onOpenChange}
      title={t(`recordImport.sheetTitle.${kind}`)}
      description={t(`recordImport.sheetDescription.${kind}`)}
      footer={
        done ? (
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            onClick={() => onOpenChange(false)}
          >
            {t("recordImport.close")}
          </Button>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              disabled={!file || busy || missing.length > 0}
              data-slot="record-import-check"
              onClick={() => send(true)}
            >
              {t("recordImport.check")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-11"
              disabled={!check || busy || check.inserted === 0}
              data-slot="record-import-run"
              onClick={() => send(false)}
            >
              {check
                ? t("recordImport.run", { count: fmt.integer(check.inserted) })
                : t("recordImport.runIdle")}
            </Button>
          </div>
        )
      }
    >
      <div
        className="space-y-4"
        data-slot="record-import-sheet"
        data-kind={kind}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={fileId} className="sr-only">
            {t("recordImport.file")}
          </Label>
          <input
            id={fileId}
            type="file"
            accept=".csv,text/csv,text/plain"
            data-slot="record-import-file"
            className="text-sm"
            onChange={onFile}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            data-slot="record-import-template"
            onClick={() => downloadTemplate(kind)}
          >
            <Download className="size-4" aria-hidden="true" />
            {t("recordImport.template")}
          </Button>
        </div>

        {head ? (
          <>
            <fieldset
              className="grid gap-4 sm:grid-cols-2"
              data-slot="record-import-mapping"
            >
              <legend className="mb-2 text-sm font-medium">
                {t("recordImport.mapping")}
              </legend>
              {fields.map((f) => (
                <div key={f.key} className="grid gap-1.5">
                  <Label htmlFor={`map-${f.key}`}>
                    {t(`recordImport.field.${f.key}`)}
                    {f.required ? ` ${t("recordImport.required")}` : ""}
                  </Label>
                  <NativeSelect
                    id={`map-${f.key}`}
                    data-slot={`record-import-map-${f.key}`}
                    value={
                      mapping[f.key] === undefined ? "" : String(mapping[f.key])
                    }
                    onChange={(e) => {
                      setCheck(null);
                      const v = e.target.value;
                      setMapping((m) => {
                        const next = { ...m };
                        // One column feeds one field: taking it here frees it elsewhere.
                        for (const k of Object.keys(next) as FieldKey[]) {
                          if (v !== "" && next[k] === Number(v)) delete next[k];
                        }
                        if (v === "") delete next[f.key];
                        else next[f.key] = Number(v);
                        return next;
                      });
                    }}
                  >
                    <option value="">{t("recordImport.notInFile")}</option>
                    {columns.map((name, i) => (
                      <option key={i} value={String(i)}>
                        {name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ))}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="record-import-delimiter">
                  {t("recordImport.delimiter")}
                </Label>
                <NativeSelect
                  id="record-import-delimiter"
                  value={delimiter}
                  onChange={(e) => {
                    setCheck(null);
                    setDelimiter(e.target.value as Delimiter);
                  }}
                >
                  {(["comma", "semicolon", "tab"] as const).map((d) => (
                    <option key={d} value={d}>
                      {t(`recordImport.delimiterOption.${d}`)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="record-import-decimal">
                  {t("recordImport.decimal")}
                </Label>
                <NativeSelect
                  id="record-import-decimal"
                  value={decimal}
                  onChange={(e) => {
                    setCheck(null);
                    setDecimal(e.target.value as "dot" | "comma");
                  }}
                >
                  <option value="dot">
                    {t("recordImport.decimalOption.dot")}
                  </option>
                  <option value="comma">
                    {t("recordImport.decimalOption.comma")}
                  </option>
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="record-import-dates">
                  {t("recordImport.dateOrder")}
                </Label>
                <NativeSelect
                  id="record-import-dates"
                  value={dateOrder}
                  onChange={(e) => {
                    setCheck(null);
                    setDateOrder(e.target.value as "iso" | "dmy" | "mdy");
                  }}
                >
                  {(["iso", "dmy", "mdy"] as const).map((o) => (
                    <option key={o} value={o}>
                      {t(`recordImport.dateOrderOption.${o}`)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="record-import-header">
                {t("recordImport.header")}
              </Label>
              <Switch
                id="record-import-header"
                checked={header}
                onCheckedChange={(v) => {
                  setCheck(null);
                  setHeader(v);
                }}
              />
            </div>
            {kind === "medications" ? (
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="record-import-reminders">
                  {t("recordImport.reminders")}
                </Label>
                <Switch
                  id="record-import-reminders"
                  checked={reminders}
                  onCheckedChange={(v) => {
                    setCheck(null);
                    setReminders(v);
                  }}
                />
              </div>
            ) : null}
            <ImportNotes kind={kind} />

            <div
              className="max-h-48 overflow-auto overscroll-contain rounded-lg border"
              data-slot="record-import-head"
            >
              <table className="w-full text-xs">
                <tbody className="divide-border divide-y">
                  {head.rows.map((row, r) => (
                    <tr
                      key={r}
                      className={
                        r === 0 && header ? "bg-muted font-medium" : undefined
                      }
                    >
                      {row.map((c, i) => (
                        <td
                          key={i}
                          className="max-w-40 truncate p-2 whitespace-nowrap"
                        >
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {missing.length > 0 && head ? (
          <p
            className="text-muted-foreground text-xs"
            data-slot="record-import-missing"
          >
            {t("recordImport.missing", {
              fields: missing
                .map((f) => t(`recordImport.field.${f.key}`))
                .join(", "),
            })}
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="text-destructive text-sm"
            data-slot="record-import-error"
          >
            {error}
          </p>
        ) : null}

        {result ? (
          <div
            className="space-y-3"
            data-slot={done ? "record-import-done" : "record-import-checked"}
            aria-live="polite"
          >
            <p className="text-sm font-medium">
              {done
                ? t("recordImport.summaryDone", {
                    inserted: fmt.integer(result.inserted),
                    duplicates: fmt.integer(result.duplicates),
                    failed: fmt.integer(result.failed),
                  })
                : t("recordImport.summaryCheck", {
                    rows: fmt.integer(result.rows),
                    inserted: fmt.integer(result.inserted),
                    duplicates: fmt.integer(result.duplicates),
                    failed: fmt.integer(result.failed),
                  })}
            </p>
            {result.markers &&
            (result.markers.created.length > 0 ||
              result.markers.matched.length > 0) ? (
              <div className="text-xs" data-slot="record-import-markers">
                {result.markers.matched.length > 0 ? (
                  <p>
                    <span className="text-muted-foreground">
                      {t("recordImport.markersMatched")}{" "}
                    </span>
                    {result.markers.matched
                      .map((m) =>
                        m.name === m.marker
                          ? m.name
                          : `${m.name} (${m.marker})`,
                      )
                      .join(", ")}
                  </p>
                ) : null}
                {result.markers.created.length > 0 ? (
                  <p>
                    <span className="text-muted-foreground">
                      {t("recordImport.markersCreated")}{" "}
                    </span>
                    {result.markers.created.join(", ")}
                  </p>
                ) : null}
              </div>
            ) : null}
            {result.errors.length > 0 ? (
              <ul
                className="max-h-48 divide-y overflow-y-auto overscroll-contain rounded-lg border text-xs"
                data-slot="record-import-errors"
              >
                {result.errors.map((e) => (
                  <li
                    key={`${e.line}-${e.reason}`}
                    className="flex gap-3 p-2"
                    data-slot="record-import-error-row"
                  >
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {t("recordImport.line", { line: fmt.integer(e.line) })}
                    </span>
                    <span>
                      {t(`recordImport.reason.${e.reason}`)}
                      {e.field
                        ? ` (${t(`recordImport.field.${e.field}`)})`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {result.errorsTruncated ? (
              <p className="text-muted-foreground text-xs">
                {t("recordImport.errorsTruncated")}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </ResponsiveSheet>
  );
}
