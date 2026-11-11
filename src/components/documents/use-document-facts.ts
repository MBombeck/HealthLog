"use client";

/**
 * Client hooks for the review-then-confirm chain on a stored document's
 * staged facts — the missing UI leg of the server chain that already existed:
 *
 *   extract (`POST …/extract`, incl. `{ mode: "stored" }` over the document's
 *   own indexed text) → PENDING `ExtractedFact` rows → optional per-fact edit
 *   (`PATCH …/facts/{factId}`, clears `needsReview`) → confirm
 *   (`POST …/confirm`) — the ONLY write into the structured stores.
 *
 * Nothing here commits on its own. The confirm mutation carries the explicit
 * approve/reject decisions the person made; a fact without a decision stays
 * pending on the server.
 */
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { resolveAiRun, useAiRunPhase } from "@/hooks/use-ai-run";
import { apiPatch, apiPost } from "@/lib/api/api-fetch";
import type {
  AiRunAccepted,
  DocumentExtractRunResult,
} from "@/lib/documents/ai-runs/types";
import {
  documentDependentKeys,
  illnessDependentKeys,
  invalidateKeys,
  labDependentKeys,
  medicationDependentKeys,
  queryKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import type {
  ExtractedFactDto,
  InboundFactEdit,
} from "@/lib/validations/inbound-documents";

/** The confirm route's per-batch outcome (per-fact misses never fail it). */
export interface ConfirmFactsResult {
  approved: { factId: string; recordType: string; recordId: string }[];
  rejected: string[];
  needsReview: string[];
  failed: { factId: string; reason: string }[];
}

/**
 * Structure the document's own stored extracted text into staged facts —
 * the manual recovery when the automatic staging run was skipped or failed.
 * Stages PENDING facts only; the review + confirm steps stay mandatory.
 *
 * The extraction runs in the background (v1.40): the request only queues it,
 * so no proxy can cut a slow model, and `runPhase` says so while it runs. The
 * run reports how many facts it staged; the facts themselves are read from
 * the document, which is refetched when the run ends.
 */
export function useStoredExtract() {
  const queryClient = useQueryClient();
  const { phase, onQueued, onProgress, reset } = useAiRunPhase();
  const mutation = useMutation<
    DocumentExtractRunResult,
    Error,
    { documentId: string }
  >({
    mutationFn: async ({ documentId }) =>
      resolveAiRun<DocumentExtractRunResult>(
        queryClient,
        await apiPost<DocumentExtractRunResult | AiRunAccepted>(
          `/api/documents/inbound/${documentId}/extract`,
          { mode: "stored" },
          {
            // The request only queues the read: the enqueue, no model.
            signal: AbortSignal.timeout(60_000),
            headers: { Prefer: "respond-async" },
          },
        ),
        { onQueued, onProgress },
      ),
    onSettled: reset,
    onSuccess: (_data, { documentId }) => {
      void invalidateKeys(queryClient, [
        queryKeys.inboundDocument(documentId),
        queryKeys.documents(),
      ]);
    },
  });
  return { ...mutation, runPhase: mutation.isPending ? phase : "idle" };
}

/**
 * Correct a staged fact before approval. A successful edit clears
 * `needsReview` server-side — the values become user-asserted and the fact
 * turns approvable. The fact's resource type can never change.
 */
export function useEditFact() {
  const queryClient = useQueryClient();
  return useMutation<
    ExtractedFactDto,
    Error,
    { documentId: string; factId: string; edit: InboundFactEdit }
  >({
    mutationFn: ({ documentId, factId, edit }) =>
      apiPatch<ExtractedFactDto>(
        `/api/documents/inbound/${documentId}/facts/${factId}`,
        edit,
      ),
    onSuccess: (_data, { documentId }) => {
      void invalidateKeys(queryClient, [queryKeys.inboundDocument(documentId)]);
    },
  });
}

/**
 * Every read a confirm can touch: the medications, conditions and lab values
 * it creates, with what derives from them, and the document itself (status
 * and fact states). A new medication or condition also reaches the dashboard
 * and the Today digest, which are unmounted while the person reviews.
 */
export function invalidateConfirmedFactReads(
  queryClient: QueryClient,
  documentId: string,
) {
  return Promise.all([
    invalidateKeys(queryClient, [
      ...medicationDependentKeys,
      ...illnessDependentKeys,
      ...labDependentKeys,
      ...documentDependentKeys,
      queryKeys.inboundDocument(documentId),
    ]),
    refetchInactiveDailyReads(queryClient),
  ]);
}

/**
 * Commit the review decisions. Approved facts land in their structured
 * stores (labs / conditions / medications) through the server's existing
 * field-by-field commit; rejected facts are discarded.
 */
export function useConfirmFacts() {
  const queryClient = useQueryClient();
  return useMutation<
    ConfirmFactsResult,
    Error,
    {
      documentId: string;
      decisions: {
        factId: string;
        action: "approve" | "reject";
        /** v1.43 — the marker the person chose for a lab value. */
        biomarkerId?: string;
      }[];
    }
  >({
    mutationFn: ({ documentId, decisions }) =>
      apiPost<ConfirmFactsResult>(
        `/api/documents/inbound/${documentId}/confirm`,
        { decisions },
      ),
    onSuccess: (_data, { documentId }) =>
      void invalidateConfirmedFactReads(queryClient, documentId),
  });
}
