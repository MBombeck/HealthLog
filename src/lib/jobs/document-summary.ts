/**
 * Automatic per-document plain-language summary, enqueued the moment a document
 * is stored (`POST /api/documents/inbound`). Fire-and-forget: the upload
 * response never blocks on or fails because of it.
 *
 * Unlike the on-demand summary route (which is transient — nothing persisted),
 * THIS path persists a short (3-4 sentence) descriptive summary ENCRYPTED on the
 * document row, generated ONCE. It runs ONLY when the user's `documentsAutoAiRead`
 * opt-in is ON — that flag is the standing AI-egress consent that removes the
 * per-document friction. With the opt-in OFF the job is a strict no-op and the
 * on-demand route stays the only way to get a summary.
 *
 * The gate order mirrors the vault's other AI paths (module gate is enforced at
 * the enqueueing upload route): load → opt-in ON → provider resolved (DOCUMENT
 * order, local-first) → egress consent re-asserted → budget reserved → generate
 * → persist encrypted. Every skip is graceful (no throw, no retry): an already-
 * summarised document, no configured provider, a spent budget, or a document the
 * picked provider cannot read all resolve to a clean no-op. The summary is
 * DESCRIPTIVE ONLY (interpretation boundary G7, enforced by `runDocumentSummary`).
 *
 * The queue MUST be registered in the maintenance registrar
 * (`src/lib/jobs/reminder/register-maintenance.ts`) so pg-boss provisions it.
 */
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import {
  assertDocumentEgressConsent,
  ConsentRequiredError,
} from "@/lib/ai/consent-guard";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCapFor,
} from "@/lib/ai/coach/budget";
import {
  loadOwnedDocument,
  prepareVisionInput,
} from "@/lib/documents/ai-route-support";
import { runDocumentSummary } from "@/lib/documents/describe";
import type { Locale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { documentAutoReadEnabled } from "@/lib/documents/document-settings";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import { encryptDocumentSummary } from "@/lib/documents/store";
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import type { DocumentSummaryState } from "@/generated/prisma/client";

export const DOCUMENT_SUMMARY_QUEUE = "document-summary";

/**
 * Record what became of this document's summary. Never touches a READY row —
 * a stored summary is the terminal state and a later run must not downgrade it.
 * Owner-scoped like every other write here.
 */
async function markSummaryState(
  userId: string,
  documentId: string,
  state: Exclude<DocumentSummaryState, "READY">,
): Promise<void> {
  await prisma.inboundDocument.updateMany({
    where: {
      id: documentId,
      userId,
      deletedAt: null,
      summaryState: { not: "READY" },
    },
    data: { summaryState: state },
  });
}

/** Serial concurrency — provider calls, kept off the request pool. */
export const DOCUMENT_SUMMARY_CONCURRENCY = 1;

export interface DocumentSummaryPayload {
  userId: string;
  documentId: string;
  enqueuedAt?: string;
}

/**
 * Generate + persist ONE document's background summary (owner-scoped). Never
 * throws for an expected outcome — every gate that fails resolves to a tagged
 * no-op so pg-boss does not retry a document that simply has no provider or a
 * user who opted out. Idempotent: a document that already carries a summary is
 * skipped, and the final write only lands when the column is still null.
 */
export async function runDocumentSummaryJob(
  payload: DocumentSummaryPayload,
): Promise<void> {
  const { userId, documentId } = payload;
  if (!userId || !documentId) return;

  // Idempotency: a document that already has a summary is a cheap no-op (a
  // re-enqueue after a duplicate upload, or a boot backfill overlap).
  const existing = await prisma.inboundDocument.findFirst({
    where: { id: documentId, userId, deletedAt: null },
    select: { id: true, summaryEncrypted: true },
  });
  if (!existing || existing.summaryEncrypted) {
    annotate({
      action: { name: "documents.summary.autoSkipped" },
      meta: { documentId, reason: !existing ? "not-found" : "exists" },
    });
    return;
  }

  // The opt-in IS the trigger: when it is OFF the auto path does nothing (the
  // on-demand route stays the only way to summarise). Fail-closed on a missing
  // row.
  if (!(await documentAutoReadEnabled(userId))) {
    // Opting out is not a failed attempt — but a claimed PENDING may not
    // outlive this run either. PENDING promises the reader "a job will resolve
    // this", and this job IS that resolution: with the opt-in OFF the honest
    // terminal state is NONE (never attempted), which is what the enqueue end
    // of the contract (`enqueueDocumentSummary`) also concludes when the pref
    // is off. The heal is scoped to PENDING only — NONE needs no write,
    // UNAVAILABLE / WITHHELD record real attempts, READY is a stored summary.
    // This also drains any phantom PENDING left by a pref flip mid-flight.
    await prisma.inboundDocument.updateMany({
      where: {
        id: documentId,
        userId,
        deletedAt: null,
        summaryState: "PENDING",
      },
      data: { summaryState: "NONE" },
    });
    annotate({
      action: { name: "documents.summary.autoSkipped" },
      meta: { documentId, reason: "opt-out" },
    });
    return;
  }

  // Resolve the DOCUMENT-order vision provider (local-first, codex last). No
  // vision-capable provider configured → graceful no-op (unlike the index job,
  // there is no local text-layer fallback for a descriptive summary).
  const { pick } = await resolveDocumentVisionProvider(userId);
  if (!pick) {
    await markSummaryState(userId, documentId, "UNAVAILABLE");
    annotate({
      action: { name: "documents.summary.autoSkipped" },
      meta: { documentId, reason: "no-provider" },
    });
    return;
  }

  // Re-assert egress consent for the picked provider. A local pick is ungated;
  // an external pick is authorised by the `documentsAutoAiRead` opt-in checked
  // above (the toggle short-circuits the gate). Belt-and-braces: a consent race
  // (opt-out flipped mid-flight) resolves to a no-op, never an egress.
  try {
    await assertDocumentEgressConsent({
      userId,
      providerType: pick.providerType,
      surface: "insights",
    });
  } catch (err) {
    await markSummaryState(userId, documentId, "UNAVAILABLE");
    annotate({
      action: { name: "documents.summary.autoSkipped" },
      meta: {
        documentId,
        reason:
          err instanceof ConsentRequiredError ? "consent" : "consent-error",
      },
    });
    return;
  }

  const document = await loadOwnedDocument(userId, documentId);
  if (!document) return;

  const vision = await prepareVisionInput(document, pick.pdfSupported);
  if (!vision.ok) {
    // Cannot read this file with the picked provider (decrypt miss, unsupported
    // type, or a PDF needing an Anthropic provider). Graceful no-op.
    await markSummaryState(userId, documentId, "UNAVAILABLE");
    annotate({
      action: { name: "documents.summary.autoSkipped" },
      meta: { documentId, reason: vision.reason },
    });
    return;
  }

  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.documentSummary.maxTokens,
    dateKey,
    // v1.38.19 — a background surface: half the day's ceiling.
    resolveDailyCapFor("job", [{ providerType: pick.entry.providerType }]),
    resolveCostOwner([{ providerType: pick.entry.providerType }]),
    "job",
  );
  // Budget exhausted → skip (no local fallback for a summary).
  if (!reservation.allowed) {
    await markSummaryState(userId, documentId, "UNAVAILABLE");
    annotate({
      action: { name: "documents.summary.autoSkipped" },
      meta: { documentId, reason: "budget" },
    });
    return;
  }

  // The screen picks its pattern banks by locale; this job has no request, so
  // the reader's stored preference is the source, then the operator default,
  // then English — never a silent no-locale path.
  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { locale: true },
  });
  const locale: Locale = await resolveJobLocale(owner?.locale);

  try {
    const { summary, blocked } = await runDocumentSummary({
      provider: pick.entry.instance,
      providerType: pick.providerType,
      images: vision.images,
      documents: vision.documents,
      locale,
    });
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
      0,
      { servedBy: pick.entry.providerType, reservedOwner: reservation.owner },
    );
    // WITHHOLD policy, v1.30.31. The model's prose still never lands — a
    // summary that tripped the outbound screen must never be shown as if it
    // were fine, and that rule is unchanged.
    //
    // What changed is the consequence. Withholding was chosen so a refusal
    // could not stamp the document permanently, but leaving the column null
    // achieved exactly that anyway: the detail view read null as "still
    // generating" and said so forever, with no signal and no way out. The fact
    // of the refusal is now recorded as a STATE (never the text), the view says
    // so honestly, and WITHHELD is not terminal — `markSummaryState` only
    // refuses to overwrite READY, so asking again re-runs the whole gauntlet.
    if (blocked) {
      await markSummaryState(userId, documentId, "WITHHELD");
      annotate({
        action: { name: "documents.summary.outbound_blocked" },
        meta: { documentId, reason: blocked, providerType: pick.providerType },
      });
      return;
    }
    // Persist ENCRYPTED. `updateMany` scoped to `summaryEncrypted: null` so a
    // racing writer (a re-enqueue) never overwrites an existing summary — the
    // first write wins and a second run is a no-op.
    const written = await prisma.inboundDocument.updateMany({
      where: {
        id: documentId,
        userId,
        deletedAt: null,
        summaryEncrypted: null,
      },
      data: {
        summaryEncrypted: encryptDocumentSummary(summary),
        summaryGeneratedAt: new Date(),
        summaryState: "READY",
      },
    });
    annotate({
      action: { name: "documents.summary.autoGenerated" },
      meta: {
        documentId,
        providerType: pick.providerType,
        length: summary.length,
        persisted: written.count > 0,
      },
    });
  } catch {
    // Refund the reservation on a provider miss; the document keeps no summary
    // (the on-demand route remains the manual fallback). Never rethrow — a
    // transient provider error must not retry-loop or fail the queue.
    await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
      servedBy: null,
      reservedOwner: reservation.owner,
    });
    await markSummaryState(userId, documentId, "UNAVAILABLE");
    annotate({
      action: { name: "documents.summary.autoFailed" },
      meta: { documentId, reason: "provider_error" },
    });
  }
}

/**
 * Enqueue a per-document summary job. Coalesced by `singletonKey` per document
 * so a duplicate/idempotent re-upload cannot pile up parallel runs. Fire-and-
 * forget — a missing boss (worker not up) is a no-op, and a `boss.send` failure
 * (a transient DB hiccup) is swallowed to a no-op too, so enqueue can NEVER fail
 * an already-stored upload. The summary is a background nicety; the stored
 * document is the contract.
 */
export async function enqueueDocumentSummary(
  userId: string,
  documentId: string,
): Promise<{ enqueued: boolean }> {
  try {
    // Contract, enqueue end: PENDING may only be claimed for work the job can
    // terminally resolve. With the auto-read opt-in OFF the job's only branch
    // is the opt-out no-op, so enqueueing would mint a job whose sole purpose
    // is to undo this function's own PENDING — don't. No job, no state write;
    // the document stays NONE and the view offers the manual action. The job
    // keeps its own pref check (belt-and-braces for a pref flipped between
    // enqueue and run) and heals PENDING→NONE there — the other end of this
    // contract lives in `runDocumentSummaryJob`'s opt-out branch.
    if (!(await documentAutoReadEnabled(userId))) {
      annotate({
        action: { name: "documents.summary.autoSkipped" },
        meta: { documentId, reason: "opt-out" },
      });
      return { enqueued: false };
    }
    const boss = getGlobalBoss();
    if (!boss) return { enqueued: false };
    const payload: DocumentSummaryPayload = {
      userId,
      documentId,
      enqueuedAt: new Date().toISOString(),
    };
    const jobId = await boss.send(DOCUMENT_SUMMARY_QUEUE, payload, {
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      singletonKey: `document-summary|${documentId}`,
    });
    // PENDING is claimed only once a job genuinely exists. That is the whole
    // point: the detail view may say "being generated" for this state, so
    // nothing may set it speculatively — a dropped send (no boss, DB hiccup)
    // leaves the state alone and the view offers the manual action instead.
    if (jobId) await markSummaryState(userId, documentId, "PENDING");
    return { enqueued: Boolean(jobId) };
  } catch (err) {
    annotate({
      action: { name: "documents.summary.enqueueFailed" },
      meta: { documentId, reason: err instanceof Error ? err.name : "unknown" },
    });
    return { enqueued: false };
  }
}
