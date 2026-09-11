/**
 * Content-index ONE stored document — the shared, AI-first decision tree behind
 * both the per-document auto-index-on-upload job and the corpus backfill.
 *
 * Provider resolution follows the DOCUMENT order (local-first, codex last —
 * `resolveDocumentVisionProvider`), NOT the cost-first app-wide chain, and the
 * external egress is governed by the per-user `documentsAutoAiRead` opt-in:
 *
 *   1. LOCAL PROVIDER (a self-hosted vision model) — never egresses, so it runs
 *      whenever it is the document-order pick, toggle-independent.
 *   2. EXTERNAL PROVIDER (codex / BYOK openai|anthropic / admin key) — reads a
 *      document off the machine, so the auto-index job only uses it when the
 *      operator opted into `documentsAutoAiRead`. OFF → the job is strictly
 *      local (never egresses on upload, even if an unrelated consent receipt
 *      exists); ON → the document-order external pick reads the original (rich,
 *      handles scanned PDFs + images). Budget-reserved + reconciled exactly like
 *      the interactive index route; owner-scoped throughout.
 *   3. LOCAL TEXT-LAYER (fallback). When no provider is usable — none
 *      configured, the toggle is OFF for an external pick, the provider can't
 *      read this file (e.g. a text-layer PDF on a non-Anthropic account), the
 *      daily budget is reached, or the provider call fails — fall back to
 *      server-side text-layer extraction (`pdf-parse`, no egress, milliseconds).
 *      So content search works at a baseline even with no AI, and every
 *      text-layer PDF is searchable regardless of provider.
 *
 * Both paths write the SAME blind, encrypted index via `upsertContentIndex`
 * (AES-256-GCM text + opaque HMAC token tags) — nothing readable at rest. The
 * function NEVER throws for an expected outcome; it returns a tagged result the
 * caller logs, so a bad document can never abort an upload or a batch.
 */
import { Buffer } from "node:buffer";

import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { isExternalDocumentEgress } from "@/lib/ai/consent-guard";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCap,
  type BudgetCostOwner,
} from "@/lib/ai/coach/budget";
import {
  loadOwnedDocument,
  prepareVisionInput,
  type LoadedDocument,
} from "@/lib/documents/ai-route-support";
import {
  upsertContentIndex,
  type ContentIndexSource,
} from "@/lib/documents/content-index";
import { transcribeDocument } from "@/lib/documents/describe";
import { documentAutoReadEnabled } from "@/lib/documents/document-settings";
import { localExtractText } from "@/lib/documents/local-extract";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import { decryptDocumentContent } from "@/lib/documents/store";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { detectOcrMimeType } from "@/lib/labs/ocr-upload";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";

/**
 * Why one document's index attempt ended without an index. Refs #776 — the
 * provider path's specific failures are terminal reasons now: when the local
 * fallback can only say "no text", the recorded reason is the provider path's
 * more actionable one (a raster failure, a provider error, an empty
 * transcription, or a PDF the picked provider cannot take), so the detail
 * view can say WHY instead of a bare not-indexed.
 */
export type IndexFailureReason =
  | "not-found"
  | "local-empty"
  | "local-unsupported"
  | "decrypt-error"
  | "raster-failed"
  | "provider-error"
  | "pdf-needs-anthropic"
  | "empty-transcription";

/**
 * Outcome of one document's index attempt. A provider that is not usable (none
 * configured, no consent, budget exhausted, cannot read the file, or errored)
 * is never itself a terminal outcome — the tree always falls through to the
 * free local path — but its failure NOTE survives that fall-through (see
 * `IndexFailureReason`).
 */
export type IndexOutcome =
  | { indexed: true; source: ContentIndexSource; tokenCount: number }
  | { indexed: false; reason: IndexFailureReason };

/**
 * Refs #776 — record what became of this attempt on the document row, so a
 * missing index is explainable. `lastIndexAttemptAt` always advances;
 * `lastIndexOutcome` carries the failure reason, or null on success (the
 * `DocumentContentIndex` row itself is the success signal). Called from
 * `indexLoadedDocument` (the choke point the auto job and the corpus backfill
 * share) and from the manual index route. Owner-scoped; never throws — a
 * diagnostic write must not fail the index work it describes.
 */
export async function recordIndexAttempt(
  userId: string,
  documentId: string,
  outcome: IndexOutcome,
): Promise<void> {
  // No row to explain — the document is gone or not the caller's.
  if (!outcome.indexed && outcome.reason === "not-found") return;
  try {
    await prisma.inboundDocument.updateMany({
      where: { id: documentId, userId, deletedAt: null },
      data: {
        lastIndexAttemptAt: new Date(),
        lastIndexOutcome: outcome.indexed ? null : outcome.reason,
      },
    });
  } catch (err) {
    annotate({
      action: { name: "documents.contentIndex.recordFailed" },
      meta: { documentId, reason: err instanceof Error ? err.name : "unknown" },
    });
  }
}

/**
 * A resolved, consent-checked provider context. Resolve ONCE per user and reuse
 * across a batch so the corpus backfill does not re-read the provider chain per
 * document. `usable` is true only when a vision pick exists AND consent passed.
 */
export interface ResolvedIndexProvider {
  chain: ProviderChainResolved[];
  pick: Awaited<ReturnType<typeof resolveDocumentVisionProvider>>["pick"];
  consentOk: boolean;
  dailyCap: number;
  /**
   * v1.38.19 (Wave E) — whose budget `dailyCap` rations. The reservation books
   * `operator_tokens` only for an operator-funded pick, so the cap and the
   * counter it is compared against are resolved from one place.
   */
  costOwner: BudgetCostOwner;
}

/**
 * Resolve the DOCUMENT-order vision provider and decide egress eligibility once.
 * A local pick is always eligible (it never leaves the machine). An external
 * pick is eligible ONLY when the operator opted into `documentsAutoAiRead` — so
 * the auto-index job never silently egresses a freshly uploaded document unless
 * that toggle is ON. A missing pick or an ineligible external pick both yield an
 * unusable context, and the caller falls straight to the local text-layer path.
 */
export async function resolveIndexProvider(
  userId: string,
): Promise<ResolvedIndexProvider> {
  const { chain, pick } = await resolveDocumentVisionProvider(userId);
  let consentOk = false;
  if (pick) {
    if (!isExternalDocumentEgress(pick.providerType)) {
      // A local (self-hosted) vision pick never egresses — always eligible,
      // toggle-independent.
      consentOk = true;
    } else {
      // An external pick reads the document off the machine. The auto-index job
      // only egresses on upload when the operator opted in; the toggle IS the
      // standing consent (the document consent gate short-circuits on it). OFF
      // → local-only, even if an unrelated receipt exists.
      consentOk = await documentAutoReadEnabled(userId);
    }
  }
  const dailyCap =
    pick && consentOk
      ? resolveDailyCap([{ providerType: pick.entry.providerType }])
      : 0;
  // v1.38.19 (Wave E) — the cap and its cost owner are resolved from the SAME
  // pick, so the reservation books the counter the cap is enforced against.
  const costOwner: BudgetCostOwner =
    pick && consentOk
      ? resolveCostOwner([{ providerType: pick.entry.providerType }])
      : "operator";
  return { chain, pick, consentOk, dailyCap, costOwner };
}

/**
 * The provider path's failure note when it falls through to local without a
 * terminal outcome. Refs #776 — the note survives the fall-through: when the
 * local path can only report "no text", the note is the recorded reason.
 */
type ProviderPathNote =
  | "raster-failed"
  | "pdf-needs-anthropic"
  | "provider-error"
  | "empty-transcription";

interface ProviderPathResult {
  outcome: IndexOutcome | null;
  note: ProviderPathNote | null;
}

/**
 * Try the PROVIDER (vision) path for one already-loaded document. Returns a
 * terminal outcome on success / decrypt-error, or `outcome: null` to signal
 * "fall through to local" (no usable provider, budget out, or the provider
 * cannot read this particular file) — with a `note` naming the specific
 * provider-side failure when there was one.
 */
async function tryProviderIndex(
  userId: string,
  document: LoadedDocument,
  provider: ResolvedIndexProvider,
): Promise<ProviderPathResult> {
  const { pick } = provider;
  if (!pick || !provider.consentOk) return { outcome: null, note: null };

  const vision = await prepareVisionInput(document, pick.pdfSupported);
  if (!vision.ok) {
    // A decrypt failure is terminal (local would fail the same way); anything
    // else falls through to the local path — a text-layer PDF on a
    // non-Anthropic account is read locally for free. The PDF-specific
    // failures keep their name as the note.
    if (vision.reason === "decryptFailed") {
      return {
        outcome: { indexed: false, reason: "decrypt-error" },
        note: null,
      };
    }
    if (vision.reason === "rasterFailed") {
      return { outcome: null, note: "raster-failed" };
    }
    if (vision.reason === "pdfNeedsAnthropic") {
      return { outcome: null, note: "pdf-needs-anthropic" };
    }
    return { outcome: null, note: null };
  }

  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.documentTranscribe.maxTokens,
    dateKey,
    provider.dailyCap,
    provider.costOwner,
    "coach",
  );
  // Budget exhausted → fall through to the free local path rather than stall;
  // a text-layer PDF stays searchable even once the AI allowance is spent.
  if (!reservation.allowed) return { outcome: null, note: null };

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
      { servedBy: pick.entry.providerType, reservedOwner: reservation.owner },
    );
    // Refs #776 — the empty-transcription guard: a provider answer with no
    // text must NEVER become a "successful" empty index (it would mark the
    // document indexed while making it unfindable). Fall through to local —
    // a text-layer PDF still lands its text — and keep the note. The spend
    // stays reconciled at the full amount: the provider was called.
    if (text.trim().length === 0) {
      return { outcome: null, note: "empty-transcription" };
    }
    const { tokenCount } = await upsertContentIndex({
      userId,
      documentId: document.id,
      text,
      source: "vision",
      providerType: pick.providerType,
    });
    return {
      outcome: { indexed: true, source: "vision", tokenCount },
      note: null,
    };
  } catch {
    // Refund the reservation and let the caller fall through to local — a
    // transient provider miss must never leave a text-layer PDF unsearchable.
    await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
      servedBy: null,
      reservedOwner: reservation.owner,
    });
    return { outcome: null, note: "provider-error" };
  }
}

/** Try the LOCAL (provider-free) text-layer path for one loaded document. */
async function tryLocalIndex(
  userId: string,
  document: LoadedDocument,
): Promise<IndexOutcome> {
  let buffer: Buffer;
  try {
    buffer = decryptDocumentContent(
      document.contentEncrypted,
      document.contentCodec,
    );
  } catch {
    return { indexed: false, reason: "decrypt-error" };
  }

  // Re-derive the MIME from the bytes (never trust the stored label), matching
  // the provider path's posture; fall back to the stored MIME if unrecognised.
  const mime = detectOcrMimeType(buffer) ?? document.mimeType;
  const result = await localExtractText(buffer, mime);
  if (result.ok) {
    const { tokenCount } = await upsertContentIndex({
      userId,
      documentId: document.id,
      text: result.text,
      source: result.source,
      providerType: null,
    });
    return { indexed: true, source: result.source, tokenCount };
  }
  if (result.reason === "unsupported") {
    return { indexed: false, reason: "local-unsupported" };
  }
  if (result.reason === "error") {
    return { indexed: false, reason: "decrypt-error" };
  }
  return { indexed: false, reason: "local-empty" };
}

/**
 * Index one already-loaded document: provider-first, local-fallback. Reuses a
 * pre-resolved provider context so a batch resolves the chain once.
 *
 * Refs #776 — this is the choke point the auto job and the corpus backfill
 * share, so the attempt record is written HERE: every terminal outcome lands
 * on the row via `recordIndexAttempt`, and a provider-path failure note
 * survives a mute local fallback ("no text" is less actionable than "the
 * provider errored" / "the PDF would not render").
 */
export async function indexLoadedDocument(
  userId: string,
  document: LoadedDocument,
  provider: ResolvedIndexProvider,
): Promise<IndexOutcome> {
  const providerResult = await tryProviderIndex(userId, document, provider);
  let outcome: IndexOutcome;
  if (providerResult.outcome) {
    outcome = providerResult.outcome;
  } else {
    const local = await tryLocalIndex(userId, document);
    if (
      !local.indexed &&
      providerResult.note &&
      (local.reason === "local-empty" || local.reason === "local-unsupported")
    ) {
      // The local path can only say "no text" — the provider path knows why
      // the richer read never happened. Record the actionable reason.
      outcome = { indexed: false, reason: providerResult.note };
    } else {
      outcome = local;
    }
  }
  await recordIndexAttempt(userId, document.id, outcome);
  return outcome;
}

/**
 * Index ONE document by id (owner-scoped): resolve the provider, load the
 * document, then run the provider-first/local-fallback tree. This is the entry
 * point the per-document auto-index-on-upload job calls.
 */
export async function indexDocumentContent(
  userId: string,
  documentId: string,
): Promise<IndexOutcome> {
  const document = await loadOwnedDocument(userId, documentId);
  if (!document) return { indexed: false, reason: "not-found" };
  const provider = await resolveIndexProvider(userId);
  return indexLoadedDocument(userId, document, provider);
}
