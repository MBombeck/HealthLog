/**
 * Catch-up pass for documents stored BEFORE the auto-read opt-in was turned on.
 *
 * The per-document summary job is enqueued at UPLOAD time and no-ops when
 * `documentsAutoAiRead` is OFF. That leaves an obvious hole: a user who uploads
 * their vault first and flips the toggle afterwards gets nothing. Every document
 * they already hold was enqueued while the flag was OFF, the job no-opped, and
 * nothing ever re-enqueues them — so the switch reads as broken. It only ever
 * worked for documents uploaded after the flip.
 *
 * A genuine OFF→ON transition on `PATCH /api/auth/me/documents-auto-ai-read`
 * enqueues one pass of this job, which walks the user's un-summarised documents
 * and enqueues the ordinary per-document summary job for each.
 *
 * What this job does NOT do is grant anything. It only enqueues; every gate
 * still runs inside `runDocumentSummaryJob` — the opt-in is re-read, the egress
 * consent is re-asserted per document, and the daily token budget is reserved
 * and reconciled exactly as on the upload path. Retroactive work is not a reason
 * to skip a consent receipt or a budget ceiling, so it does not.
 *
 * Bounded and idempotent:
 *   - the candidate set is documents with NO summary, so a document drops out
 *     the moment its summary lands and a re-run cannot redo finished work;
 *   - an id-cursor forward walk capped at `MAX_ENQUEUES_PER_RUN` (see the
 *     constant for why that number) keeps one flip from queueing a whole vault;
 *   - the per-user `singletonKey` plus the queue's `short` policy collapses a
 *     second flip while a pass is still queued, and the per-document enqueue
 *     carries its own singleton on top;
 *   - `runDocumentSummaryJob` skips any document that already has a summary, so
 *     even a duplicate that slips past both singletons is a cheap no-op.
 *
 * The queue MUST be registered in the maintenance registrar
 * (`src/lib/jobs/reminder/register-maintenance.ts`) so pg-boss provisions it.
 */
import { documentAutoReadEnabled } from "@/lib/documents/document-settings";
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import { PICK_DECIDED_REASONS } from "@/lib/ai/capabilities/types";
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { enqueueDocumentSummary } from "@/lib/jobs/document-summary";
import { annotate } from "@/lib/logging/context";

export const DOCUMENT_SUMMARY_CATCHUP_QUEUE = "document-summary-catchup";

/** Serial concurrency — cheap discovery + fan-out enqueues. */
export const DOCUMENT_SUMMARY_CATCHUP_CONCURRENCY = 1;

/** Discovery page size (id-only). */
const PAGE_SIZE = 100;

/**
 * Max per-document summary jobs one catch-up pass enqueues.
 *
 * Deliberately far below the thumbnail backfill's cap: a thumbnail is local
 * compute, a summary is a provider call against the user's daily token budget.
 * The budget gate already stops runaway spend (every job past the ceiling
 * no-ops), so this cap is about not dumping an entire vault onto the queue in
 * one go — a large library converges over repeated flips and the ordinary
 * upload path rather than in a single burst. Raising it costs queue depth, not
 * money.
 */
export const MAX_ENQUEUES_PER_RUN = 200;

export interface SummaryCatchUpPayload {
  userId: string;
  enqueuedAt?: string;
}

export interface SummaryCatchUpSummary {
  enqueued: number;
  /** True when the pass stopped at the cap with candidates still outstanding. */
  capped: boolean;
}

/**
 * Enqueue summary jobs for one user's un-summarised documents. Re-reads the
 * opt-in first: a user who flipped the toggle back OFF between the PATCH and
 * this job running gets nothing, which keeps the pass fail-closed against a
 * consent race the same way the per-document job is.
 */
export async function runSummaryCatchUpForUser(
  userId: string,
): Promise<SummaryCatchUpSummary> {
  if (!userId) return { enqueued: 0, capped: false };

  // Fail-closed on the toggle. The PATCH that scheduled this pass is not
  // authority enough — the flag is re-read at run time, exactly as the
  // per-document job does before it egresses anything.
  if (!(await documentAutoReadEnabled(userId))) {
    annotate({
      action: { name: "documents.autoRead.catchUpSkipped" },
      meta: { reason: "opt-out" },
    });
    return { enqueued: 0, capped: false };
  }

  // The `documentAi` capability, once for the whole pass, before any document
  // is listed: a switch or the vault module off means there is nothing the
  // per-document jobs could do. A missing provider or receipt is each job's
  // pick to decide.
  const capability = await aiCapabilityForJob(userId, "documentAi");
  if (
    capability.reason !== null &&
    !PICK_DECIDED_REASONS.has(capability.reason)
  ) {
    annotate({
      action: { name: "documents.autoRead.catchUpSkipped" },
      meta: { reason: capability.reason },
    });
    return { enqueued: 0, capped: false };
  }

  let enqueued = 0;
  let capped = false;
  let cursor: string | null = null;

  for (;;) {
    if (enqueued >= MAX_ENQUEUES_PER_RUN) {
      capped = true;
      break;
    }
    const rows: { id: string }[] = await prisma.inboundDocument.findMany({
      // An import held back from AI reading (`aiRead=defer`) stays held back
      // when the opt-in is flipped on: the person reads those deliberately.
      where: {
        userId,
        deletedAt: null,
        summaryEncrypted: null,
        aiReadDeferred: false,
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    for (const { id } of rows) {
      if (enqueued >= MAX_ENQUEUES_PER_RUN) {
        capped = true;
        break;
      }
      const { enqueued: ok } = await enqueueDocumentSummary(userId, id);
      if (ok) enqueued += 1;
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < PAGE_SIZE) break;
  }

  annotate({
    action: { name: "documents.autoRead.catchUp" },
    meta: { enqueued, capped },
  });
  return { enqueued, capped };
}

/**
 * Enqueue one catch-up pass for a user. Called on a genuine OFF→ON flip of the
 * auto-read opt-in. Coalesced by `singletonKey` per user so flipping the toggle
 * twice cannot queue two passes. Fire-and-forget — a missing boss (worker not
 * up) is a no-op, and a `boss.send` failure is swallowed, so the catch-up can
 * never fail the settings write that scheduled it.
 */
export async function enqueueSummaryCatchUp(
  userId: string,
): Promise<{ enqueued: boolean }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: false };
  const payload: SummaryCatchUpPayload = {
    userId,
    enqueuedAt: new Date().toISOString(),
  };
  try {
    const jobId = await boss.send(DOCUMENT_SUMMARY_CATCHUP_QUEUE, payload, {
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      singletonKey: `document-summary-catchup|${userId}`,
    });
    return { enqueued: Boolean(jobId) };
  } catch (err) {
    annotate({
      action: { name: "documents.autoRead.catchUpEnqueueFailed" },
      meta: { reason: err instanceof Error ? err.name : "unknown" },
    });
    return { enqueued: false };
  }
}
