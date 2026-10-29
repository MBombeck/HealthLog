/**
 * v1.18.9 — resolve whether a user's configured AI provider can read images,
 * and (for the extract route) pick the first vision-capable provider instance.
 *
 * Capability is a function of (providerType, model). The user's `aiModel`
 * applies to a per-user provider entry; the operator's `adminAiModel` applies
 * to the `admin-openai` fallback entry. We resolve the chain instances via
 * `resolveProviderChain` (so credentials + Codex-token refresh are handled in
 * one place) and pair each surviving entry with the model that drives its
 * vision allowlist.
 */
import { aiEgressRefusal } from "@/lib/ai/capabilities/egress";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import {
  AiUnavailableError,
  type NoProviderRefusal,
} from "@/lib/ai/capabilities/refusal";
import { PICK_DECIDED_REASONS } from "@/lib/ai/capabilities/types";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import { chainEntryReadsImages } from "@/lib/ai/codex-slug-chain";
import { RASTERIZATION_AVAILABLE } from "@/lib/documents/rasterize-pdf";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  supportsPdfForProvider,
  type VisionProviderType,
} from "@/lib/ai/vision-capability";
import type { OcrCapabilityDto } from "@/lib/validations/labs-ocr";

interface ModelContext {
  /** The user's selected model (per-user provider entries). */
  userModel: string | null;
  /** The operator's admin-key model (the `admin-openai` chain entry). */
  adminModel: string | null;
}

/** Whether a chain entry's model can read an image. */
function entryReadsImages(
  providerType: ProviderChainResolved["providerType"],
  userId: string,
  ctx: ModelContext,
): boolean {
  // Codex picks its model at request time from the sign-in's working slug
  // and the models its account is offered, NOT from the user's `aiModel`.
  // Each Codex path asks its own sign-in: the person's connection, or the
  // operator-shared central one (`admin-codex`).
  const model =
    providerType === "admin-openai" ? ctx.adminModel : ctx.userModel;
  return chainEntryReadsImages(providerType, userId, model);
}

/**
 * A transform applied to the resolved provider chain before the vision/text
 * pick is made. Identity by default (labs behaviour unchanged); the document
 * class passes a reorder that demotes external/train-by-default providers below
 * local (see `@/lib/documents/provider-order`).
 */
export type ChainReorder = (
  chain: ProviderChainResolved[],
) => ProviderChainResolved[];

export interface ResolveProviderOptions {
  /** Reorder the resolved chain before picking. Defaults to identity. */
  reorder?: ChainReorder;
}

/** A vision-capable provider pick: its instance, logical tag, and model. */
export interface VisionProviderPick {
  /** The full resolved chain (for `assertConsentForChain`). */
  chain: ProviderChainResolved[];
  /** The first vision-capable entry, or null when none can read images. */
  pick: {
    entry: ProviderChainResolved;
    providerType: VisionProviderType;
    pdfSupported: boolean;
  } | null;
  /** Whether the user opted into local (in-browser) OCR for text-only providers. */
  localOcrEnabled: boolean;
}

/**
 * Resolve the user's provider chain and find the first entry that can read
 * images. Returns the whole chain (the consent gate needs it) plus the chosen
 * vision entry (or null). Mirrors the Coach's chain-then-legacy fallback so a
 * user served only by the operator's admin key is still covered.
 */
export async function resolveVisionProvider(
  userId: string,
  options?: ResolveProviderOptions,
): Promise<VisionProviderPick> {
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { aiModel: true, labsLocalOcrEnabled: true },
  });
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { adminAiModel: true },
  });

  const localOcrEnabled = userRow?.labsLocalOcrEnabled ?? false;

  // The OCR path always uses the main configured provider chain — the user's
  // model drives the vision allowlist.
  const ctx: ModelContext = {
    userModel: userRow?.aiModel ?? null,
    adminModel: settings?.adminAiModel ?? null,
  };

  const resolvedChain = await resolveProviderChain(userId);
  if (resolvedChain.length === 0) {
    // Mirror the Coach: fall back to the legacy single-provider resolution and
    // tag it as the admin-managed entry the consent gate recognises.
    const legacy = await resolveProvider(userId);
    if (legacy.type !== "none") {
      resolvedChain.push({ providerType: "admin-openai", instance: legacy });
    }
  }

  // Apply the caller's reorder (document class demotes external providers below
  // local) before picking; labs passes no reorder → identity.
  const chain = options?.reorder
    ? options.reorder(resolvedChain)
    : resolvedChain;

  for (const entry of chain) {
    const providerType = entry.providerType as VisionProviderType;
    if (entryReadsImages(entry.providerType, userId, ctx)) {
      return {
        chain,
        localOcrEnabled,
        pick: {
          entry,
          providerType,
          pdfSupported: supportsPdfForProvider(providerType),
        },
      };
    }
  }

  return { chain, localOcrEnabled, pick: null };
}

/**
 * Resolve the provider chain for a TEXT-mode (local-OCR) extract. There is no
 * vision requirement here — ANY configured provider can structure OCR'd text —
 * so this returns the whole chain plus the first entry to drive the structuring
 * call. Returns `null` when nothing is configured.
 */
export async function resolveTextProvider(
  userId: string,
  options?: ResolveProviderOptions,
): Promise<{
  chain: ProviderChainResolved[];
  pick: { entry: ProviderChainResolved; providerType: string } | null;
}> {
  // The text-mode structuring pass needs no vision — any configured provider in
  // the main chain can structure the OCR'd text.
  const resolvedChain = await resolveProviderChain(userId);
  if (resolvedChain.length === 0) {
    const legacy = await resolveProvider(userId);
    if (legacy.type !== "none") {
      resolvedChain.push({ providerType: "admin-openai", instance: legacy });
    }
  }
  const chain = options?.reorder
    ? options.reorder(resolvedChain)
    : resolvedChain;
  const entry = chain[0];
  return {
    chain,
    pick: entry ? { entry, providerType: entry.providerType } : null,
  };
}

/**
 * How a lab scan refuses with no provider that can serve it. The code predates
 * the capability envelope and a client already branches on it.
 */
export const LABS_OCR_NO_PROVIDER: NoProviderRefusal = {
  errorCode: "labs.ocr.providerUnsupported",
  status: 422,
};

/**
 * The labs scan's wire. Resolve the provider for one scan mode and ask the
 * `labsOcr` capability again about exactly that provider, immediately before
 * the report is sent: the operator's switch, the labs module, the sharing
 * grant, and a document-class consent receipt for any pick that leaves the
 * machine (a lab report is a document). Throws the refusal for `apiHandler`
 * to render; a missing provider keeps its `labs.ocr.providerUnsupported` code.
 *
 * Vision mode picks the first vision-capable entry in chain order; text mode
 * (the person's in-browser OCR) takes the chain head, which is why the pick,
 * not the published capability, answers the consent question.
 */
export async function requireLabsOcrProvider(
  userId: string,
  mode: "vision",
): Promise<NonNullable<VisionProviderPick["pick"]>>;
export async function requireLabsOcrProvider(
  userId: string,
  mode: "text",
): Promise<{ entry: ProviderChainResolved; providerType: string }>;
export async function requireLabsOcrProvider(
  userId: string,
  mode: "vision" | "text",
) {
  const { chain, pick } =
    mode === "vision"
      ? await resolveVisionProvider(userId)
      : await resolveTextProvider(userId);
  if (!pick) {
    annotate({
      action: { name: "labs.ocr.providerUnsupported" },
      meta: {
        chainLength: chain.length,
        ...(mode === "text" ? { mode } : {}),
      },
    });
    throw new AiUnavailableError(
      "labsOcr",
      "no_provider",
      null,
      LABS_OCR_NO_PROVIDER,
    );
  }
  const refusal = await aiEgressRefusal("labsOcr", userId, [pick.providerType]);
  if (refusal) throw refusal;
  return pick;
}

/**
 * The cheap capability DTO for the probe endpoint: whether scanning is
 * available + why not + whether PDFs are accepted. Built from the same
 * resolution the extract route uses, so the UI never shows an entry the
 * extract route would 422.
 *
 * `ai` is the `labsOcr` capability for the request's record. A scan the
 * operator, the labs module or the sharing grant close is not offered
 * (`available: false`, no mode). A missing consent receipt keeps the scan
 * offered: the scan is where the person is asked for the receipt.
 */
export async function resolveOcrCapability(
  userId: string,
): Promise<OcrCapabilityDto> {
  const [{ chain, pick, localOcrEnabled }, ai] = await Promise.all([
    resolveVisionProvider(userId),
    getAiCapability("labsOcr"),
  ]);

  if (ai.reason !== null && !PICK_DECIDED_REASONS.has(ai.reason)) {
    return {
      available: false,
      mode: null,
      reason: null,
      pdfSupported: false,
      ai,
    };
  }

  // Prefer the native vision path whenever it is available — it is more
  // accurate and the client does not download the OCR WASM. PDFs are readable
  // whenever the picked provider natively supports them (Anthropic) OR the
  // server-side rasterizer is available (every other vision provider reads a
  // PDF via rasterized page images), so the scan-a-PDF affordance shows for a
  // codex / OAuth provider too. The extract route keeps the native-block vs
  // raster decision on `pick.pdfSupported` itself.
  if (pick) {
    return {
      available: true,
      mode: "vision",
      reason: null,
      pdfSupported: pick.pdfSupported || RASTERIZATION_AVAILABLE,
      ai,
    };
  }

  // No vision pick. Nothing configured at all → no-provider, regardless of the
  // toggle (there is no provider to structure the OCR text).
  if (chain.length === 0) {
    return {
      available: false,
      mode: null,
      reason: "no-provider",
      pdfSupported: false,
      ai,
    };
  }

  // A provider IS configured but it can't read images. Local OCR is the
  // text-only fallback: in-browser OCR → text → the configured provider. It is
  // available only when the user opted in.
  if (localOcrEnabled) {
    // Text mode is image-only (tesseract.js can't read PDFs).
    return {
      available: true,
      mode: "text",
      reason: null,
      pdfSupported: false,
      ai,
    };
  }

  // A text-only provider is configured but the user has not enabled local OCR —
  // surface the actionable reason so the UI can point at the toggle.
  return {
    available: false,
    mode: null,
    reason: "enable-local-ocr",
    pdfSupported: false,
    ai,
  };
}
