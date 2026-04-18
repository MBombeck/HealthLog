import { NextRequest } from "next/server";
import { apiHandler, requireAdmin, HttpError } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, getClientIp, safeJson } from "@/lib/api-response";
import { encrypt, decrypt } from "@/lib/crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.ai-settings.get" } });

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  const hasKey = Boolean(settings?.adminAiKeyEncrypted);
  const model = settings?.adminAiModel ?? "gpt-4o-mini";
  const baseUrl = settings?.adminAiBaseUrl ?? "https://api.openai.com/v1";

  return apiSuccess({
    hasKey,
    keyPreview: settings?.adminAiKeyEncrypted
      ? `...${decrypt(settings.adminAiKeyEncrypted).slice(-4)}`
      : null,
    model,
    baseUrl,
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.ai-settings.update" } });

  const rl = await checkRateLimit("admin-ai-settings", 10, 60_000);
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const { apiKey, model, baseUrl } = body as {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };

  const updates: Record<string, unknown> = {};
  const auditDetails: Record<string, unknown> = {};

  if (apiKey !== undefined) {
    const trimmed = apiKey.trim();
    if (trimmed) {
      updates.adminAiKeyEncrypted = encrypt(trimmed);
      auditDetails.apiKeyUpdated = true;
    } else {
      updates.adminAiKeyEncrypted = null;
      auditDetails.apiKeyUpdated = false;
    }
  }

  if (model !== undefined) {
    const trimmed = model.trim();
    if (!trimmed) throw new HttpError(422, "Model cannot be empty");
    updates.adminAiModel = trimmed;
    auditDetails.model = trimmed;
  }

  if (baseUrl !== undefined) {
    const trimmed = baseUrl.trim();
    if (!trimmed) throw new HttpError(422, "Base URL cannot be empty");

    // The admin AI base URL has full egress of the bearer key on every
    // insight call. Lock it to HTTPS + a hostname allowlist so a
    // compromised admin (or stolen cookie) cannot point it at
    // attacker.example and exfiltrate the key on the next AI call.
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new HttpError(422, "Base URL is not a valid URL");
    }
    if (parsed.protocol !== "https:") {
      throw new HttpError(422, "Base URL must use https://");
    }
    const allowedHosts = new Set([
      "api.openai.com",
      "api.anthropic.com",
      "generativelanguage.googleapis.com",
      "api.mistral.ai",
      "api.groq.com",
      "openrouter.ai",
    ]);
    for (const h of (process.env.ADMIN_AI_BASE_URL_ALLOWLIST ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean)) {
      allowedHosts.add(h);
    }
    if (!allowedHosts.has(parsed.hostname)) {
      throw new HttpError(
        422,
        `Base URL host '${parsed.hostname}' not in allowlist. Set ADMIN_AI_BASE_URL_ALLOWLIST if you need a custom provider.`,
      );
    }
    updates.adminAiBaseUrl = trimmed;
    auditDetails.baseUrl = trimmed;
  }

  if (Object.keys(updates).length === 0) {
    throw new HttpError(422, "No valid fields");
  }

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: updates,
    create: { id: "singleton", ...updates },
  });

  await auditLog("admin.ai-settings.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: auditDetails,
  });

  const hasKey = Boolean(settings.adminAiKeyEncrypted);

  return apiSuccess({
    hasKey,
    keyPreview: settings.adminAiKeyEncrypted
      ? `...${decrypt(settings.adminAiKeyEncrypted).slice(-4)}`
      : null,
    model: settings.adminAiModel,
    baseUrl: settings.adminAiBaseUrl,
  });
});
