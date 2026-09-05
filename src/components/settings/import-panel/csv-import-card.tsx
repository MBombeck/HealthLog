"use client";

import { useId, useRef, useState } from "react";
import {
  AlertCircle,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { ImportCardShell } from "./import-card-shell";
import { IMPORT_GUIDE_URL, MAX_PASTE_CHARS } from "./constants";
import { EXAMPLE_CSV } from "./import-examples";
import {
  CsvImportResultView,
  type CsvImportResult,
} from "./import-result-view";

export function CsvImportCard() {
  const { t } = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CsvImportResult | null>(null);
  const textareaId = useId();

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      const content = await file.text();
      setText(content);
    } catch {
      setError(t("settings.sections.export.import.csv.readFailed"));
    }
  }

  function downloadExample() {
    const blob = new Blob([EXAMPLE_CSV], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "healthlog-import-example.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function send(dryRun: boolean) {
    setError(null);
    setResult(null);
    if (text.trim().length === 0) {
      setError(t("settings.sections.export.import.csv.empty"));
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetchRaw(
        `/api/import/csv${dryRun ? "?dryRun=1" : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "text/csv" },
          credentials: "include",
          body: text,
        },
      );
      if (res.status === 429) {
        setError(t("settings.sections.export.import.csv.rateLimited"));
        return;
      }
      if (res.status === 413) {
        setError(t("settings.sections.export.import.csv.tooLarge"));
        return;
      }
      if (res.status === 422) {
        const body = await res.json().catch(() => null);
        setError(
          body?.error ??
            t("settings.sections.export.import.csv.invalidPayload"),
        );
        return;
      }
      if (!res.ok) {
        setError(t("settings.sections.export.import.csv.failed"));
        return;
      }
      const data = (await res.json()).data as CsvImportResult;
      setResult(data);
    } catch {
      setError(t("settings.sections.export.import.csv.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ImportCardShell
      testId="import-card-csv"
      icon={FileSpreadsheet}
      title={t("settings.sections.export.import.csv.title")}
      description={t("settings.sections.export.import.csv.description")}
    >
      <p className="text-sm">
        {t("settings.sections.export.import.csv.detail")}
      </p>

      <div className="space-y-1.5">
        <Label htmlFor={textareaId} className="text-xs">
          {t("settings.sections.export.import.csv.pasteLabel")}
        </Label>
        <Textarea
          id={textareaId}
          data-testid="import-csv-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          maxLength={MAX_PASTE_CHARS}
          spellCheck={false}
          placeholder="type,value,unit,measuredAt,…"
          className="font-mono text-xs"
        />
        <p className="text-muted-foreground text-right text-xs tabular-nums">
          {t("settings.sections.export.import.charCount", {
            used: text.length,
            max: MAX_PASTE_CHARS,
          })}
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        aria-label={t("settings.sections.export.import.csv.fileInputLabel")}
        onChange={onFileChange}
      />

      <p className="text-muted-foreground text-xs">
        {t("settings.sections.export.import.csv.schemaHint")}{" "}
        {/* The import guide lives on the external docs site — the app
            itself serves no /docs tree, so an internal link 404s. */}
        <a
          href={IMPORT_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {t("settings.sections.export.import.csv.docsLink")}
        </a>
      </p>

      <div aria-live="polite" className="space-y-2">
        {result && <CsvImportResultView result={result} />}
        {error && (
          <p
            role="alert"
            className="text-destructive flex items-start gap-2 text-sm"
          >
            <AlertCircle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>{error}</span>
          </p>
        )}
      </div>

      <SettingsCardActions className="mt-auto" align="start">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => fileInputRef.current?.click()}
          data-testid="import-csv-choose-file"
        >
          <Upload className="h-3.5 w-3.5" />
          {t("settings.sections.export.import.csv.uploadFile")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={downloadExample}
          data-testid="import-csv-download-example"
        >
          <Download className="h-3.5 w-3.5" />
          {t("settings.sections.export.import.csv.downloadExample")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={busy || text.trim().length === 0}
          onClick={() => void send(true)}
          data-testid="import-csv-preview"
        >
          {busy && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("settings.sections.export.import.csv.preview")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={busy || text.trim().length === 0}
          onClick={() => void send(false)}
          data-testid="import-action-csv"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <FileSpreadsheet className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.import.csv.import")}
        </Button>
      </SettingsCardActions>
    </ImportCardShell>
  );
}
