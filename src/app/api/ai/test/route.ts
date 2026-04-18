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
    const err = e as Error & { httpStatus?: number; bodyExcerpt?: string };
    return apiError(
      `${err.message}${err.bodyExcerpt ? ` — ${err.bodyExcerpt.slice(0, 200)}` : ""}`,
      502,
    );
  }
});
