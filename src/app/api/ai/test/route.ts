import type { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  resolveProviderForTest,
  AITestConfigError,
  type AITestOverride,
} from "@/lib/ai/provider";
import { singleUserTurn } from "@/lib/ai/types";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { aiTestOverrideSchema } from "@/lib/validations/ai-provider";

/**
 * Output ceiling of the probe below. Mirrors the `maxTokens` on the completion
 * so the ledger reserves what the call can actually spend.
 */
const AI_TEST_MAX_TOKENS = 32;

/**
 * Daily ceiling on connection tests per user.
 *
 * The 5/min bucket alone bounded burst rate but nothing cumulative: sustained,
 * it permits ~7 200 probes/day, and with an empty body this route resolves the
 * SAME chain generation uses — which can be the operator's own credential. That
 * is unmetered operator spend on a surface that exists to answer "are my
 * settings right?". A person checks that a handful of times after editing a
 * provider; 50 is far above real use and far below anything that matters on the
 * bill.
 */
const AI_TEST_DAILY_LIMIT = 50;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "ai.test" } });

  const rl = await checkRateLimit(`ai-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) return apiError("Too many test requests", 429);

  // Cumulative ceiling on top of the burst bucket — see AI_TEST_DAILY_LIMIT.
  const daily = await checkRateLimit(
    `ai-test-daily:${user.id}`,
    AI_TEST_DAILY_LIMIT,
    ONE_DAY_MS,
  );
  if (!daily.allowed) {
    annotate({ action: { name: "ai.test.daily_limit" } });
    return apiError("Too many test requests today", 429);
  }

  // Body is optional. Empty body → behaves like before (test the saved
  // config). Non-empty body → tests the unsaved selection without
  // mutating the user row. Plaintext keys never persist.
  let override: AITestOverride = {};
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 0) {
    const { data, error } = await safeJson<unknown>(request, {
      maxBytes: 64 * 1024,
    });
    if (error) return error;
    const parsed = aiTestOverrideSchema.safeParse(data);
    if (!parsed.success) {
      return apiValidationError(
        "Invalid override payload",
        sanitiseZodIssues(parsed.error.issues),
        422,
      );
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

  // Meter the probe on the same daily ledger every other AI surface writes to,
  // so operator-key spend from this route is visible rather than invisible.
  // `admin-key` is the operator's own credential and draws the operator
  // ceiling; an override names the caller's own key, and every other resolved
  // type is the user's own egress, so those draw the user-plan ceiling.
  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    user.id,
    AI_TEST_MAX_TOKENS,
    dateKey,
    resolveDailyCap([
      {
        providerType: provider.type === "admin-key" ? "admin-openai" : "local",
      },
    ]),
    resolveCostOwner([
      {
        providerType: provider.type === "admin-key" ? "admin-openai" : "local",
      },
    ]),
  );
  if (!reservation.allowed) {
    annotate({ action: { name: "ai.test.budget_exceeded" } });
    return apiError("Daily AI budget exhausted", 429);
  }

  try {
    const result = await provider.generateCompletion(
      singleUserTurn({
        system: "You are a connection-test responder.",
        user: 'Reply with the JSON object {"ok": true} and nothing else.',
        temperature: 0,
        maxTokens: AI_TEST_MAX_TOKENS,
        // The probe asks for a JSON object — keep the OpenAI / Codex strict
        // JSON mode it relied on before the response_format gate landed.
        responseFormat: "json",
      }),
    );

    await reconcileSpend(
      user.id,
      reservation.reserved,
      result.tokensUsed ?? reservation.reserved,
      dateKey,
      0,
      {
        servedBy: provider.type === "admin-key" ? "admin-openai" : "local",
        reservedOwner: reservation.owner,
      },
    );

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
    // categorised, generic reason.
    const err = e as Error & { httpStatus?: number; bodyExcerpt?: string };
    // A failed probe produced no reported usage — refund the reservation so a
    // provider that is simply misconfigured doesn't burn the caller's ledger
    // while they fix it.
    await reconcileSpend(user.id, reservation.reserved, 0, dateKey, 0, {
      servedBy: null,
      reservedOwner: reservation.owner,
    });
    annotate({
      meta: {
        ai_test_error: err.message.slice(0, 500),
        ai_test_status: err.httpStatus ?? null,
        ai_test_body_excerpt: err.bodyExcerpt?.slice(0, 500) ?? null,
        ai_test_provider: provider.type,
      },
    });
    // This route MUST NEVER return a 5xx. A 5xx origin response is
    // rewritten by Cloudflare / the reverse proxy to its own HTML error
    // page, so the browser's `res.json()` crashes with
    // `Unexpected token '<', "<!DOCTYPE "` (Safari: "The string did not
    // match the expected pattern"). That is exactly the failure an
    // operator hit re-authenticating a provider whose token came back as
    // an invalidated-session 500. We always reply 200 with a categorised,
    // secret-free `{ ok:false, reason }` the client can show verbatim.
    const { reasonCode, reason } = classifyTestFailure(err);
    return apiSuccess({
      ok: false,
      providerType: provider.type,
      reasonCode,
      reason,
      // v1.28.28 (#470) — the upstream status (secret-free) so the client
      // can localise "rejected the request (HTTP 400)" with the real number.
      httpStatus: err.httpStatus ?? null,
    });
  }
});

/**
 * Stable, machine-readable failure categories. The client maps each to a
 * localised string; the English `reason` stays as a fallback for any
 * legacy / unmapped code. Secret-free by construction.
 */
type TestFailureCode =
  | "credentials"
  | "rate_limited"
  | "server_error"
  | "bad_request"
  | "unreachable";

/**
 * Map an upstream provider failure to a human-readable, secret-free
 * reason string. Distinguishes credential/auth, rate-limit, provider
 * server-error and network/timeout classes. A 5xx whose body carries an
 * auth signal (invalidated session token, expired key, "sign in again")
 * is reclassified as a credential failure — that is the shape the
 * operator's re-auth produced, where the gateway answered 500 instead of
 * the expected 401.
 */
function classifyTestFailure(
  err: Error & { httpStatus?: number; bodyExcerpt?: string },
): { reasonCode: TestFailureCode; reason: string } {
  const status = err.httpStatus ?? 0;
  const haystack = `${err.message} ${err.bodyExcerpt ?? ""}`;
  const looksLikeAuth =
    /authentication|invalidated|expired|sign in again|api key/i.test(haystack);

  if (status === 401 || status === 403 || (status >= 500 && looksLikeAuth)) {
    return {
      reasonCode: "credentials",
      reason:
        "Provider rejected the credentials — re-authenticate in AI settings.",
    };
  }
  if (status === 429) {
    return {
      reasonCode: "rate_limited",
      reason: "Provider rate-limited the request — try again shortly.",
    };
  }
  if (status >= 500) {
    return {
      reasonCode: "server_error",
      reason: "The AI provider returned a server error.",
    };
  }
  // v1.28.28 (#470) — any other 4xx (400 / 404 / 405 / 415 / 422, …) means
  // the endpoint ANSWERED and rejected the request shape or model name. The
  // old lump into "unreachable" sent operators debugging connectivity when
  // the fix was the model field or a gateway's parameter strictness.
  if (status >= 400 && status < 500) {
    return {
      reasonCode: "bad_request",
      reason: `The provider rejected the request (HTTP ${status}) — the endpoint answered, so this is a request-shape or model-name problem, not connectivity.`,
    };
  }
  return {
    reasonCode: "unreachable",
    reason: "Could not reach the AI provider.",
  };
}
