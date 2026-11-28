"use client";

import { useState } from "react";
import { Download, FileJson, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { ImportSource } from "./import-card-shell";
import { ImportErrorLine, ImportPasteBody } from "./import-paste";
import { IMPORT_GUIDE_URL } from "./constants";
import {
  JSON_IMPORT_MAX_BYTES,
  JSON_IMPORT_MAX_ROWS,
} from "@/lib/import/json/limits";
import {
  EXAMPLE_IMPORT_DOWNLOAD_HREF,
  parseImportJson,
} from "./import-examples";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";

export interface JsonImportResult {
  measurements: number;
  moodEntries: number;
  skipped: number;
  /**
   * Tag and factor keys of imported mood entries this account has no tag
   * for (another account's own tags, mostly). The entries landed without
   * those links, which the count alone would not say.
   */
  droppedLinkKeys: string[];
  /**
   * Keys of the account's own tags and groups the file names differently.
   * The account's names were kept, never overwritten.
   */
  keptLabelKeys: string[];
}

/** The route's `data`, read field by field; a missing count reads as none. */
export function readJsonImportResult(
  data: {
    measurements?: number;
    moodEntries?: number;
    skipped?: number;
    droppedTagKeys?: string[];
    droppedFactorKeys?: string[];
    keptMoodTagKeys?: string[];
    keptMoodCategoryKeys?: string[];
  } | null,
): JsonImportResult {
  return {
    measurements: data?.measurements ?? 0,
    moodEntries: data?.moodEntries ?? 0,
    skipped: data?.skipped ?? 0,
    droppedLinkKeys: [
      ...(data?.droppedTagKeys ?? []),
      ...(data?.droppedFactorKeys ?? []),
    ],
    keptLabelKeys: [
      ...(data?.keptMoodTagKeys ?? []),
      ...(data?.keptMoodCategoryKeys ?? []),
    ],
  };
}

/** What an import wrote, and the links it could not make. */
export function JsonImportResultView({ result }: { result: JsonImportResult }) {
  const { t } = useTranslations();

  // Same reasoning as the CSV card: the JSON route answers 200 with a per-
  // concept count envelope, so a payload where every entry was refused used
  // to render the success tick. The counts decide the tone.
  const outcome = classifyWrittenOutcome({
    written: result.measurements + result.moodEntries,
    skipped: result.skipped,
  });
  const message =
    outcome === "empty"
      ? t("settings.sections.export.import.json.resultEmpty")
      : outcome === "failed"
        ? t("settings.sections.export.import.json.resultNothing", {
            skipped: result.skipped,
          })
        : outcome === "partial"
          ? t("settings.sections.export.import.json.resultSummary", {
              measurements: result.measurements,
              moods: result.moodEntries,
              skipped: result.skipped,
            })
          : t("settings.sections.export.import.json.resultSuccess", {
              measurements: result.measurements,
              moods: result.moodEntries,
            });
  return (
    <>
      <WrittenOutcomeLine
        outcome={outcome}
        message={message}
        testId="import-json-result"
      />
      {result.droppedLinkKeys.length > 0 && (
        <p
          className="text-muted-foreground text-xs"
          data-testid="import-json-dropped-links"
        >
          {t("settings.sections.export.import.json.droppedLinks", {
            keys: result.droppedLinkKeys.join(", "),
          })}
        </p>
      )}
      {result.keptLabelKeys.length > 0 && (
        <p
          className="text-muted-foreground text-xs"
          data-testid="import-json-kept-labels"
        >
          {t("settings.sections.export.import.json.keptLabels", {
            keys: result.keptLabelKeys.join(", "),
          })}
        </p>
      )}
    </>
  );
}

export function JsonImportSource() {
  const { t, locale } = useTranslations();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JsonImportResult | null>(null);
  // A write that failed part way: what is already in, so the person knows a
  // retry is safe rather than seeing "failed" alone.
  const [partial, setPartial] = useState<JsonImportResult | null>(null);

  async function handleImport() {
    setError(null);
    setResult(null);
    setPartial(null);
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
      if (res.status === 503) {
        const body = await res.json().catch(() => null);
        if (body?.meta?.stats) {
          setPartial(readJsonImportResult(body.meta.stats));
          setError(t("settings.sections.export.import.json.partial"));
          return;
        }
      }
      if (!res.ok) {
        setError(t("settings.sections.export.import.json.failed"));
        return;
      }
      setResult(readJsonImportResult((await res.json()).data ?? null));
    } catch {
      setError(t("settings.sections.export.import.json.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ImportSource
      testId="import-card-json"
      anchor="import-json"
      icon={FileJson}
      title={t("settings.sections.export.import.json.title")}
      info={[t("settings.sections.export.import.json.description")]}
      meta={t("settings.sections.export.import.json.rowMeta")}
      status={busy ? "running" : error ? "failed" : null}
      open={open}
      onOpenChange={setOpen}
      chooseTestId="import-choose-json"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            {t("common.close")}
          </Button>
          <Button
            type="button"
            disabled={busy || text.trim().length === 0}
            onClick={handleImport}
            data-testid="import-action-json"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {t("settings.sections.export.import.json.import")}
          </Button>
        </>
      }
    >
      <ImportPasteBody
        slug="json"
        fileMeta={t("settings.sections.export.import.json.fileMeta", {
          mb: JSON_IMPORT_MAX_BYTES / (1024 * 1024),
        })}
        accept=".json,application/json"
        fileInputLabel={t(
          "settings.sections.export.import.json.fileInputLabel",
        )}
        placeholder='{"measurements":[…],"moodEntries":[…]}'
        text={text}
        onTextChange={(next) => {
          setText(next);
          setError(null);
          setResult(null);
          setPartial(null);
        }}
        onReadFailed={() =>
          setError(t("settings.sections.export.import.json.readFailed"))
        }
        guideTitle={t("settings.sections.export.import.guideTitle")}
        guideMeta={t("settings.sections.export.import.json.schemaHint")}
        guide={
          <>
            {/* What this import is, and its limits: it adds measurements
                and mood entries; it is not a way back from a full backup.
                The numbers are the ones the route enforces. */}
            <p>
              {t("settings.sections.export.import.json.limitsHint", {
                mb: JSON_IMPORT_MAX_BYTES / (1024 * 1024),
                rows: JSON_IMPORT_MAX_ROWS.toLocaleString(locale),
              })}
            </p>
            <p>
              {/* The import guide lives on the external docs site; the app
                  itself serves no /docs tree. */}
              <a
                href={IMPORT_GUIDE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {t("settings.sections.export.import.json.docsLink")}
              </a>
            </p>
            <Button asChild variant="outline" size="sm">
              <a
                href={EXAMPLE_IMPORT_DOWNLOAD_HREF}
                download="healthlog-import-example.json"
                data-testid="import-json-download-example"
              >
                <Download className="h-3.5 w-3.5" />
                {t("settings.sections.export.import.json.downloadExample")}
              </a>
            </Button>
          </>
        }
        status={
          <>
            {result && <JsonImportResultView result={result} />}
            {error && <ImportErrorLine>{error}</ImportErrorLine>}
            {partial && (
              <p
                className="text-muted-foreground text-xs"
                data-testid="import-json-partial"
              >
                {t("settings.sections.export.import.json.partialCounts", {
                  measurements: partial.measurements,
                  moods: partial.moodEntries,
                })}
              </p>
            )}
          </>
        }
      />
    </ImportSource>
  );
}
