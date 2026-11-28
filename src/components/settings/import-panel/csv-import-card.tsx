"use client";

import { useState } from "react";
import { Download, FileSpreadsheet, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { ImportSource } from "./import-card-shell";
import { ImportErrorLine, ImportPasteBody } from "./import-paste";
import { IMPORT_GUIDE_URL } from "./constants";
import { EXAMPLE_CSV } from "./import-examples";
import {
  CsvImportResultView,
  type CsvImportResult,
} from "./import-result-view";

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

/** Measurements from a CSV file or pasted text, with a preview first. */
export function CsvImportSource() {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CsvImportResult | null>(null);

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

  const disabled = busy || text.trim().length === 0;
  return (
    <ImportSource
      testId="import-card-csv"
      anchor="import-csv"
      icon={FileSpreadsheet}
      title={t("settings.sections.export.import.csv.title")}
      info={[
        t("settings.sections.export.import.csv.description"),
        t("settings.sections.export.import.csv.detail"),
      ]}
      meta={t("settings.sections.export.import.csv.rowMeta")}
      status={busy ? "running" : error ? "failed" : null}
      open={open}
      onOpenChange={setOpen}
      chooseTestId="import-choose-csv"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => void send(true)}
            data-testid="import-csv-preview"
          >
            {t("settings.sections.export.import.csv.preview")}
          </Button>
          <Button
            type="button"
            disabled={disabled}
            onClick={() => void send(false)}
            data-testid="import-action-csv"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("settings.sections.export.import.csv.import")}
          </Button>
        </>
      }
    >
      <ImportPasteBody
        slug="csv"
        fileMeta={t("settings.sections.export.import.csv.fileMeta")}
        accept=".csv,text/csv"
        fileInputLabel={t("settings.sections.export.import.csv.fileInputLabel")}
        placeholder="type,value,unit,measuredAt,…"
        text={text}
        onTextChange={(next) => {
          setText(next);
          setError(null);
          setResult(null);
        }}
        onReadFailed={() =>
          setError(t("settings.sections.export.import.csv.readFailed"))
        }
        guideTitle={t("settings.sections.export.import.guideTitle")}
        guideMeta={t("settings.sections.export.import.csv.guideMeta")}
        guide={
          <>
            <p>{t("settings.sections.export.import.csv.schemaHint")}</p>
            <p>
              {/* The import guide lives on the external docs site; the app
                  itself serves no /docs tree. */}
              <a
                href={IMPORT_GUIDE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {t("settings.sections.export.import.csv.docsLink")}
              </a>
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={downloadExample}
              data-testid="import-csv-download-example"
            >
              <Download className="h-3.5 w-3.5" />
              {t("settings.sections.export.import.csv.downloadExample")}
            </Button>
          </>
        }
        status={
          <>
            {result && <CsvImportResultView result={result} />}
            {error && <ImportErrorLine>{error}</ImportErrorLine>}
          </>
        }
      />
    </ImportSource>
  );
}
