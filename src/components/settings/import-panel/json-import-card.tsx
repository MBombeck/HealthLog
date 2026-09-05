"use client";

import { useId, useRef, useState } from "react";
import { AlertCircle, Download, FileJson, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { ImportCardShell } from "./import-card-shell";
import { IMPORT_GUIDE_URL, MAX_PASTE_CHARS } from "./constants";
import {
  EXAMPLE_IMPORT_DOWNLOAD_HREF,
  parseImportJson,
} from "./import-examples";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";

interface JsonImportResult {
  measurements: number;
  moodEntries: number;
  skipped: number;
}

export function JsonImportCard() {
  const { t } = useTranslations();

  // Same reasoning as the CSV card: the JSON route answers 200 with a per-
  // concept count envelope, so a payload where every entry was refused used
  // to render the success tick. The counts decide the tone.
  const jsonOutcome = (r: JsonImportResult) =>
    classifyWrittenOutcome({
      written: r.measurements + r.moodEntries,
      skipped: r.skipped,
    });
  const jsonMessage = (r: JsonImportResult) => {
    const outcome = jsonOutcome(r);
    if (outcome === "empty") {
      return t("settings.sections.export.import.json.resultEmpty");
    }
    if (outcome === "failed") {
      return t("settings.sections.export.import.json.resultNothing", {
        skipped: r.skipped,
      });
    }
    if (outcome === "partial") {
      return t("settings.sections.export.import.json.resultSummary", {
        measurements: r.measurements,
        moods: r.moodEntries,
        skipped: r.skipped,
      });
    }
    return t("settings.sections.export.import.json.resultSuccess", {
      measurements: r.measurements,
      moods: r.moodEntries,
    });
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JsonImportResult | null>(null);
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
      setError(t("settings.sections.export.import.json.readFailed"));
    }
  }

  async function handleImport() {
    setError(null);
    setResult(null);
    const parsed = parseImportJson(text);
    if (!parsed.ok) {
      setError(t("settings.sections.export.import.json.invalidJson"));
      return;
    }
    const payload = parsed.value;
    setBusy(true);
    try {
      const res = await apiFetchRaw("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (res.status === 429) {
        setError(t("settings.sections.export.import.json.rateLimited"));
        return;
      }
      if (res.status === 422) {
        const body = await res.json().catch(() => null);
        setError(
          body?.error ??
            t("settings.sections.export.import.json.invalidPayload"),
        );
        return;
      }
      if (!res.ok) {
        setError(t("settings.sections.export.import.json.failed"));
        return;
      }
      const data = (await res.json()).data as JsonImportResult;
      setResult({
        measurements: data?.measurements ?? 0,
        moodEntries: data?.moodEntries ?? 0,
        skipped: data?.skipped ?? 0,
      });
    } catch {
      setError(t("settings.sections.export.import.json.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ImportCardShell
      testId="import-card-json"
      icon={FileJson}
      title={t("settings.sections.export.import.json.title")}
      description={t("settings.sections.export.import.json.description")}
    >
      <div className="space-y-1.5">
        <Label htmlFor={textareaId} className="text-xs">
          {t("settings.sections.export.import.json.pasteLabel")}
        </Label>
        <Textarea
          id={textareaId}
          data-testid="import-json-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          maxLength={MAX_PASTE_CHARS}
          spellCheck={false}
          placeholder='{"measurements":[…],"moodEntries":[…]}'
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
        accept=".json,application/json"
        className="sr-only"
        aria-label={t("settings.sections.export.import.json.fileInputLabel")}
        onChange={onFileChange}
      />

      <p className="text-muted-foreground text-xs">
        {t("settings.sections.export.import.json.schemaHint")}{" "}
        {/* The import guide lives on the external docs site — the app
            itself serves no /docs tree, so an internal link 404s. */}
        <a
          href={IMPORT_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {t("settings.sections.export.import.json.docsLink")}
        </a>
      </p>

      <div aria-live="polite" className="space-y-2">
        {result && (
          <WrittenOutcomeLine
            outcome={jsonOutcome(result)}
            message={jsonMessage(result)}
            testId="import-json-result"
          />
        )}
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
          data-testid="import-json-choose-file"
        >
          <Upload className="h-3.5 w-3.5" />
          {t("settings.sections.export.import.json.uploadFile")}
        </Button>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
        >
          <a
            href={EXAMPLE_IMPORT_DOWNLOAD_HREF}
            download="healthlog-import-example.json"
            data-testid="import-json-download-example"
          >
            <Download className="h-3.5 w-3.5" />
            {t("settings.sections.export.import.json.downloadExample")}
          </a>
        </Button>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={busy || text.trim().length === 0}
          onClick={handleImport}
          data-testid="import-action-json"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <FileJson className="h-3.5 w-3.5" />
          )}
          {t("settings.sections.export.import.json.import")}
        </Button>
      </SettingsCardActions>
    </ImportCardShell>
  );
}
