import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import {
  apiSuccess,
  apiError,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { isPublicUrl } from "@/lib/validations/notifications";
import { isLocalAiHostAllowed } from "@/lib/ai/local-host-allowlist";
import { encrypt, decrypt } from "@/lib/crypto";
import { resolveProviderAvailability } from "@/lib/ai/provider";
import { readServerProviderHealth } from "@/lib/ai/server-provider-health";
import { hasActiveConsentForSurface } from "@/lib/ai/consent-guard";
import { getAssistantFlags } from "@/lib/feature-flags";
import {
  providerCredentialPolicy,
  providerWorkAuthorityForRecord,
} from "@/lib/sharing/provider-work-authority";
import { annotate } from "@/lib/logging/context";
import { aiProviderPatchSchema } from "@/lib/validations/ai-provider";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.ai-provider.get" } });

  const u = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      aiProvider: true,
      aiModel: true,
      aiBaseUrl: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      // v1.33.1 (#470) — the OpenAI-compatible gateway.
      aiCompatBaseUrl: true,
      aiCompatKeyEncrypted: true,
      aiCompatModel: true,
      // v1.22 (#89)
      aiResponseTimeoutSeconds: true,
      // v1.38.19 — a managed profile is never the party that gives
      // consent for itself; the offer below has to know.
      managedProfileAt: true,
    },
  });

  // Effective availability: surfaces whether ANY provider can serve this
  // user — including the operator's admin-managed key when the user has set
  // no personal provider. iOS keys its Coach visibility off `aiAvailable` so
  // a server-managed provider is no longer invisible to the client.
  // `managedBy` reports the origin only; no admin keys/endpoints are leaked.
  const { aiAvailable, managedBy } = await resolveProviderAvailability(user.id);

  // ── v1.38.19 — the shared provider, honestly ────────────────
  // `managedBy: "server"` says the operator configured a key. It has never
  // said the key WORKS, and the setup flow spent three releases promising
  // that it did. It also says nothing about the consent receipt
  // `consent-guard.ts` demands before any PHI reaches `admin-openai` /
  // `admin-codex`, which is the decision a fresh account is actually
  // missing — the provider was already chosen for them by the default chain.
  //
  // So three additive fields, and every one of them can only ever take the
  // offer away:
  //   serverProviderHealth  — the instance-wide tri-state, fail closed.
  //   serverProviderConsent — this user already holds a receipt.
  //   serverProviderOffer   — all five preconditions hold at once.
  //
  // Nothing here probes a provider. The flow's rule ("nothing in the flow
  // talks to an AI provider") holds: a probe would bill the OPERATOR for
  // every registration on the instance.
  const serverProviderHealth = await readServerProviderHealth();
  const serverProviderConsent = await hasActiveConsentForSurface(
    user.id,
    "coach",
  );
  const assistantFlags = await getAssistantFlags();
  // `personal`, not merely "not deny": a guardian's own record resolves to
  // `personal`, while a managed profile resolves to `operator-default` —
  // its provider is the operator's by definition, and a child's record does
  // not consent to its own PHI egress. Both must be excluded here, and only
  // the positive form excludes both.
  const credentialPolicy = providerCredentialPolicy(
    providerWorkAuthorityForRecord(user.id),
    u?.managedProfileAt ?? null,
  );
  // A demo instance can show the offer but cannot honour it: the one tap
  // posts `POST /api/consent/ai/web`, which the demo's edge allowlist
  // refuses — and should, since the demo is one shared account and a receipt
  // one visitor minted would turn the operator's provider on for every later
  // one. A button that can only 403 into a generic toast is precisely the
  // misleading failure this surface exists to remove, so there is no button.
  const demoInstance = process.env.DEMO_MODE === "true";
  const serverProviderOffer =
    !demoInstance &&
    managedBy === "server" &&
    serverProviderHealth === "healthy" &&
    assistantFlags.enabled &&
    assistantFlags.coach &&
    credentialPolicy === "personal" &&
    !serverProviderConsent;

  return apiSuccess({
    provider: u?.aiProvider ?? null,
    model: u?.aiModel ?? null,
    baseUrl: u?.aiBaseUrl ?? null,
    aiAvailable,
    managedBy,
    hasAnthropicKey: Boolean(u?.aiAnthropicKeyEncrypted),
    anthropicKeyPreview: u?.aiAnthropicKeyEncrypted
      ? `...${decrypt(u.aiAnthropicKeyEncrypted).slice(-4)}`
      : null,
    hasLocalKey: Boolean(u?.aiLocalKeyEncrypted),
    hasOpenaiKey: Boolean(u?.aiOpenaiKeyEncrypted),
    openaiKeyPreview: u?.aiOpenaiKeyEncrypted
      ? `...${decrypt(u.aiOpenaiKeyEncrypted).slice(-4)}`
      : null,
    // v1.33.1 (#470) — the gateway's own configuration. The key is reported
    // as presence only, like every other credential on this surface.
    compatBaseUrl: u?.aiCompatBaseUrl ?? null,
    compatModel: u?.aiCompatModel ?? null,
    hasCompatKey: Boolean(u?.aiCompatKeyEncrypted),
    // v1.22 (#89) — per-user response timeout, in seconds (null = default).
    responseTimeoutSeconds: u?.aiResponseTimeoutSeconds ?? null,
    // v1.38.19 — see the block above. A tri-state and two booleans;
    // no count, no timestamp and no other account is inferable from them.
    serverProviderHealth,
    serverProviderOffer,
    serverProviderConsent,
  });
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.ai-provider.update" } });

  const { data: rawBody, error } = await safeJson<unknown>(request, {
    maxBytes: 64 * 1024,
  });
  if (error) return error;

  // Every accepted field states its type in the schema, so a wrongly-typed
  // value is a named issue rather than a key quietly dropped on the floor.
  // The multi-issue envelope is safe to return even though this body carries
  // plaintext credentials: Zod's type and range messages name the received
  // TYPE, never the received value. See the note in the validations module
  // before adding a `.refine()` here.
  const parsed = aiProviderPatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "user.ai-provider.update" },
      meta: {
        outcome: "validation_failed",
        issue_count: parsed.error.issues.length,
      },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "ai_provider.invalid",
    });
  }
  const body = parsed.data;

  const updates: Record<string, unknown> = {};

  if (body.provider !== undefined) {
    updates.aiProvider =
      body.provider === null || body.provider === "" ? null : body.provider;
  }

  if (body.model !== undefined) {
    updates.aiModel = body.model === null ? null : body.model.trim() || null;
  }

  if (body.baseUrl !== undefined) {
    if (body.baseUrl === null || body.baseUrl === "") {
      updates.aiBaseUrl = null;
    } else {
      const trimmed = body.baseUrl.trim();
      // SSRF guard: by default reject private/internal hostnames so a
      // compromised user account cannot point the server at the cloud
      // metadata endpoint or internal admin panels. v1.18.7 (SECURITY LOW) —
      // ops opt in via `ALLOW_LOCAL_AI_PRIVATE_HOSTS`, now a host allowlist:
      // `true` permits any private host (legacy), a comma-separated host list
      // permits only those exact hostnames.
      const allowPrivate = isLocalAiHostAllowed(trimmed);
      if (!allowPrivate && !isPublicUrl(trimmed)) {
        return apiError(
          "Base URL points to an internal/private host. Ops must allow it on this instance via ALLOW_LOCAL_AI_PRIVATE_HOSTS — set it to the exact host (e.g. ollama.lan) or to true for any private host (intended for self-hosted Ollama / LM Studio).",
          422,
        );
      }
      updates.aiBaseUrl = trimmed;
    }
  }

  // ── v1.33.1 (#470) — the OpenAI-compatible gateway's three fields ──
  // Deliberately a separate block from `baseUrl` above: that column is shared
  // with LOCAL and is cleared when the provider switches away from it. This
  // one belongs to a single provider and to no other, which is what keeps the
  // OpenAI key from ever being sendable to a user-supplied host.
  if (body.compatBaseUrl !== undefined) {
    if (body.compatBaseUrl === null || body.compatBaseUrl === "") {
      updates.aiCompatBaseUrl = null;
    } else {
      const trimmed = body.compatBaseUrl.trim();
      // Same SSRF floor as the Local provider: a public host always, a
      // private one only when the operator allowlisted it. Gateways on a LAN
      // are the normal case for LiteLLM / vLLM, so the escape hatch matters
      // here as much as it does for Ollama.
      if (!isLocalAiHostAllowed(trimmed) && !isPublicUrl(trimmed)) {
        return apiError(
          "Base URL points to an internal/private host. Ops must allow it on this instance via ALLOW_LOCAL_AI_PRIVATE_HOSTS — set it to the exact host (e.g. litellm.lan) or to true for any private host (intended for a self-hosted gateway).",
          422,
        );
      }
      updates.aiCompatBaseUrl = trimmed;
    }
  }

  if (body.compatModel !== undefined) {
    updates.aiCompatModel =
      body.compatModel === null ? null : body.compatModel.trim() || null;
  }

  if (body.compatKey !== undefined) {
    updates.aiCompatKeyEncrypted =
      body.compatKey === null || body.compatKey === ""
        ? null
        : encrypt(body.compatKey.trim());
  }

  if (body.anthropicKey !== undefined) {
    updates.aiAnthropicKeyEncrypted =
      body.anthropicKey === null || body.anthropicKey === ""
        ? null
        : encrypt(body.anthropicKey.trim());
  }

  if (body.localKey !== undefined) {
    updates.aiLocalKeyEncrypted =
      body.localKey === null || body.localKey === ""
        ? null
        : encrypt(body.localKey.trim());
  }

  if (body.openaiKey !== undefined) {
    updates.aiOpenaiKeyEncrypted =
      body.openaiKey === null || body.openaiKey === ""
        ? null
        : encrypt(body.openaiKey.trim());
  }

  // ── v1.22 (#89) — response timeout (seconds) ──────────────────
  // The 10–600 bounds are the schema's; an out-of-range value never reaches
  // here.
  if (body.responseTimeoutSeconds !== undefined) {
    updates.aiResponseTimeoutSeconds = body.responseTimeoutSeconds;
  }

  if (Object.keys(updates).length === 0) {
    return apiError("No valid fields", 422, {
      errorCode: "ai_provider.no_fields",
    });
  }

  // When the provider switches away from LOCAL, drop any stored
  // `aiBaseUrl`. The column is shared across providers, so without
  // this a user who once configured LOCAL → http://192.168.x.x and
  // then switched to OPENAI/ANTHROPIC would have their cloud key
  // sent to that URL on the next request. Only LOCAL legitimately
  // uses a custom base URL.
  if (
    typeof updates.aiProvider === "string" &&
    updates.aiProvider !== "LOCAL" &&
    !("aiBaseUrl" in updates)
  ) {
    updates.aiBaseUrl = null;
  }

  await prisma.user.update({ where: { id: user.id }, data: updates });

  return apiSuccess({ updated: true });
});
