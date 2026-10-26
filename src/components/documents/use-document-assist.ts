"use client";

/**
 * v1.27.22 (Document vault P2) — client hooks for the review-first AI layer on
 * a stored document: the shared capability probe, filing-metadata suggestions,
 * and the session-only summary / extracted text.
 *
 * Every affordance is gated on `usage.assistAvailable` at the call site; these
 * hooks only RUN the call once the surface has decided to offer it. The
 * transport (VISION vs local-OCR TEXT) comes from `document-ai-transport`.
 *
 * NOTHING here writes a document row. Suggestions are drafts the detail sheet
 * prefills; the summary is transient. The only mutation is the caller applying
 * a reviewed draft through the existing edit-on-commit machinery.
 */
import { useCallback } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAiProviderState } from "@/hooks/use-ai-capability";
import { useAiRunPhase } from "@/hooks/use-ai-run";
import { apiGet, ApiError } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type {
  DocumentAiCapabilityDto,
  DocumentSuggestionDto,
  DocumentSummaryMode,
} from "@/lib/validations/inbound-documents";

import {
  DocumentAssistClientError,
  runDocumentAi,
  type DocumentAiMode,
  type DocumentAiTarget,
} from "./document-ai-transport";

/** The describe result: raw text, or a summary plus its storage outcome. */
export type DocumentDescribeResult =
  | {
      summary: string;
      persistence?: "stored" | "withheld" | "failed";
    }
  | { text: string };

/**
 * The document-scoped AI capability probe (`/api/documents/inbound/capability`).
 * Resolved over the DOCUMENT provider order (local-first, codex last), so the
 * transport `mode` + PDF support match what the document routes do, and it
 * carries the vendor-blind `egress` class the detail sheet uses to warn before a
 * read leaves the machine. Availability of the affordance itself is still gated
 * on `usage.assistAvailable`.
 */
export function useDocumentAiCapability(enabled: boolean) {
  return useQuery<DocumentAiCapabilityDto>({
    queryKey: queryKeys.inboundDocumentAiCapability(),
    queryFn: () =>
      apiGet<DocumentAiCapabilityDto>("/api/documents/inbound/capability"),
    enabled,
    staleTime: 60_000,
  });
}

/** The per-user "read documents automatically with AI" opt-in. */
export interface DocumentsAutoAiReadPref {
  documentsAutoAiRead: boolean;
}

/**
 * Read the per-user auto-AI-read flag (`GET /api/auth/me/documents-auto-ai-read`).
 * Shares the cache key with the AI-settings toggle, so a flip there and this
 * read stay in lockstep. When ON, reading happens automatically on upload and
 * the detail sheet drops the manual per-document AI action row.
 */
export function useDocumentsAutoAiRead(enabled: boolean) {
  return useQuery<DocumentsAutoAiReadPref>({
    queryKey: queryKeys.documentsAutoAiRead(),
    queryFn: () =>
      apiGet<DocumentsAutoAiReadPref>("/api/auth/me/documents-auto-ai-read"),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Suggest filing metadata for a stored document. Returns DRAFTS only — the
 * detail sheet prefills its edit fields and the user saves; this call writes
 * nothing.
 *
 * The read runs in the background (v1.40), so no proxy in front of the server
 * can cut a slow model; `runPhase` says so while it does.
 */
export function useSuggestDetails() {
  const queryClient = useQueryClient();
  const { responseTimeoutMs } = useAiProviderState();
  const { phase, onQueued, onProgress, reset } = useAiRunPhase();
  const mutation = useMutation<
    DocumentSuggestionDto,
    Error,
    { mode: DocumentAiMode; target: DocumentAiTarget }
  >({
    mutationFn: async ({ mode, target }) => {
      const data = await runDocumentAi<{ suggestions: DocumentSuggestionDto }>({
        path: `/api/documents/inbound/${target.documentId}/suggest`,
        mode,
        target,
        responseTimeoutMs,
        modelCalls: 1,
        background: { queryClient, onQueued, onProgress },
      });
      return data.suggestions;
    },
    onSettled: reset,
  });
  return { ...mutation, runPhase: mutation.isPending ? phase : "idle" };
}

/**
 * On-demand summary or extracted text. Both stay transient unless the document
 * summary block explicitly requests persistence or replacement. The read runs
 * in the background (v1.40); `runPhase` says so while it does.
 */
export function useDocumentSummary() {
  const queryClient = useQueryClient();
  const { responseTimeoutMs } = useAiProviderState();
  const { phase, onQueued, onProgress, reset } = useAiRunPhase();
  const mutation = useMutation<
    DocumentDescribeResult,
    Error,
    {
      mode: DocumentAiMode;
      target: DocumentAiTarget;
      output: DocumentSummaryMode;
      persist?: boolean;
      replace?: boolean;
    }
  >({
    mutationFn: ({ mode, target, output, persist = false, replace = false }) =>
      runDocumentAi<DocumentDescribeResult>({
        path: `/api/documents/inbound/${target.documentId}/summary?mode=${output}${persist ? "&persist=true" : ""}${replace ? "&replace=true" : ""}`,
        mode,
        target,
        responseTimeoutMs,
        modelCalls: 1,
        background: { queryClient, onQueued, onProgress },
      }),
    onSettled: reset,
  });
  return { ...mutation, runPhase: mutation.isPending ? phase : "idle" };
}

/**
 * Map an AI error to a translation key. Server errors carry a stable
 * `meta.errorCode`; client-side precondition failures carry a `reason`. The
 * default is the calm "try again" message — never a raw provider string.
 */
/**
 * The actual wait, in whole minutes, behind a document-AI 429. The routes
 * mirror the bucket's reset instant into the error meta (`retryAt`, ISO 8601);
 * the window is an hour, so a fixed "try again in a few minutes" understated
 * the wait for most of it. Null when the error is not a document-AI rate-limit
 * response or carries no usable instant — the caller falls back to the generic
 * copy. Floored at one minute: a reset seconds away still reads as "about
 * 1 minute", never "0 minutes".
 */
export function documentAiRetryMinutes(err: unknown): number | null {
  if (!(err instanceof ApiError)) return null;
  if (err.meta?.errorCode !== "documents.inbound.rateLimited") return null;
  const raw = err.meta?.retryAt;
  if (typeof raw !== "string") return null;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.max(1, Math.ceil((at - Date.now()) / 60_000));
}

/**
 * Resolve a document-AI error to the user-facing sentence. Rate-limited
 * responses derive their copy from the ACTUAL reset instant ("try again in
 * about N minutes"); everything else maps through `documentAiErrorKey`. The
 * result is final text — callers render or toast it as-is.
 */
export function useDocumentAiErrorText(): (err: unknown) => string {
  const { t, tCount } = useTranslations();
  return useCallback(
    (err: unknown) => {
      const minutes = documentAiRetryMinutes(err);
      if (minutes !== null) {
        return tCount("documents.assist.errorRateLimitedWait", minutes);
      }
      return t(documentAiErrorKey(err));
    },
    [t, tCount],
  );
}

export function documentAiErrorKey(err: unknown): string {
  if (err instanceof DocumentAssistClientError) {
    switch (err.reason) {
      case "textImageOnly":
        return "documents.assist.errorTextImageOnly";
      case "ocr":
        return "documents.assist.errorOcr";
      default:
        return "documents.assist.errorGeneric";
    }
  }
  if (err instanceof ApiError) {
    const code =
      typeof err.meta?.errorCode === "string" ? err.meta.errorCode : "";
    switch (code) {
      case "documents.inbound.rateLimited":
        return "documents.assist.errorRateLimited";
      case "documents.inbound.budgetExceeded":
        return "documents.assist.errorBudget";
      case "documents.inbound.pdfNeedsAnthropic":
        return "documents.assist.errorPdfNeedsVision";
      case "documents.inbound.fileType":
        return "documents.assist.errorFileType";
      case "documents.inbound.localOcrDisabled":
        return "documents.assist.errorLocalOcrDisabled";
      case "documents.inbound.providerUnsupported":
        return "documents.assist.errorProvider";
      case "documents.inbound.notIndexed":
        return "documents.assist.errorNotIndexed";
      case "documents.inbound.outputLimit":
        return "documents.assist.errorOutputLimit";
      case "aiRuns.workerUnavailable":
        return "aiRuns.errorWorkerUnavailable";
      case "aiRuns.timedOut":
        return "aiRuns.errorTimedOut";
      case "aiRuns.readerBusy":
        return "aiRuns.errorReaderBusy";
      case "consent.ai.required":
        return "documents.assist.errorConsent";
      case "ai.provider.none":
        return "documents.assist.errorProvider";
      case "ai.record.notPermitted":
      case "module.disabled":
        return "documents.assist.errorUnavailable";
      default:
        // The operator switched reading off (`assistant.disabled.documentAi`,
        // or the master `assistant.disabled.enabled`).
        return code.startsWith("assistant.disabled.")
          ? "documents.assist.errorUnavailable"
          : "documents.assist.errorGeneric";
    }
  }
  return "documents.assist.errorGeneric";
}
