import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  resolveProviderForTest,
  AITestConfigError,
  type AITestOverride,
} from "@/lib/ai/provider";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

const overrideSchema = z
  .object({
    provider: z
      .enum(["OPENAI", "ANTHROPIC", "LOCAL", "CHATGPT_OAUTH"])
      .optional()
      .nullable(),
    model: z.string().min(1).max(120).optional().nullable(),
    baseUrl: z.string().url().max(2048).optional().nullable(),
    anthropicKey: z.string().min(1).max(500).optional().nullable(),
    localKey: z.string().min(1).max(500).optional().nullable(),
  })
  .strict();

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "ai.test" } });

  const rl = await checkRateLimit(`ai-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) return apiError("Too many test requests", 429);

  // Body is optional. Empty body → behaves like before (test the saved
  // config). Non-empty body → tests the unsaved selection without
  // mutating the user row. Plaintext keys never persist.
  let override: AITestOverride = {};
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 0) {
    const { data, error } = await safeJson<unknown>(request);
    if (error) return error;
    const parsed = overrideSchema.safeParse(data);
    if (!parsed.success) {
      return apiError("Invalid override payload", 422);
    }
    override = parsed.data;
  }

  let provider;
  try {
    provider = await resolveProviderForTest(user.id, override);
  } catch (e) {
    if (e instanceof AITestConfigError) {
      return apiError(e.message, e.status);
    }
    throw e;
  }

  if (provider.type === "none") {
    return apiError("No AI provider configured", 422);
  }

  try {
    const result = await provider.generateCompletion({
      systemPrompt: "You are a connection-test responder.",
      userPrompt: 'Reply with the JSON object {"ok": true} and nothing else.',
      temperature: 0,
      maxTokens: 32,
    });

    return apiSuccess({
      ok: true,
      providerType: result.providerType,
      model: result.model,
      tokensUsed: result.tokensUsed,
      sample: result.content.slice(0, 200),
    });
  } catch (e) {
    // V3 audit: do not return provider error message + bodyExcerpt to the
    // client (leaks provider URL / partial keys / internal headers).
    // Log full details server-side for the operator and respond with a
    // categorised, generic message.
    const err = e as Error & { httpStatus?: number; bodyExcerpt?: string };
    annotate({
      meta: {
        ai_test_error: err.message.slice(0, 500),
        ai_test_status: err.httpStatus ?? null,
        ai_test_body_excerpt: err.bodyExcerpt?.slice(0, 500) ?? null,
        ai_test_provider: provider.type,
      },
    });
    const status = err.httpStatus ?? 0;
    const safeMessage =
      status === 401 || status === 403
        ? "Provider rejected the credentials"
        : status === 429
          ? "Provider rate-limited the request"
          : status >= 500
            ? "Provider returned a server error"
            : "Provider connection failed";
    return apiError(safeMessage, 502);
  }
});
