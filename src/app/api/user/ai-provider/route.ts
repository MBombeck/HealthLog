import { NextRequest } from "next/server";
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { isPublicUrl } from "@/lib/validations/notifications";
import { encrypt, decrypt } from "@/lib/crypto";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["OPENAI", "ANTHROPIC", "LOCAL", "CHATGPT_OAUTH"]);

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
    },
  });

  return apiSuccess({
    provider: u?.aiProvider ?? null,
    model: u?.aiModel ?? null,
    baseUrl: u?.aiBaseUrl ?? null,
    hasAnthropicKey: Boolean(u?.aiAnthropicKeyEncrypted),
    anthropicKeyPreview: u?.aiAnthropicKeyEncrypted
      ? `...${decrypt(u.aiAnthropicKeyEncrypted).slice(-4)}`
      : null,
    hasLocalKey: Boolean(u?.aiLocalKeyEncrypted),
  });
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.ai-provider.update" } });

  const { data: body, error } = await safeJson<Record<string, unknown>>(request);
  if (error) return error;

  const updates: Record<string, unknown> = {};

  if (body.provider !== undefined) {
    if (body.provider === null || body.provider === "") {
      updates.aiProvider = null;
    } else if (typeof body.provider === "string" && ALLOWED.has(body.provider)) {
      updates.aiProvider = body.provider;
    } else {
      throw new HttpError(422, "Invalid provider");
    }
  }

  if (body.model !== undefined) {
    if (body.model === null || body.model === "") {
      updates.aiModel = null;
    } else if (typeof body.model === "string") {
      updates.aiModel = body.model.trim() || null;
    }
  }

  if (body.baseUrl !== undefined) {
    if (body.baseUrl === null || body.baseUrl === "") {
      updates.aiBaseUrl = null;
    } else if (typeof body.baseUrl === "string") {
      const trimmed = body.baseUrl.trim();
      // SSRF guard: by default reject private/internal hostnames so a
      // compromised user account cannot point the server at the cloud
      // metadata endpoint or internal admin panels. Ops can enable local
      // Ollama / LM Studio on this instance via env flag.
      const allowPrivate = process.env.ALLOW_LOCAL_AI_PRIVATE_HOSTS === "true";
      if (!allowPrivate && !isPublicUrl(trimmed)) {
        return apiError(
          "Base URL points to an internal/private host. Ops must set ALLOW_LOCAL_AI_PRIVATE_HOSTS=true on this instance to allow it (intended for self-hosted Ollama / LM Studio).",
          422,
        );
      }
      updates.aiBaseUrl = trimmed;
    }
  }

  if (body.anthropicKey !== undefined) {
    if (body.anthropicKey === null || body.anthropicKey === "") {
      updates.aiAnthropicKeyEncrypted = null;
    } else if (typeof body.anthropicKey === "string") {
      updates.aiAnthropicKeyEncrypted = encrypt(body.anthropicKey.trim());
    }
  }

  if (body.localKey !== undefined) {
    if (body.localKey === null || body.localKey === "") {
      updates.aiLocalKeyEncrypted = null;
    } else if (typeof body.localKey === "string") {
      updates.aiLocalKeyEncrypted = encrypt(body.localKey.trim());
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new HttpError(422, "No valid fields");
  }

  await prisma.user.update({ where: { id: user.id }, data: updates });

  return apiSuccess({ updated: true });
});
