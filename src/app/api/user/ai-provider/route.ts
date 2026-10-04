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
import {
  chainWithReasoningEffort,
  parseProviderChain,
  serializeProviderChain,
} from "@/lib/ai/provider-chain";
import { reasoningEffortFor } from "@/lib/ai/reasoning-effort";

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
      // #1126 — the reasoning settings live on the chain entries.
      aiProviderChain: true,
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
  //
  // The operator's master switch is part of the answer: with every AI
  // capability switched off there is no AI available, whatever is
  // configured, so a native client that keys on this field hides its AI
  // surfaces. The switches fail closed (a read error reads as all off).
  const [presence, assistantFlags] = await Promise.all([
    resolveProviderAvailability(user.id),
    getAssistantFlags(),
  ]);
  const aiAvailable = presence.aiAvailable && assistantFlags.enabled;
  const { managedBy } = presence;

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
  //
  // The offer is worth making while any capability it would unlock is
  // switched on by the operator: the Coach, the briefing, or reading
  // documents. With all three off there is nothing for the consent to open.
  const demoInstance = process.env.DEMO_MODE === "true";
  const offerUnlocksSomething =
    assistantFlags.coach ||
    assistantFlags.briefing ||
    assistantFlags.documentAi;
  const serverProviderOffer =
    !demoInstance &&
    managedBy === "server" &&
    serverProviderHealth === "healthy" &&
    offerUnlocksSomething &&
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
    // #1126 — the Local and gateway entries' reasoning settings (null =
    // Default), read from the chain where they are stored.
    localReasoningEffort: reasoningEffortFor(u?.aiProviderChain, "local"),
    compatReasoningEffort: reasoningEffortFor(
      u?.aiProviderChain,
      "openai-compatible",
    ),
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

  // v1.39.3 — whose configuration this is. Settings saved on an admin account
  // are the operator's own and are still covered by the deprecated
  // `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true`; any other account needs an exact
  // origin in `AI_PRIVATE_ORIGINS`. Read from the saved row, the same rule
  // the provider resolution applies when it later dials the URL.
  const needsHostPolicy =
    (typeof body.baseUrl === "string" && body.baseUrl !== "") ||
    (typeof body.compatBaseUrl === "string" && body.compatBaseUrl !== "");
  const owner = needsHostPolicy
    ? {
        operatorTrusted:
          (
            await prisma.user.findUnique({
              where: { id: user.id },
              select: { role: true },
            })
          )?.role === "ADMIN",
      }
    : {};

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
      // metadata endpoint or internal admin panels. The operator grants a
      // private endpoint by exact origin (`AI_PRIVATE_ORIGINS`, or the legacy
      // host list); the deprecated `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` covers
      // an admin account's own settings only (`owner` above), and no grant
      // can open metadata or link-local.
      const allowPrivate = isLocalAiHostAllowed(trimmed, owner);
      if (!allowPrivate && !isPublicUrl(trimmed)) {
        return apiError(
          "Base URL points to an internal/private host. The operator must allow its exact origin on this instance via AI_PRIVATE_ORIGINS (e.g. http://ollama.lan:11434) for a self-hosted Ollama / LM Studio.",
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
      if (!isLocalAiHostAllowed(trimmed, owner) && !isPublicUrl(trimmed)) {
        return apiError(
          "Base URL points to an internal/private host. The operator must allow its exact origin on this instance via AI_PRIVATE_ORIGINS (e.g. http://litellm.lan:4000) for a self-hosted gateway.",
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

  // ── #1126 — reasoning settings of the Local and gateway entries ──
  // Stored on the entry in `aiProviderChain` rather than in a column of their
  // own, so the setting is per entry and a chain can mix a thinking model with
  // one that does not know the field. See `chainWithReasoningEffort` for how a
  // default chain, or a provider absent from the chain, holds the value.
  const reasoningTouched =
    body.localReasoningEffort !== undefined ||
    body.compatReasoningEffort !== undefined;
  if (reasoningTouched) {
    const current = await prisma.user.findUnique({
      where: { id: user.id },
      select: { aiProviderChain: true },
    });
    let chain: unknown = current?.aiProviderChain ?? null;
    if (body.localReasoningEffort !== undefined) {
      chain = chainWithReasoningEffort(
        chain,
        "local",
        body.localReasoningEffort,
      );
    }
    if (body.compatReasoningEffort !== undefined) {
      chain = chainWithReasoningEffort(
        chain,
        "openai-compatible",
        body.compatReasoningEffort,
      );
    }
    // Written only when it changed: restating Default on a chain that was
    // never customised must not freeze today's default chain into the row.
    const before = serializeProviderChain(
      parseProviderChain(current?.aiProviderChain ?? null),
    );
    if (serializeProviderChain(parseProviderChain(chain)) !== before) {
      updates.aiProviderChain = chain;
    }
  }

  if (Object.keys(updates).length === 0 && !reasoningTouched) {
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

  if (Object.keys(updates).length > 0) {
    await prisma.user.update({ where: { id: user.id }, data: updates });
  }

  return apiSuccess({ updated: true });
});
