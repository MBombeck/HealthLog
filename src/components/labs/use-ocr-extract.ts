"use client";

/**
 * v1.18.9 — client hooks for the Lab-OCR ingestion flow.
 *
 *  - `useOcrCapability()` — the cheap capability probe that decides whether the
 *    "Scan a report" affordance shows.
 *  - `useOcrExtract()` — uploads the photo / PDF and returns the proposed rows.
 *    Since v1.40 the route only queues the read (202) and the rows come from
 *    the background run, so no proxy timeout can cut a slow model.
 *  - `useOcrCommit()` — writes the user-confirmed rows and invalidates the
 *    labs + biomarker query keys.
 */
import type { AiCapabilityState } from "@/lib/ai/capabilities/types";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import {
  resolveAiRun,
  useAiRunPhase,
  type WaitForAiRunOptions,
} from "@/hooks/use-ai-run";
import { apiFetch, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import type { AiRunAccepted } from "@/lib/documents/ai-runs/types";
import { ocrImageToText } from "@/lib/labs/local-ocr";
import {
  aiInputDependentKeys,
  documentDependentKeys,
  invalidateKeys,
  labDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
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
  /**
   * v1.43 — the marker the person chose on the review screen; the server then
   * remembers the analyte as its alias. Absent for an automatic match.
   */
  biomarkerId?: string;
}

export interface OcrCommitResult extends OcrCommitResponseDto {
  inserted: LabResultDto[];
}

/**
 * The capability route resolves the caller's own provider configuration.
 *
 * It only runs while the `labsOcr` capability on `/api/auth/me` could let a
 * scan happen: available, or missing nothing but the document-reading
 * consent, which the scan dialog asks for in place. Any other reason (the
 * operator's switch, no provider, the module, somebody else's record) means
 * no scan is offered, so there is nothing to probe.
 */
export function shouldProbeOcrCapability({
  isAuthenticated,
  isLoading,
  labsEnabled,
  mounted,
  ownRecord,
  labsOcr,
}: {
  isAuthenticated: boolean;
  isLoading: boolean;
  labsEnabled: boolean;
  mounted: boolean;
  /** In the caller's own record; the probe and the commit resolve the caller, never a grant. */
  ownRecord: boolean;
  labsOcr: AiCapabilityState;
}): boolean {
  const aiOffered = labsOcr.available || labsOcr.reason === "consent_required";
  return (
    isAuthenticated &&
    !isLoading &&
    labsEnabled &&
    mounted &&
    ownRecord &&
    aiOffered
  );
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

/** How long the queuing request may take: the upload and the enqueue, no model. */
const OCR_QUEUE_REQUEST_TIMEOUT_MS = 60_000;

/**
 * POST one lab-report extraction and follow the background run to its rows.
 * Vision mode uploads the file; text mode posts only the text the browser
 * OCR'd. The request itself only queues the read, so it carries a short
 * ceiling; the run's own deadline (the person's AI response time) ends a slow
 * read on the server.
 */
export async function postOcrExtract(
  input: { file: File } | { text: string },
  queryClient: QueryClient,
  progress: WaitForAiRunOptions & { onQueued?: () => void } = {},
): Promise<OcrExtractResponseDto> {
  const signal = AbortSignal.timeout(OCR_QUEUE_REQUEST_TIMEOUT_MS);
  let accepted: OcrExtractResponseDto | AiRunAccepted;
  if ("text" in input) {
    accepted = await apiPost<OcrExtractResponseDto | AiRunAccepted>(
      "/api/labs/ocr/extract",
      { mode: "text", text: input.text },
      { signal },
    );
  } else {
    const form = new FormData();
    form.append("file", input.file);
    accepted = await apiFetch<OcrExtractResponseDto | AiRunAccepted>(
      "/api/labs/ocr/extract",
      { method: "POST", body: form, signal },
    );
  }
  return resolveAiRun<OcrExtractResponseDto>(queryClient, accepted, progress);
}

/**
 * The extract mutation for one mode, plus the run phase the dialog shows while
 * the read runs in the background.
 */
function useOcrExtractMutation(
  read: (file: File) => Promise<{ file: File } | { text: string }>,
) {
  const queryClient = useQueryClient();
  const { phase, onQueued, onProgress, reset } = useAiRunPhase();
  const mutation = useMutation<OcrExtractResponseDto, Error, File>({
    mutationFn: async (file: File) =>
      postOcrExtract(await read(file), queryClient, { onQueued, onProgress }),
    onSettled: reset,
  });
  return { ...mutation, runPhase: mutation.isPending ? phase : "idle" };
}

/** Upload + extract (VISION mode). Resolves with the proposed review rows. */
export function useOcrExtract() {
  return useOcrExtractMutation(async (file) => ({ file }));
}

/**
 * TEXT mode (v1.18.10) — OCR the image IN THE BROWSER (tesseract.js), then POST
 * only the extracted text. The raw image never leaves the device. Resolves with
 * the same proposed-rows DTO the vision path returns, so the review/commit flow
 * is shared verbatim.
 */
export function useOcrTextExtract() {
  return useOcrExtractMutation(async (file) => ({
    text: await ocrImageToText(file),
  }));
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
      // It is also a provider input of the `labsOcr` capability on `/me`.
      void invalidateKeys(queryClient, aiInputDependentKeys);
    },
  });
}

/** The commit payload: the confirmed rows plus, in vision mode, the source file. */
export interface OcrCommitInput {
  rows: OcrCommitRowInput[];
  /**
   * The scanned file, threaded from the vision-mode extract. When present
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
 * File the scanned bytes into the Documents vault (kind LAB_RESULT) via the
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
      // A scan filed into the vault adds a document as well.
      void invalidateKeys(queryClient, [
        ...labDependentKeys,
        ...(file ? documentDependentKeys : []),
      ]);
    },
  });
}
