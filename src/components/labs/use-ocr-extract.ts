"use client";

/**
 * v1.18.9 — client hooks for the Lab-OCR ingestion flow.
 *
 *  - `useOcrCapability()` — the cheap capability probe that decides whether the
 *    "Scan a report" affordance shows.
 *  - `useOcrExtract()` — uploads the photo / PDF and returns the proposed rows.
 *    A vision call is slow, so it opts out of the default 15 s fetch timeout in
 *    favour of a generous 90 s window.
 *  - `useOcrCommit()` — writes the user-confirmed rows and invalidates the
 *    labs + biomarker query keys.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { ocrImageToText } from "@/lib/labs/local-ocr";
import { queryKeys } from "@/lib/query-keys";
import type {
  OcrCapabilityDto,
  OcrCommitResponseDto,
  OcrExtractResponseDto,
} from "@/lib/validations/labs-ocr";

import type { LabResultDto } from "./types";

/** Per-row payload the commit endpoint accepts (the human-confirmed shape). */
export interface OcrCommitRowInput {
  analyte: string;
  panel?: string;
  value?: number;
  valueText?: string;
  unit?: string;
  referenceLow?: number;
  referenceHigh?: number;
  referenceText?: string;
  takenAt: string;
}

export interface OcrCommitResult extends OcrCommitResponseDto {
  inserted: LabResultDto[];
}

/** The capability route resolves the caller's own provider configuration. */
export function shouldProbeOcrCapability({
  isAuthenticated,
  isLoading,
  labsEnabled,
  mounted,
  ownRecord,
}: {
  isAuthenticated: boolean;
  isLoading: boolean;
  labsEnabled: boolean;
  mounted: boolean;
  /** In the caller's own record; the probe and the commit resolve the caller, never a grant. */
  ownRecord: boolean;
}): boolean {
  return isAuthenticated && !isLoading && labsEnabled && mounted && ownRecord;
}

/** Capability probe — refetched when the scan dialog opens. */
export function useOcrCapability(enabled: boolean) {
  return useQuery<OcrCapabilityDto>({
    queryKey: queryKeys.ocrCapability(),
    queryFn: () => apiFetch<OcrCapabilityDto>("/api/labs/ocr/capability"),
    enabled,
    staleTime: 60_000,
  });
}

/** Upload + extract (VISION mode). Resolves with the proposed review rows. */
export function useOcrExtract() {
  return useMutation<OcrExtractResponseDto, Error, File>({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return apiFetch<OcrExtractResponseDto>("/api/labs/ocr/extract", {
        method: "POST",
        body: form,
        // Vision extraction is slow; a generous ceiling beats the 15 s default.
        signal: AbortSignal.timeout(90_000),
      });
    },
  });
}

/**
 * TEXT mode (v1.18.10) — OCR the image IN THE BROWSER (tesseract.js), then POST
 * only the extracted text. The raw image never leaves the device. Resolves with
 * the same proposed-rows DTO the vision path returns, so the review/commit flow
 * is shared verbatim.
 */
export function useOcrTextExtract() {
  return useMutation<OcrExtractResponseDto, Error, File>({
    mutationFn: async (file: File) => {
      const text = await ocrImageToText(file);
      return apiPost<OcrExtractResponseDto>("/api/labs/ocr/extract", {
        mode: "text",
        text,
      });
    },
  });
}

/** The local-OCR opt-in preference (read + toggle). */
export interface LabsLocalOcrPref {
  labsLocalOcrEnabled: boolean;
}

/** Read the current local-OCR opt-in flag. */
export function useLabsLocalOcr(enabled = true) {
  return useQuery<LabsLocalOcrPref>({
    queryKey: queryKeys.labsLocalOcr(),
    queryFn: () => apiGet<LabsLocalOcrPref>("/api/auth/me/labs-local-ocr"),
    enabled,
    staleTime: 60_000,
  });
}

/** Toggle the local-OCR opt-in; invalidates the flag + the capability probe. */
export function useUpdateLabsLocalOcr() {
  const queryClient = useQueryClient();
  return useMutation<LabsLocalOcrPref, Error, boolean>({
    mutationFn: (labsLocalOcrEnabled: boolean) =>
      apiPatch<LabsLocalOcrPref>("/api/auth/me/labs-local-ocr", {
        labsLocalOcrEnabled,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.labsLocalOcr(), data);
      // The toggle changes whether text-mode scanning is available.
      queryClient.invalidateQueries({ queryKey: queryKeys.ocrCapability() });
    },
  });
}

/** The commit payload: the confirmed rows plus, in vision mode, the source file. */
export interface OcrCommitInput {
  rows: OcrCommitRowInput[];
  /**
   * S9 — the scanned file, threaded from the vision-mode extract. When present
   * (and the documents module is on) it is filed into the Documents vault and
   * the committed labs are cross-linked to it. Absent in text mode, where the
   * image stays on-device.
   */
  file?: File | null;
  /**
   * The visit this panel came out of, when the review step offered one and the
   * person took the offer. Optional always — a commit with none named succeeds
   * unchanged.
   */
  encounterId?: string | null;
}

/**
 * S9 — file the scanned bytes into the Documents vault (kind LAB_RESULT) via the
 * existing upload endpoint (encrypted at rest, EXIF-stripped, thumbnailed,
 * sha256-deduped). Best-effort: a module-off account 403s and a re-scan dedupes,
 * so any failure resolves to `undefined` and the commit proceeds unlinked.
 */
async function fileScanToVault(file: File): Promise<string | undefined> {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", "LAB_RESULT");
  const doc = await apiFetch<{ id: string }>("/api/documents/inbound", {
    method: "POST",
    body: form,
  });
  return doc?.id;
}

/** Commit the confirmed rows and invalidate the dependent reads. */
export function useOcrCommit() {
  const queryClient = useQueryClient();
  return useMutation<OcrCommitResult, Error, OcrCommitInput>({
    mutationFn: async ({ rows, file, encounterId }: OcrCommitInput) => {
      const documentId = file
        ? await fileScanToVault(file).catch(() => undefined)
        : undefined;
      return apiPost<OcrCommitResult>("/api/labs/ocr/commit", {
        rows,
        ...(documentId ? { documentId } : {}),
        ...(encounterId ? { encounterId } : {}),
      });
    },
    onSuccess: (_result, { file }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
      // A scan filed into the vault adds a document — refresh its lists.
      if (file) {
        queryClient.invalidateQueries({ queryKey: queryKeys.documents() });
      }
    },
  });
}
