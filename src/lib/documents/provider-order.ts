/**
 * Document-class AI provider resolution (governance fix, oauth-investigation
 * SYNTHESIS §1).
 *
 * A three-audit investigation found that for uploaded medical DOCUMENTS the
 * app-wide provider chain is the wrong default: `codex` (the
 * ChatGPT-subscription OAuth backend) sits at chain priority 1, ahead of BYOK
 * and local, and OpenAI's consumer policy allows training on that content by
 * default. HealthLog is privacy-first, so a scanned discharge letter must NOT
 * default to the train-by-default backend.
 *
 * The fix is scoped to the DOCUMENT class only — Coach / insights keep the
 * cost-first app-wide order untouched. This module reprioritises the resolved
 * provider chain for the vault's AI surfaces (suggest / summary / extract /
 * index / reindex / backfill):
 *
 *   local (no egress) → BYOK no-train API (openai / anthropic) → operator's
 *   admin key → codex (ChatGPT-subscription OAuth) LAST, as an explicit,
 *   consented opt-in.
 *
 * The reorder only decides WHICH configured provider is preferred; it never
 * invents a provider. The per-egress vendor-blind UI notice sits on top of
 * this order — the reorder keeps codex from being the silent default.
 *
 * The pick is also the document class's wire: every read of a stored document
 * resolves its provider here, the vault routes and the background jobs alike,
 * so this is where the `documentAi` capability is asked again, about the
 * provider actually picked, immediately before anything is sent. A switch the
 * operator turned off after a job was enqueued stops the job here, and an
 * external pick without an extraction consent receipt never reaches its
 * provider. The document class is the `documentAi` capability; there is no
 * other key a caller could pass, so the check is built in rather than taken
 * as an argument.
 */
import { isExternalDocumentEgress } from "@/lib/ai/consent-guard";
import { aiEgressRefusal } from "@/lib/ai/capabilities/egress";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import { PICK_DECIDED_REASONS } from "@/lib/ai/capabilities/types";
import {
  AiUnavailableError,
  type NoProviderRefusal,
} from "@/lib/ai/capabilities/refusal";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import { documentProviderRank } from "@/lib/documents/provider-rank";
import { RASTERIZATION_AVAILABLE } from "@/lib/documents/rasterize-pdf";
import {
  resolveTextProvider,
  resolveVisionProvider,
  type ChainReorder,
  type VisionProviderPick,
} from "@/lib/labs/ocr-capability";
import type {
  DocumentAiCapabilityDto,
  DocumentEgressClass,
} from "@/lib/validations/inbound-documents";

/**
 * How the vault refuses a read with no provider that can serve it. The code
 * predates the capability envelope and a client already branches on it.
 */
export const DOCUMENT_NO_PROVIDER: NoProviderRefusal = {
  errorCode: "documents.inbound.providerUnsupported",
  status: 422,
};

/**
 * Reorder a resolved chain for the document class: stable sort by
 * `documentProviderRank`, so within a rank tier the user's own chain order is
 * preserved (a stable sort keeps insertion order on ties). Pure — returns a new
 * array, never mutates the input.
 */
export const reorderChainForDocumentClass: ChainReorder = (chain) => {
  return [...chain].sort(
    (a, b) =>
      documentProviderRank(a.providerType) -
      documentProviderRank(b.providerType),
  );
};

/**
 * A document pick after the wire re-check. `pick` is null when nothing can
 * serve the read OR when the capability refused it; `withheld` says which.
 * A job reads `pick` and skips; a route throws `withheld` so the person sees
 * the real reason.
 */
export type DocumentProviderPick<T> = T & {
  withheld: AiUnavailableError | null;
};

async function atTheWire<T extends { pick: { providerType: string } | null }>(
  userId: string,
  resolved: T,
): Promise<DocumentProviderPick<T>> {
  if (!resolved.pick) return { ...resolved, withheld: null };
  const withheld = await aiEgressRefusal("documentAi", userId, [
    resolved.pick.providerType,
  ]);
  return withheld
    ? { ...resolved, pick: null, withheld }
    : { ...resolved, withheld: null };
}

/**
 * Resolve the vision provider for a DOCUMENT read — local-first, codex last.
 * Same shape as `resolveVisionProvider`; the returned `chain` is already in
 * document order and the `pick` is the first vision-capable entry in it, or
 * null when `documentAi` refuses the wire.
 */
export async function resolveDocumentVisionProvider(
  userId: string,
): Promise<DocumentProviderPick<VisionProviderPick>> {
  return atTheWire(
    userId,
    await resolveVisionProvider(userId, "documentAi", {
      reorder: reorderChainForDocumentClass,
    }),
  );
}

/**
 * Resolve the text-mode structuring provider for a DOCUMENT — local-first,
 * codex last. The `pick` is the first entry of the reordered chain, or null
 * when `documentAi` refuses the wire.
 */
export async function resolveDocumentTextProvider(userId: string): Promise<
  DocumentProviderPick<{
    chain: ProviderChainResolved[];
    pick: { entry: ProviderChainResolved; providerType: string } | null;
  }>
> {
  return atTheWire(
    userId,
    await resolveTextProvider(userId, "documentAi", {
      reorder: reorderChainForDocumentClass,
    }),
  );
}

function required<T>(result: {
  pick: T | null;
  withheld: AiUnavailableError | null;
}): T {
  if (result.withheld) throw result.withheld;
  if (!result.pick) {
    throw new AiUnavailableError(
      "documentAi",
      "no_provider",
      null,
      DOCUMENT_NO_PROVIDER,
    );
  }
  return result.pick;
}

/**
 * The route form of {@link resolveDocumentVisionProvider}: the pick, or the
 * refusal thrown for `apiHandler` to render (`documents.inbound.providerUnsupported`
 * when nothing can read the document, the capability envelope otherwise).
 */
export async function requireDocumentVisionProvider(userId: string) {
  return required(await resolveDocumentVisionProvider(userId));
}

/** The route form of {@link resolveDocumentTextProvider}. */
export async function requireDocumentTextProvider(userId: string) {
  return required(await resolveDocumentTextProvider(userId));
}

/**
 * Classify a picked provider's egress for the per-egress UI notice. Vendor-blind
 * by design — "local" (stays on the machine) vs "external" (a third-party AI
 * service); the copy never names a vendor.
 */
export function documentEgressClass(providerType: string): DocumentEgressClass {
  return isExternalDocumentEgress(providerType) ? "external" : "local";
}

/**
 * Resolve the document AI capability for the vault UI. The `mode` /
 * `pdfSupported` / `egress` reflect the DOCUMENT provider order (local-first),
 * so the affordance the UI offers matches exactly what the document routes do.
 *
 * `ai` is the `documentAi` capability for the request's record. A read the
 * operator, the record's modules or the sharing grant close is not offered
 * (`available: false`, no mode). A missing consent receipt keeps the read
 * offered: the read itself is where the person is asked for the receipt, and
 * hiding the button would leave them no way to give it.
 */
export async function resolveDocumentAiCapability(
  userId: string,
): Promise<DocumentAiCapabilityDto> {
  const [{ chain, pick, localOcrEnabled }, ai] = await Promise.all([
    resolveVisionProvider(userId, "documentAi", {
      reorder: reorderChainForDocumentClass,
    }),
    getAiCapability("documentAi"),
  ]);

  if (ai.reason !== null && !PICK_DECIDED_REASONS.has(ai.reason)) {
    return {
      available: false,
      mode: null,
      reason: null,
      pdfSupported: false,
      egress: null,
      ai,
    };
  }

  // A vision-capable provider is available — the read runs directly over the
  // stored original. Egress follows the picked provider. PDFs are readable
  // whenever the picked provider natively supports them (Anthropic) OR the
  // server-side rasterizer is available (every other vision provider reads a
  // PDF via rasterized page images), so the UI offers a PDF read on codex too.
  if (pick) {
    return {
      available: true,
      mode: "vision",
      reason: null,
      pdfSupported: pick.pdfSupported || RASTERIZATION_AVAILABLE,
      egress: documentEgressClass(pick.providerType),
      ai,
    };
  }

  // Nothing configured at all — no read, regardless of the local-OCR toggle.
  if (chain.length === 0) {
    return {
      available: false,
      mode: null,
      reason: "no-provider",
      pdfSupported: false,
      egress: null,
      ai,
    };
  }

  // A text-only provider is configured. Local OCR runs in the browser and only
  // the extracted text is structured by the first provider in document order.
  if (localOcrEnabled) {
    return {
      available: true,
      mode: "text",
      reason: null,
      pdfSupported: false,
      egress: documentEgressClass(chain[0]!.providerType),
      ai,
    };
  }

  // A text-only provider is configured but local OCR is not enabled.
  return {
    available: false,
    mode: null,
    reason: "enable-local-ocr",
    pdfSupported: false,
    egress: null,
    ai,
  };
}
