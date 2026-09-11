/**
 * v1.27.22 (Document vault P2) — content-search index backfill.
 *
 * Indexes a user's EXISTING stored documents for content search: for each live
 * document that has no `DocumentContentIndex` yet, run one provider vision
 * transcription and upsert the encrypted-text + blind-token index. The run
 * also sweeps rows whose stored `tokenizerVersion` trails
 * `CONTENT_TOKENIZER_VERSION` and re-tokenises them locally from the
 * decrypted text (see `retokeniseStaleRows`) — the consumer that makes a
 * tokeniser bump actually re-index the corpus. On-demand
 * only (fired by the "index all documents" action) — NOT a boot/cron pass:
 * indexing egresses to a provider under the user's key + budget, so it must be
 * a deliberate, consented act, exactly like the per-document index route.
 *
 * Consent: gated on the document-egress consent (`assertDocumentEgressConsent`),
 * the same gate the extract / index routes use — any external provider needs an
 * active receipt; a local pick stays ungated. There is no separate per-user
 * toggle (maintainer decision, 2026-07-07).
 *
 * Bounded + resumable: an id-cursor forward walk over the not-yet-indexed set,
 * capped at `MAX_DOCS_PER_RUN` provider calls per job and stopped the moment the
 * daily AI budget is reached. Only vision-indexable MIME types (images + PDFs —
 * `prepareVisionInput` passes a PDF natively when the provider reads PDFs and
 * rasterises it to page images otherwise) are candidates, so the walk
 * converges — an un-indexable file never re-queues work. A re-run picks up
 * where budget / the cap left off because already-indexed documents drop out
 * of the set.
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
import { prisma } from "@/lib/db";
import {
  loadOwnedDocument,
  prepareVisionInput,
} from "@/lib/documents/ai-route-support";
import {
  CONTENT_TOKENIZER_VERSION,
  decryptIndexText,
  tokeniseAndHash,
  upsertContentIndex,
} from "@/lib/documents/content-index";
import { transcribeDocument } from "@/lib/documents/describe";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import { annotate } from "@/lib/logging/context";

export const CONTENT_INDEX_BACKFILL_QUEUE = "document-content-index-backfill";

/** Serial concurrency — provider calls, kept off the request pool. */
export const CONTENT_INDEX_BACKFILL_CONCURRENCY = 1;

/** Discovery page size (id-only; blobs are loaded one at a time). */
const PAGE_SIZE = 50;

/** Max documents one job indexes before yielding (bounds spend + runtime). */
const MAX_DOCS_PER_RUN = 200;

/** Image MIME types the vision path can always index. */
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;

export interface ContentIndexBackfillPayload {
  userId: string;
  enqueuedAt?: string;
}

export interface ContentIndexBackfillSummary {
  indexed: number;
  /**
   * Rows whose stored `tokenizerVersion` trailed `CONTENT_TOKENIZER_VERSION`
   * and were re-tokenised locally from the decrypted `textEncrypted` — no
   * provider call, no consent, no budget involved.
   */
  retokenised: number;
  /**
   * Documents visited but not indexable this run (gone by load time,
   * undecryptable, or a PDF no rasteriser could render). Refunded, never
   * billed, and left un-indexed for a later run.
   */
  skipped: number;
  /**
   * Documents whose provider call failed, plus stale-tokenizer rows whose
   * local re-tokenise failed (undecryptable text). Refunded where a
   * reservation existed; a later run retries.
   */
  failed: number;
  reason: "ok" | "no-provider" | "no-consent" | "budget-reached";
}

/**
 * The consumer of `DocumentContentIndex.tokenizerVersion`: sweep this user's
 * rows written under an older tokeniser and re-tokenise them from the
 * decrypted `textEncrypted` — the same local path the key-rotation script
 * takes (`scripts/rotate-encryption-key.ts`), so bumping
 * `CONTENT_TOKENIZER_VERSION` actually re-indexes the corpus instead of
 * stranding every stored row on the old rules. Purely local (decrypt + HMAC),
 * so it runs before — and regardless of — the provider/consent/budget gates.
 * Keyset pagination on `id` because a re-tokenised row drops out of the
 * filtered set mid-walk, which would break cursor-based paging.
 */
async function retokeniseStaleRows(
  userId: string,
): Promise<{ retokenised: number; failed: number }> {
  let retokenised = 0;
  let failed = 0;
  let afterId: string | null = null;
  for (;;) {
    const rows: { id: string; textEncrypted: Uint8Array }[] =
      await prisma.documentContentIndex.findMany({
        where: {
          userId,
          tokenizerVersion: { not: CONTENT_TOKENIZER_VERSION },
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        select: { id: true, textEncrypted: true },
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
      });
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        const plaintext = decryptIndexText(row.textEncrypted);
        const searchTokens = tokeniseAndHash(plaintext);
        await prisma.documentContentIndex.update({
          where: { id: row.id },
          data: { searchTokens, tokenizerVersion: CONTENT_TOKENIZER_VERSION },
        });
        retokenised += 1;
      } catch {
        // Fail-closed decrypt or a write miss — leave the row on its old
        // version (it stays in the candidate set for the next run) and
        // keep walking; one bad row must not abort the sweep.
        failed += 1;
      }
    }
    afterId = rows[rows.length - 1]!.id;
    if (rows.length < PAGE_SIZE) break;
  }
  return { retokenised, failed };
}

/**
 * Index one user's not-yet-indexed documents. Idempotent + resumable: an
 * already-indexed document drops out of the candidate set, and the run stops at
 * the per-run cap or when the budget is reached.
 */
export async function runContentIndexBackfillForUser(
  userId: string,
): Promise<ContentIndexBackfillSummary> {
  // Stale-tokeniser rows first: local work that owes nothing to the
  // provider, consent, or budget gates below, so a user without a usable
  // provider still gets their existing index moved to the current rules.
  const stale = await retokeniseStaleRows(userId);

  const { pick } = await resolveDocumentVisionProvider(userId);
  if (!pick)
    return {
      indexed: 0,
      retokenised: stale.retokenised,
      skipped: 0,
      failed: stale.failed,
      reason: "no-provider",
    };
  try {
    await assertDocumentEgressConsent({
      userId,
      providerType: pick.providerType,
      surface: "insights",
    });
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      return {
        indexed: 0,
        retokenised: stale.retokenised,
        skipped: 0,
        failed: stale.failed,
        reason: "no-consent",
      };
    }
    throw err;
  }

  // PDFs are always candidates: `prepareVisionInput` passes them natively
  // when the provider reads PDFs and rasterises them to page images
  // otherwise — the same path the per-document index route takes. The
  // prefilter here only trims the walk; it must never be stricter than
  // that per-document authority, or an image-input provider silently
  // leaves every PDF out of "index all documents".
  const candidateMimes = [...IMAGE_MIMES, "application/pdf"];

  // v1.38.19 (Wave E) — a background surface: half the day's ceiling.
  const dailyCap = resolveDailyCapFor("job", [
    { providerType: pick.entry.providerType },
  ]);
  let indexed = 0;
  let skipped = 0;
  let failed = stale.failed;
  let reason: ContentIndexBackfillSummary["reason"] = "ok";
  let cursor: string | null = null;

  outer: for (;;) {
    if (indexed >= MAX_DOCS_PER_RUN) break;
    const rows: { id: string }[] = await prisma.inboundDocument.findMany({
      where: {
        userId,
        deletedAt: null,
        mimeType: { in: candidateMimes },
        contentIndex: { is: null },
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    for (const { id } of rows) {
      if (indexed >= MAX_DOCS_PER_RUN) break outer;

      const dateKey = buildDateKey();
      const reservation = await reserveBudget(
        userId,
        AI_BUDGETS.documentTranscribe.maxTokens,
        dateKey,
        dailyCap,
        resolveCostOwner([{ providerType: pick.entry.providerType }]),
        "job",
      );
      if (!reservation.allowed) {
        reason = "budget-reached";
        break outer;
      }

      const document = await loadOwnedDocument(userId, id);
      if (!document) {
        await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
          servedBy: null,
          reservedOwner: reservation.owner,
        });
        skipped += 1;
        continue;
      }
      const vision = await prepareVisionInput(document, pick.pdfSupported);
      if (!vision.ok) {
        // Not vision-indexable after all (undecryptable, unreadable bytes,
        // or a PDF the rasteriser could not render) — refund and move on so
        // the walk keeps converging. Counted as skipped, not failed: no
        // provider call happened.
        await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
          servedBy: null,
          reservedOwner: reservation.owner,
        });
        skipped += 1;
        continue;
      }

      try {
        const { text } = await transcribeDocument({
          provider: pick.entry.instance,
          providerType: pick.providerType,
          images: vision.images,
          documents: vision.documents,
        });
        await reconcileSpend(
          userId,
          reservation.reserved,
          reservation.reserved,
          dateKey,
          0,
          {
            servedBy: pick.entry.providerType,
            reservedOwner: reservation.owner,
          },
        );
        await upsertContentIndex({
          userId,
          documentId: document.id,
          text,
          source: "vision",
          providerType: pick.providerType,
        });
        indexed += 1;
      } catch {
        // A provider miss on one document must not abort the batch — refund and
        // leave it un-indexed (a later run retries it).
        await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
          servedBy: null,
          reservedOwner: reservation.owner,
        });
        failed += 1;
      }
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < PAGE_SIZE) break;
  }

  annotate({
    action: { name: "documents.contentIndex.backfill" },
    meta: { indexed, retokenised: stale.retokenised, skipped, failed, reason },
  });
  return { indexed, retokenised: stale.retokenised, skipped, failed, reason };
}

/**
 * Enqueue a per-user content-index backfill. Coalesced by `singletonKey` so a
 * user cannot pile up parallel runs; returns whether a job was created.
 */
export async function enqueueContentIndexBackfill(
  userId: string,
): Promise<{ enqueued: boolean }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: false };
  const payload: ContentIndexBackfillPayload = {
    userId,
    enqueuedAt: new Date().toISOString(),
  };
  const jobId = await boss.send(CONTENT_INDEX_BACKFILL_QUEUE, payload, {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    singletonKey: `document-content-index-backfill|${userId}`,
  });
  return { enqueued: Boolean(jobId) };
}
