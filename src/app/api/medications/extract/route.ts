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
 *   2. requireAiCapability("medicationExtract") — the operator's "Reading
 *      documents" switch (and the master), provider-work authority for the
 *      record, a configured provider (503 `ai.provider.none` otherwise; the
 *      status predates the envelope and stays until no shipped client reads
 *      it), and a document-class consent receipt: free-text medication input
 *      is health data, and any provider that leaves the machine needs one.
 *   3. checkRateLimit(...)                 — 10 requests / 5 min / user.
 *   4. resolveProviderChain()              — fall back through providers,
 *      then `assertAiEgress` re-checks the capability for exactly that chain
 *      immediately before anything is sent.
 *   5. reserveBudget(resolveDailyCap(chain)) — atomic daily token ceiling,
 *      capped against the COST OWNER: a self-hoster on their own key or a
 *      local model is measured against the user-plan ceiling, not the
 *      operator's. Runs AFTER the chain resolves because the cap depends
 *      on which credential would actually pay for the call.
 *   6. runRawCompletionWithFallback()      — same machinery the Coach
 *      uses; structured-output is enforced via JSON.parse + Zod here
 *      rather than via the strict-schema wrapper.
 *   7. applyCitationGuard()                — drop hallucinated name/dose.
 *   8. reconcileSpend()                    — settle the reservation against
 *      the provider's reported count on EVERY exit path, refunding when
 *      nothing was generated.
 *
 * Response: `{ data: MedicationExtractionResult, error: null }`. Every
 * field on the result is optional; the wizard is the merge target.
 */

import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { assertAiEgress } from "@/lib/ai/capabilities/egress";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import {
  AiUnavailableError,
  type NoProviderRefusal,
} from "@/lib/ai/capabilities/refusal";
import { AI_PROVIDER_NONE_ERROR_CODE } from "@/lib/ai/capabilities/types";

import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { spentOnFailure } from "@/lib/ai/reasoning/answerless";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import { singleUserTurn } from "@/lib/ai/types";

import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import {
  applyCitationGuard,
  buildMedicationExtractionPrompt,
  medicationExtractionSchema,
  type MedicationExtractionResult,
} from "@/lib/ai/coach/medication-extract-prompt";
import { locales } from "@/lib/i18n/config";

/**
 * How the extractor refuses with no provider. 503 predates the capability
 * envelope; it stays until no shipped client is known to branch on it, and the
 * code says what it means either way.
 */
const MEDICATION_EXTRACT_NO_PROVIDER: NoProviderRefusal = {
  errorCode: AI_PROVIDER_NONE_ERROR_CODE,
  status: 503,
};

/** The budget refusal's code; the same string the body always carried. */
const MEDICATION_EXTRACT_BUDGET_CODE = "coach.budget.exceeded";

/** Hard cap on the free-text payload; mirrors `coachChatRequestSchema.message`. */
const MAX_TEXT_LENGTH = 2000;

/**
 * Output ceiling for the extraction reply — a single small JSON object. Also
 * the output half of the budget reservation estimate.
 */
const MAX_OUTPUT_TOKENS = 600;

const requestSchema = z
  .object({
    text: z.string().min(1).max(MAX_TEXT_LENGTH),
    /** Optional UI locale; informational hint for the model. */
    locale: z.enum(locales).optional(),
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
  })
  .strict();

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
  // Medication text extraction is its own capability under the operator's
  // "Reading documents" switch. When it is closed the wizard keeps its
  // manual path; nothing here is data the wizard needs.
  await requireAiCapability("medicationExtract", {
    noProvider: MEDICATION_EXTRACT_NO_PROVIDER,
  });

  const userId = auth.user.id;

  // Body parse + Zod validation.
  const validated = await parseJsonBody(request, requestSchema, {
    maxBytes: 16 * 1024,
    onInvalid: (error) => {
      annotate({
        action: { name: "medications.extract.invalid" },
        meta: { issues: error.issues.length },
      });
    },
  });
  if (!validated.ok) return validated.error;

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

  // Resolve the same provider chain the Coach uses. If the user has no
  // provider configured AND the operator has not seeded an admin key,
  // surface a structured 503 — the wizard hides the overlay.
  const chain = await resolveProviderChain(userId);
  if (chain.length === 0) {
    const legacy = await resolveProvider(userId);
    if (legacy.type === "none") {
      annotate({ action: { name: "medications.extract.no-provider" } });
      throw new AiUnavailableError(
        "medicationExtract",
        "no_provider",
        null,
        MEDICATION_EXTRACT_NO_PROVIDER,
      );
    }
    chain.push({ providerType: "admin-openai", instance: legacy });
  }

  // The wire. The runner may cascade through every entry, so each one is
  // named: any entry that leaves the machine needs a document-class consent
  // receipt, and a switch turned off since the gate above answered stops the
  // call here.
  await assertAiEgress(
    "medicationExtract",
    userId,
    chain.map((entry) => entry.providerType),
  );

  // The account's own today: "tomorrow" in a description means the
  // person's tomorrow, and the same key is the budget day below.
  const accountToday = await buildDateKey(userId);
  const today = todayOverride ?? accountToday;
  const { systemPrompt, userPrompt } = buildMedicationExtractionPrompt({
    text,
    today,
    locale,
  });

  // Atomically reserve the day's budget BEFORE the provider call, against the
  // cost owner's ceiling: the operator's only when the chain's primary is the
  // operator's own credential, the user-plan ceiling for every other chain.
  const dateKey = accountToday;
  const estimatedTokens =
    MAX_OUTPUT_TOKENS +
    Math.ceil((systemPrompt.length + userPrompt.length) / 4);
  const reservation = await reserveBudget(
    userId,
    estimatedTokens,
    dateKey,
    resolveDailyCap(chain),
    resolveCostOwner(chain),
    "coach",
  );
  if (!reservation.allowed) {
    annotate({
      action: { name: "medications.extract.budget-exceeded" },
      meta: { totalAfter: reservation.totalAfter },
    });
    return apiError(MEDICATION_EXTRACT_BUDGET_CODE, 429, {
      errorCode: MEDICATION_EXTRACT_BUDGET_CODE,
    });
  }

  let completion;
  try {
    completion = await runRawCompletionWithFallback({
      surface: "coach",
      userId,
      providers: chain,
      params: singleUserTurn({
        system: systemPrompt,
        user: userPrompt,
        // A deterministic field extractor, not a creative rephrase.
        temperature: 0.1,
        // One small JSON object; well over the largest seen on 2k chars.
        maxTokens: MAX_OUTPUT_TOKENS,
        // Parsed with `parseModelJson` (JSON.parse) below — opt the OpenAI /
        // Codex chains into their strict JSON-object mode (gated on this flag).
        responseFormat: "json",
      }),
    });
  } catch (err) {
    // Nothing was generated — refund the reservation rather than bill an
    // invented figure, keeping only what the failed hops reported spending
    // (#1279). Best-effort: a failed refund must not mask the 503.
    await reconcileSpend(
      userId,
      reservation.reserved,
      spentOnFailure(err),
      dateKey,
      0,
      { servedBy: null, reservedOwner: reservation.owner },
    ).catch(() => {});
    if (err instanceof AllProvidersFailedError) {
      annotate({
        action: { name: "medications.extract.provider-failed" },
        meta: { attempts: err.attempts.length },
      });
      return apiError("AI provider unavailable", 503);
    }
    throw err;
  }

  // What the provider reported, plus (#1279) what the hops that failed before
  // it spent; for the unusable-reply branches too, since those tokens were
  // burned upstream. No count falls back to the reservation, never to zero.
  const actualTokens =
    (completion.result.tokensUsed ?? reservation.reserved) +
    completion.tokensSpent;
  await reconcileSpend(userId, reservation.reserved, actualTokens, dateKey, 0, {
    servedBy: completion.workingProvider.providerType,
    reservedOwner: reservation.owner,
  });

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
