/**
 * Automatic per-document content indexing, enqueued the moment a document is
 * stored (`POST /api/documents/inbound`). Fire-and-forget: the upload response
 * never blocks on or fails because of indexing.
 *
 * The job runs the shared AI-first decision tree (`indexDocumentContent`):
 * provider (vision) first when one is configured + consented, else local
 * text-layer extraction, and OCR on this server for a scan or a photo. Then
 * the lab values of a lab report are staged for review: by the AI when its
 * staging may run, by rule (`maybeStageLabValuesWithoutModel`) when it may
 * not or did not. Owner-scoped; the provider path is consent + budget
 * gated; the local path needs neither (no egress). Serial concurrency keeps the
 * provider calls + PDF parsing off the request pool.
 *
 * The queue MUST be registered in the maintenance registrar
 * (`src/lib/jobs/reminder/register-maintenance.ts`) so pg-boss provisions it.
 */
import { STATUS_MODEL_CALLS } from "@/lib/ai/ai-budgets";
import {
  maybeAutoStageLabFacts,
  type AutoStageOutcome,
} from "@/lib/documents/auto-stage-labs";
import { maybeStageLabValuesWithoutModel } from "@/lib/documents/local-lab-values";
import { indexDocumentContent } from "@/lib/documents/index-document";
import { withPdfWork } from "@/lib/documents/pdf-isolation";
import type { OcrSchedule } from "@/lib/documents/ocr-plan";
import { ocrReadCallMs } from "@/lib/documents/ocr-read";
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import { caughtAs, logCaught } from "@/lib/logging/signal";
import {
  DOCUMENT_INDEX_EXPIRE_SECONDS,
  DOCUMENT_INDEX_QUEUE,
} from "./document-index-queue";

export interface DocumentIndexPayload {
  userId: string;
  documentId: string;
  enqueuedAt?: string;
  /**
   * v1.39.2 (#1038) — set for an upload that asked for `aiRead=defer`: index
   * from the local text layer only and stage no lab facts. Absent on every
   * job enqueued before the field existed, which keeps their behaviour.
   */
  localOnly?: boolean;
}

/**
 * Index one document (owner-scoped, provider-first/local-fallback). Never
 * throws for an expected outcome — the decision tree returns a tagged result —
 * so pg-boss does not retry a document that simply has no indexable text.
 */
export async function runDocumentIndex(
  payload: DocumentIndexPayload,
  options: {
    deadlineAt?: number;
    now?: () => number;
    /** pg-boss's abort signal: a long OCR read stops between pages. */
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const { userId, documentId } = payload;
  if (!userId || !documentId) return;
  const localOnly = payload.localOnly === true;
  const outcome = await withPdfWork({ owner: userId, lane: "background" }, () =>
    indexDocumentContent(userId, documentId, {
      localOnly,
      signal: options.signal,
    }),
  );
  annotate({
    action: { name: "documents.autoIndex.run" },
    meta: outcome.indexed
      ? { documentId, indexed: true, source: outcome.source }
      : { documentId, indexed: false, reason: outcome.reason },
  });

  // Once the document is indexed, auto-stage lab facts for a lab-looking
  // document (both modules on + the auto-AI-read consent gate). Facts land
  // PENDING for the existing human review; nothing is committed. Fully gated +
  // idempotent inside; a failure here must never fail the index job, so it is
  // swallowed to a no-op (the manual extract button remains the fallback).
  // A deferred import stages nothing: lab staging is an AI read, and the
  // person asked for those to wait.
  if (outcome.indexed && !localOnly) {
    const schedule =
      options.deadlineAt === undefined
        ? undefined
        : await stagingSchedule(userId, options.deadlineAt, options.now);
    const staging = await withPdfWork(
      { owner: userId, lane: "background" },
      () => maybeAutoStageLabFacts(userId, documentId, { schedule }),
    ).catch(caughtAs("documents.auto_index.lab_staging_failed"));
    // The AI could not stage (none may run, its budget is spent, the read
    // failed): the values are read by rule instead. Reading data never
    // depends on an AI setting.
    if (needsStagingWithoutModel(staging)) {
      await maybeStageLabValuesWithoutModel(userId, documentId).catch(
        caughtAs("documents.auto_index.local_lab_values_failed"),
      );
    }
  }
}

/**
 * Whether the AI staging's answer leaves the lab values to the reading by
 * rule: it was not allowed to run, ran out of budget, failed, or threw. A
 * document it staged, one that was already handled or held back, and one
 * that is no lab report are left as they are.
 */
export function needsStagingWithoutModel(
  staging: AutoStageOutcome | void,
): boolean {
  if (!staging) return true;
  if (staging.staged) return false;
  return (
    staging.reason === "not-eligible" ||
    staging.reason === "budget" ||
    staging.reason === "extract-failed"
  );
}

/**
 * The lab staging's reads, planned against the job's deadline. One call of a
 * read may take the person's timeout twice (the call and the one repeat a
 * thinking model gets), so that is the unit the deadline is divided by.
 * There is no run row to move: the deadline is the job's own, fixed.
 */
export async function stagingSchedule(
  userId: string,
  deadlineAt: number,
  now: () => number = Date.now,
): Promise<OcrSchedule> {
  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { aiResponseTimeoutSeconds: true },
  });
  const perCallMs =
    ocrReadCallMs(owner?.aiResponseTimeoutSeconds ?? null) * STATUS_MODEL_CALLS;
  return {
    maxModelCalls: () => Math.floor((deadlineAt - now()) / perCallMs),
    arm: async () => {},
  };
}

/**
 * Enqueue a per-document index job. Coalesced by `singletonKey` per document so
 * a duplicate/idempotent re-upload cannot pile up parallel runs. Fire-and-
 * forget — a missing boss (worker not up) is a no-op, and a `boss.send` failure
 * (a transient DB hiccup) is swallowed to a no-op too, so enqueue can NEVER fail
 * an already-stored upload. Indexing is a background nicety; the stored document
 * is the contract. A dropped enqueue is recoverable via the corpus backfill.
 */
export async function enqueueDocumentIndex(
  userId: string,
  documentId: string,
  options: { localOnly?: boolean } = {},
): Promise<{ enqueued: boolean }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: false };
  const payload: DocumentIndexPayload = {
    userId,
    documentId,
    enqueuedAt: new Date().toISOString(),
    ...(options.localOnly ? { localOnly: true } : {}),
  };
  try {
    const jobId = await boss.send(DOCUMENT_INDEX_QUEUE, payload, {
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      singletonKey: `document-index|${documentId}`,
      expireInSeconds: DOCUMENT_INDEX_EXPIRE_SECONDS,
    });
    return { enqueued: Boolean(jobId) };
  } catch (err) {
    annotate({
      action: { name: "documents.autoIndex.enqueueFailed" },
      meta: { documentId, reason: err instanceof Error ? err.name : "unknown" },
    });
    logCaught("documents.auto_index.enqueue_failed", err);
    return { enqueued: false };
  }
}
