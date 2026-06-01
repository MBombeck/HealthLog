/**
 * v1.5.0 — POST /api/medications/extract
 *
 * Coach-backed natural-language overlay for step 1 of the medication
 * create wizard. The user types a free-form description ("Mounjaro 5mg
 * weekly Wednesday morning"); the route runs that string through the
 * provider chain and returns a structured partial payload the wizard
 * merges onto whatever the user already typed.
 *
 * Why a dedicated route instead of re-using /api/insights/chat:
 *
 *   - The Coach chat surface is conversational + streaming. The
 *     extraction is a single round-trip JSON payload — different shape,
 *     different validation contract, different prompt body.
 *   - The chat route does not enforce a structured-output schema; this
 *     route Zod-parses the model's reply and only ever returns a
 *     citation-guarded result. A wizard that pre-fills the form has to
 *     be defensive about hallucinated names + doses; the chat surface
 *     does not.
 *   - Separate rate-limit bucket ("coach.medication.extract") so a
 *     wizard that the user mashes the button on cannot exhaust the
 *     20/min chat ceiling and lock the drawer for an hour.
 *
 * Behaviour:
 *
 *   1. requireAuth()                       — cookie OR Bearer.
 *   2. requireAssistantSurface("coach")    — operator can disable.
 *   3. checkRateLimit(...)                 — 10 requests / 5 min / user.
 *   4. enforceBudget()                     — daily Coach token ceiling.
 *   5. resolveProviderChain()              — fall back through providers.
 *   6. runRawCompletionWithFallback()      — same machinery the Coach
 *      uses; structured-output is enforced via JSON.parse + Zod here
 *      rather than via the strict-schema wrapper.
 *   7. applyCitationGuard()                — drop hallucinated name/dose.
 *   8. recordSpend()                       — bump the day's ledger.
 *
 * Response: `{ data: MedicationExtractionResult, error: null }`. Every
 * field on the result is optional; the wizard is the merge target.
 */

import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { requireAssistantSurface } from "@/lib/feature-flags";

import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";

import {
  buildDateKey,
  enforceBudget,
  recordSpend,
} from "@/lib/ai/coach/budget";
import {
  applyCitationGuard,
  buildMedicationExtractionPrompt,
  medicationExtractionSchema,
  type MedicationExtractionResult,
} from "@/lib/ai/coach/medication-extract-prompt";

/** Hard cap on the free-text payload; mirrors `coachChatRequestSchema.message`. */
const MAX_TEXT_LENGTH = 2000;

const requestSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  /** Optional UI locale; informational hint for the model. */
  locale: z.enum(["en", "de", "es", "fr", "it", "pl"]).optional(),
  /**
   * Optional override of the reference date used to resolve relative
   * phrases ("tomorrow", "next Monday"). Defaults to the server's
   * UTC `YYYY-MM-DD`. Bounded format so a hostile client cannot
   * inject prose into the prompt body.
   */
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * Strip leading code-fence noise that some chat models wrap around
 * structured-output replies, then JSON.parse. Returns null on any
 * failure so the caller can shape a single structured error rather
 * than re-throwing a SyntaxError.
 */
function parseModelJson(content: string): unknown | null {
  let trimmed = content.trim();
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "");
    trimmed = trimmed.trim();
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function handleExtract(request: NextRequest): Promise<Response> {
  const auth = await requireAuth();
  // Same operator-disable gate the Coach SSE route honours — when
  // "coach" is off, the overlay also disappears so the wizard simply
  // falls back to the manual path.
  await requireAssistantSurface("coach");

  const userId = auth.user.id;

  // Body parse + Zod validation.
  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;
  const validated = requestSchema.safeParse(body);
  if (!validated.success) {
    annotate({
      action: { name: "medications.extract.invalid" },
      meta: { issues: validated.error.issues.length },
    });
    return returnAllZodIssues(validated.error);
  }

  const { text, locale, today: todayOverride } = validated.data;

  // 10 / 5 minutes / user. Generous enough for a power user iterating
  // on a description, tight enough that a stuck button cannot pin a
  // provider slot for the full daily budget. Keyed on the user, not
  // the IP, so a household sharing a NAT does not collide.
  const rl = await checkRateLimit(
    `coach.medication.extract:${userId}`,
    10,
    5 * 60 * 1000,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "medications.extract.rate-limited" },
      meta: { userId, resetAt: rl.resetAt },
    });
    return apiError("Too many requests, please wait a moment", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  await enforceBudget(userId);

  // Resolve the same provider chain the Coach uses. If the user has no
  // provider configured AND the operator has not seeded an admin key,
  // surface a structured 503 — the wizard hides the overlay.
  const chain = await resolveProviderChain(userId);
  if (chain.length === 0) {
    const legacy = await resolveProvider(userId);
    if (legacy.type === "none") {
      annotate({ action: { name: "medications.extract.no-provider" } });
      return apiError("No AI provider configured", 503);
    }
    chain.push({ providerType: "admin-openai", instance: legacy });
  }

  const today = todayOverride ?? buildDateKey();
  const { systemPrompt, userPrompt } = buildMedicationExtractionPrompt({
    text,
    today,
    locale,
  });

  let completion;
  try {
    completion = await runRawCompletionWithFallback({
      userId,
      providers: chain,
      params: {
        systemPrompt,
        userPrompt,
        // Low temperature because we want a deterministic field
        // extractor, not a creative rephrase.
        temperature: 0.1,
        // The reply body is a single small JSON object; 600 is well
        // over the empirical max we have seen on a 2k-char input.
        maxTokens: 600,
      },
    });
  } catch (err) {
    if (err instanceof AllProvidersFailedError) {
      annotate({
        action: { name: "medications.extract.provider-failed" },
        meta: { attempts: err.attempts.length },
      });
      return apiError("AI provider unavailable", 503);
    }
    throw err;
  }

  const reply = completion.result.content?.trim() ?? "";
  if (!reply) {
    annotate({ action: { name: "medications.extract.empty-reply" } });
    return apiError("AI provider returned an empty response", 502);
  }

  const json = parseModelJson(reply);
  if (json === null) {
    annotate({
      action: { name: "medications.extract.unparseable" },
      meta: { length: reply.length },
    });
    return apiError("Could not parse the AI provider response", 502);
  }

  const validatedJson = medicationExtractionSchema.safeParse(json);
  if (!validatedJson.success) {
    annotate({
      action: { name: "medications.extract.schema-mismatch" },
      meta: { issues: validatedJson.error.issues.length },
    });
    return apiError("AI provider returned an unexpected shape", 502);
  }

  // Citation-coverage guard: drop hallucinated name / dose tokens that
  // are not actually present in the user's original text.
  const guarded: MedicationExtractionResult = applyCitationGuard(
    validatedJson.data,
    text,
  );

  // Bump the day's spend ledger so the daily budget gate stays in sync.
  await recordSpend({
    userId,
    tokens: completion.result.tokensUsed ?? 0,
    dateKey: buildDateKey(),
  });

  annotate({
    action: { name: "medications.extract.ok" },
    meta: {
      provider: completion.workingProvider.providerType,
      tokens: completion.result.tokensUsed ?? null,
      filledFieldCount: Object.keys(guarded).length,
    },
  });

  return apiSuccess(guarded);
}

export const POST = apiHandler(handleExtract);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
