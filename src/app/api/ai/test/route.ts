import { apiHandler, requireAuth } from "@/lib/api-handler";
import { resolveProvider } from "@/lib/ai/provider";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "ai.test" } });

  const rl = await checkRateLimit(`ai-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) return apiError("Too many test requests", 429);

  const provider = await resolveProvider(user.id);
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
