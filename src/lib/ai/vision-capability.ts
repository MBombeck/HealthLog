/**
 * v1.18.9 — vision-capability resolution for the Lab-OCR ingestion path.
 *
 * The provider abstraction is text-only by default; only some providers +
 * models can read an uploaded photo / PDF. This module is the single source of
 * truth for "can the user's configured provider read images?", so the upload
 * route and the capability probe endpoint agree.
 *
 * Capability is a function of (providerType, model), evaluated against the
 * documented vision allowlists below. It is PURE and presence-only — it never
 * decrypts a key, constructs a client, or probes liveness. A `true` here can
 * still resolve to a dead provider at call time (revoked key, unreachable
 * local host); the route surfaces that as an extract failure.
 */

/**
 * Anthropic vision models. The Messages API `image` + `document` blocks are
 * accepted by the whole Claude 3 family (3 / 3.5 / 3.7) and by every family
 * from Claude 4 upward, Fable included. An older `claude-2*` /
 * `claude-instant*` pin is text-only.
 *
 * The bare `claude-3-opus` / `claude-3-sonnet` / `claude-3-haiku` prefixes are
 * listed explicitly: a self-hoster pinned to e.g. `claude-3-opus-20240229`
 * reads images, but the `claude-3-5` prefix does not match it. From Claude 4
 * on the slug is `claude-<tier>-<major>[-<minor>]`, so a rule on the major
 * version covers `claude-sonnet-4-6`, `claude-opus-5`, `claude-haiku-4-5` and
 * whatever ships next without this list growing per release.
 */
function anthropicSupportsVision(model: string): boolean {
  const m = model.toLowerCase();
  if (
    m.startsWith("claude-3-opus") ||
    m.startsWith("claude-3-sonnet") ||
    m.startsWith("claude-3-haiku") ||
    m.startsWith("claude-3-5") ||
    m.startsWith("claude-3.5") ||
    m.startsWith("claude-3-7") ||
    m.startsWith("claude-3.7")
  ) {
    return true;
  }
  if (m.startsWith("claude-fable-")) return true;
  const tiered = m.match(/^claude-(?:sonnet|opus|haiku)-(\d+)/);
  return tiered !== null && Number(tiered[1]) >= 4;
}

/**
 * OpenAI vision models (also covers the operator's admin key + Codex when it
 * runs an OpenAI model — though Codex is excluded by `providerType`). `gpt-4o`,
 * `gpt-4.1`, `gpt-4-turbo`, and the full `o1` / `o3` / `o4` reasoning models
 * read image content; `gpt-3.5*` and the legacy `gpt-4` (non-turbo) 400 on an
 * image block.
 *
 * The `o*` reasoning line has text-only variants that DO accept the `o*` prefix
 * but reject an image block: `o1-mini` / `o1-preview` and `o3-mini` have no
 * vision input (only the full `o1` / `o3` are multimodal). They must be
 * excluded or a user pinned to one is told OCR works, then the provider 400s at
 * the image block. We treat an `o1` / `o3` / `o4` slug as vision-capable only
 * when it is NOT a `-mini` / `-preview` variant — the conservative default for
 * any unverified narrow slug.
 */
function isVisionReasoningSlug(m: string): boolean {
  if (!(m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4"))) {
    return false;
  }
  return !m.includes("-mini") && !m.includes("-preview");
}

function openaiSupportsVision(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith("gpt-5") ||
    m.startsWith("gpt-4o") ||
    m.startsWith("gpt-4.1") ||
    m.startsWith("gpt-4-turbo") ||
    isVisionReasoningSlug(m)
  );
}

/**
 * Codex (ChatGPT-OAuth) vision models. Image INPUT is reachable over the
 * `codex/responses` endpoint (docs/codex-protocol-spec.md §2b) on a multimodal
 * slug — no API key needed. The whole GPT-5.x line is text+vision, including
 * the `-codex` specialist slugs (gpt-5.x-codex); only the legacy `gpt-4`-class
 * non-multimodal pins are text-only. The GPT-6 line is text+vision too. The
 * slug we test is the codex client's resolved working slug
 * (cached or chain head), so a slug rotation onto a non-vision model degrades
 * to false rather than 400-ing the user at the image block.
 *
 * `gpt-4o` / `o*` are folded in for completeness (a future codex slug could
 * land there), reusing the same multimodal families the OpenAI gate accepts.
 */
function codexSupportsVision(model: string): boolean {
  const m = model.toLowerCase();
  return (
    // GPT-5.x line is multimodal (text + vision) — INCLUDING the `-codex`
    // specialist slugs (gpt-5.x-codex), which gained vision in the 5.2-Codex
    // line (screenshots / diagrams / charts). Verified against
    // docs/codex-protocol-spec.md (an `input_image` block on a gpt-5-codex
    // request) plus OpenAI's current model lineup. The historical
    // "-codex is text-only" exclusion was stale — the wire reads images on
    // these slugs, so lab-OCR and document reads both succeed on a `-codex` pin.
    m.startsWith("gpt-5") ||
    // The GPT-6 line is multimodal too. OpenAI's Codex model bundle
    // (codex-rs/models-manager/models.json) lists every gpt-6 slug with
    // `input_modalities: ["text", "image"]`, and the Codex client keeps image
    // blocks for such a model. OpenAI retired the 5.x line from Codex for
    // ChatGPT sign-in, so without this line no Codex account reads images.
    m.startsWith("gpt-6") ||
    m.startsWith("gpt-4o") ||
    m.startsWith("gpt-4.1") ||
    m.startsWith("gpt-4-turbo") ||
    // Same `-mini` / `-preview` text-only exclusion as the OpenAI gate: a
    // future codex slug rotation onto e.g. `o3-mini` must not claim vision.
    isVisionReasoningSlug(m)
  );
}

/**
 * Logical provider tags the OCR path reasons about. Mirrors the
 * `ProviderChainType` vocabulary plus the legacy `admin-key` single-provider
 * tag `resolveProvider`'s admin fallback returns.
 */
export type VisionProviderType =
  | "anthropic"
  | "openai"
  | "admin-openai"
  | "admin-key"
  | "local"
  | "openai-compatible"
  | "codex"
  | "admin-codex"
  | "none";

/**
 * Pure capability check over a (providerType, model) pair.
 *
 *  - anthropic            → vision when the model is a 3.5+/4 family pin.
 *  - openai / admin-*     → vision when the model is a gpt-4o/4.1/turbo/o* pin.
 *  - local                → trust-by-default true: the operator opted in by
 *                           configuring a self-hosted model and we cannot sniff
 *                           its capabilities; a non-vision local model surfaces
 *                           a clear extract failure rather than a silent gate.
 *  - openai-compatible    → same trust-by-default: a gateway routes whatever
 *                           model name its operator aliased, so the OpenAI
 *                           allowlist would reject perfectly capable models
 *                           (and accept incapable ones) on the strength of a
 *                           string the gateway owner picked.
 *  - codex                → vision when the resolved codex slug is a
 *                           multimodal model (GPT-5.x / gpt-4o-class). Image
 *                           input rides the ChatGPT plan — no API key. A
 *                           non-multimodal slug (or unknown) → false.
 *  - none                 → false (nothing configured).
 */
export function supportsVisionForConfig(
  providerType: VisionProviderType,
  model: string | null,
): boolean {
  switch (providerType) {
    case "anthropic":
      return model ? anthropicSupportsVision(model) : false;
    case "openai":
    case "admin-openai":
    case "admin-key":
      return model ? openaiSupportsVision(model) : false;
    case "local":
    case "openai-compatible":
      return true;
    case "codex":
    // The operator-shared central Codex runs the same `codex/responses` wire on
    // a resolved GPT-5.x slug, so its vision capability is identical to `codex`.
    case "admin-codex":
      return model ? codexSupportsVision(model) : false;
    case "none":
    default:
      return false;
  }
}

/**
 * Whether PDFs are supported for a given provider. Only Anthropic accepts a
 * native `document` block over the Messages API; OpenAI / local read images
 * only (a server-side rasterizer is a deferred follow-up). The route uses this
 * to reject a PDF upload with a clear "use a photo / configure Claude" message
 * on a non-Anthropic provider.
 */
export function supportsPdfForProvider(
  providerType: VisionProviderType,
): boolean {
  return providerType === "anthropic";
}
