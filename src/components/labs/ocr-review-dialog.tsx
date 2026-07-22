"use client";

/**
 * v1.18.9 — the Lab-OCR "Scan a report" dialog.
 *
 * Flow: pick a photo / PDF → extract (vision provider) → MANDATORY human review
 * (per-row confirm/edit/discard, duplicate + new-biomarker + low-confidence
 * hints) → commit only the confirmed rows. Nothing writes until the user
 * confirms. Reuses the labs design language via `ResponsiveSheet` + the labs
 * row editor.
 */
import { useId, useMemo, useState } from "react";

import { Loader2, ScanLine, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { ApiError } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";

import { OcrRowEditor } from "./ocr-row-editor";
import { seedReviewRows, type OcrReviewRow } from "./ocr-review-types";
import {
  useOcrCommit,
  useOcrExtract,
  useOcrTextExtract,
  type OcrCommitRowInput,
} from "./use-ocr-extract";

type Stage = "pick" | "review";

/** How the scan runs: native vision vs in-browser (local) OCR. */
export type OcrMode = "vision" | "text";

const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
const ACCEPT_IMAGE_ONLY = "image/jpeg,image/png,image/webp";
type FilePickerInput = {
  files: ArrayLike<File> | null;
  value: string;
};

export function handleFilePickerChange(
  input: FilePickerInput,
  onFilePicked: (file: File) => void,
) {
  const file = input.files?.[0];
  // Reset so re-picking the same file fires `change` again.
  input.value = "";
  if (file) onFilePicked(file);
}

/** Map a confirmed review row to the commit payload, or null when invalid. */
function toCommitRow(row: OcrReviewRow): OcrCommitRowInput | null {
  const analyte = row.analyte.trim();
  if (!analyte || !row.takenAt) return null;
  // A calendar day → an ISO instant at noon UTC, avoiding a TZ day-shift.
  const takenAt = new Date(`${row.takenAt}T12:00:00.000Z`);
  if (Number.isNaN(takenAt.getTime())) return null;

  const isQualitative = row.valueText !== null && row.valueText !== undefined;
  if (isQualitative) {
    const valueText = (row.valueText ?? "").trim();
    if (!valueText) return null;
    return { analyte, valueText, takenAt: takenAt.toISOString() };
  }

  if (row.value === null || !Number.isFinite(row.value)) return null;
  const unit = (row.unit ?? "").trim();
  if (!unit) return null;
  return {
    analyte,
    value: row.value,
    unit,
    takenAt: takenAt.toISOString(),
    ...(row.referenceLow !== null ? { referenceLow: row.referenceLow } : {}),
    ...(row.referenceHigh !== null ? { referenceHigh: row.referenceHigh } : {}),
  };
}

/** Translate an extract failure into a friendly, error-code-aware message. */
function extractErrorMessage(err: unknown, t: (key: string) => string): string {
  if (err instanceof ApiError) {
    const code =
      typeof err.meta?.errorCode === "string" ? err.meta.errorCode : null;
    switch (code) {
      case "labs.ocr.providerUnsupported":
        return t("labs.ocr.providerUnsupported");
      case "labs.ocr.rateLimited":
        return t("labs.ocr.rateLimited");
      case "labs.ocr.budgetExceeded":
        return t("labs.ocr.budgetExceeded");
      case "labs.ocr.fileTooLarge":
        return t("labs.ocr.fileTooLarge");
      case "labs.ocr.fileType":
        return t("labs.ocr.fileType");
      case "labs.ocr.pdfNeedsAnthropic":
        return t("labs.ocr.pdfNeedsAnthropic");
      default:
        break;
    }
    if (err.status === 403) return t("labs.ocr.consentRequired");
  }
  return t("labs.ocr.extractFailed");
}

export function OcrReviewDialog({
  open,
  onOpenChange,
  mode,
  pdfSupported,
  onCommitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Native vision vs in-browser local OCR. Text mode is image-only. */
  mode: OcrMode;
  pdfSupported: boolean;
  onCommitted: () => void;
}) {
  const { t } = useTranslations();
  const pickerId = useId();
  const [stage, setStage] = useState<Stage>("pick");
  const [rows, setRows] = useState<OcrReviewRow[]>([]);
  // S9 — in vision mode the picked file is retained so, on commit, it can be
  // filed into the Documents vault and cross-linked to the committed labs. Text
  // mode keeps the image on-device, so nothing is retained there.
  const [pickedFile, setPickedFile] = useState<File | null>(null);

  // Text mode OCR's the image in the browser then POSTs the text; vision mode
  // uploads the image. Both resolve with the same proposed-rows DTO.
  const visionExtract = useOcrExtract();
  const textExtract = useOcrTextExtract();
  const extract = mode === "text" ? textExtract : visionExtract;
  const commit = useOcrCommit();
  // Text mode never accepts PDFs (tesseract.js can't read them).
  const allowPdf = mode === "vision" && pdfSupported;

  const confirmedCount = useMemo(
    () => rows.filter((r) => r.confirmed).length,
    [rows],
  );

  function reset() {
    setStage("pick");
    setRows([]);
    setPickedFile(null);
    extract.reset();
    commit.reset();
  }

  function handleClose(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function onFilePicked(file: File) {
    // Retain the source only for vision mode (text mode never sends the image).
    setPickedFile(mode === "vision" ? file : null);
    extract.mutate(file, {
      onSuccess: (data) => {
        const seeded = seedReviewRows(data.rows, data.reportDate);
        if (seeded.length === 0) {
          toast.error(t("labs.ocr.noRows"));
          return;
        }
        setRows(seeded);
        setStage("review");
      },
      onError: (err) => toast.error(extractErrorMessage(err, t)),
    });
  }

  function onSave() {
    const payload = rows
      .filter((r) => r.confirmed)
      .map(toCommitRow)
      .filter((r): r is OcrCommitRowInput => r !== null);
    if (payload.length === 0) {
      toast.error(t("labs.ocr.nothingToSave"));
      return;
    }
    commit.mutate(
      { rows: payload, file: pickedFile },
      {
        onSuccess: (result) => {
          toast.success(
            t("labs.ocr.savedToast", { count: result.inserted.length }),
          );
          onCommitted();
          handleClose(false);
        },
        onError: () => toast.error(t("labs.ocr.saveFailed")),
      },
    );
  }

  const busy = extract.isPending || commit.isPending;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={handleClose}
      title={t("labs.ocr.reviewTitle")}
      description={
        stage === "pick" ? t("labs.ocr.uploadHint") : t("labs.ocr.reviewHint")
      }
      footer={
        stage === "review" ? (
          <div className="flex w-full justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => handleClose(false)}
              disabled={busy}
              className="min-h-11 sm:min-h-9"
            >
              {t("labs.ocr.discardAll")}
            </Button>
            <Button
              onClick={onSave}
              disabled={busy || confirmedCount === 0}
              className="min-h-11 sm:min-h-9"
            >
              {commit.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("labs.ocr.saveSelected", { count: confirmedCount })}
            </Button>
          </div>
        ) : undefined
      }
    >
      {stage === "pick" ? (
        <div className="relative py-2">
          <input
            id={pickerId}
            type="file"
            accept={allowPdf ? ACCEPT : ACCEPT_IMAGE_ONLY}
            disabled={extract.isPending}
            className="peer absolute inset-0 z-10 h-full w-full cursor-pointer rounded-lg opacity-0 disabled:cursor-not-allowed"
            onChange={(event) =>
              handleFilePickerChange(event.currentTarget, onFilePicked)
            }
          />
          <label
            htmlFor={pickerId}
            className="border-muted-foreground/25 hover:bg-muted/50 peer-focus-visible:ring-ring flex min-h-44 w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center whitespace-normal peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
          >
            {extract.isPending ? (
              <>
                <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
                <span className="text-muted-foreground text-sm">
                  {/* Text mode runs OCR on-device first, then structures it —
                      the first run also downloads the OCR engine, so the copy
                      sets the "this is reading on your device" expectation. */}
                  {mode === "text"
                    ? t("labs.ocr.readingOnDevice")
                    : t("labs.ocr.extracting")}
                </span>
              </>
            ) : (
              <>
                <ScanLine
                  className="text-muted-foreground h-8 w-8"
                  aria-hidden
                />
                <span className="text-sm font-medium">
                  {t("labs.ocr.scanButton")}
                </span>
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Upload className="h-3.5 w-3.5" aria-hidden />
                  {allowPdf
                    ? t("labs.ocr.acceptWithPdf")
                    : t("labs.ocr.acceptImageOnly")}
                </span>
                {/* Honest accuracy caveat for the local-OCR fallback. */}
                {mode === "text" ? (
                  <span className="text-muted-foreground max-w-xs text-xs">
                    {t("labs.ocr.localModeHint")}
                  </span>
                ) : null}
              </>
            )}
          </label>
        </div>
      ) : (
        <div className="space-y-3 py-2">
          <p className="text-muted-foreground text-sm">
            {t("labs.ocr.foundCount", { count: rows.length })}
          </p>
          {rows.map((row) => (
            <OcrRowEditor
              key={row.key}
              row={row}
              onChange={(next) =>
                setRows((prev) =>
                  prev.map((r) => (r.key === next.key ? next : r)),
                )
              }
            />
          ))}
        </div>
      )}
    </ResponsiveSheet>
  );
}
