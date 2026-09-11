/**
 * v1.16.0 — clarifying questions for the self-context questionnaire.
 *
 * After the user saves Settings → AI → "About me", the server derives
 * up to 3 short follow-up questions that would best complete the
 * picture for the Coach, and persists them encrypted
 * (`UserHealthProfile.pendingQuestionsEncrypted`). The Coach composer
 * renders them as tappable suggestion chips; answering or dismissing a
 * chip removes it.
 *
 * Two paths, gated in order:
 *   1. AI path — only when the user has a working provider
 *      (`hasAnyConfiguredProvider`), an active consent receipt covers
 *      the egress, AND the daily Coach token budget is not exhausted.
 *      One single-shot completion (no fallback chain — this is a
 *      nicety, not a core flow); spend rides the same per-day ledger
 *      the Coach uses.
 *   2. Deterministic path — two static completion hints for the first
 *      two unanswered fields, localised through the server translator.
 *      Also the landing spot for every AI-path failure (no provider,
 *      consent missing, budget gone, model error, unparseable output).
 *
 * The prompt carries the FULL Coach snapshot, so this is a genuine PHI
 * egress and it is gated exactly like every other Coach surface: a chain
 * that could reach the operator's server-managed credential requires an
 * active `ai_coach` / `ai_full` receipt. The gate is SKIP-shaped, not
 * throw-shaped — a missing receipt lands on the deterministic hints, which
 * is what the caller (`PUT /api/coach/about-me`) already expects for every
 * other AI-path miss.
 *
 * Server-only — reads `@/lib/db` through the provider resolver.
 */
import {
  hasAnyConfiguredProvider,
  resolveProvider,
  resolveProviderChain,
} from "@/lib/ai/provider";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import {
  chainRequiresServerManagedConsent,
  hasActiveConsentForSurface,
} from "@/lib/ai/consent-guard";
import { singleUserTurn } from "@/lib/ai/types";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import {
  clampPendingQuestions,
  type SelfContext,
} from "@/lib/ai/coach/about-me";
import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import {
  defaultLocale,
  locales,
  localeLanguageNames as LANGUAGE_NAMES,
} from "@/lib/i18n/config";
import { annotate } from "@/lib/logging/context";
import {
  DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
  type HealthProfileAiSection,
} from "@/lib/validations/health-profile-facts";

/** Token ceiling for the single-shot questions completion. */
const QUESTIONS_MAX_TOKENS = 300;
const QUESTION_SECTIONS = [
  "CONDITIONS",
  "COACH_FOCUS",
  "ALLERGIES",
  "ABOUT_ME",
] as const satisfies readonly HealthProfileAiSection[];

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * Deterministic fallback: completion hints for the first two unanswered
 * fields, in a fixed priority order (conditions → focus → allergies →
 * free text). Fully answered questionnaires get no hints — there is
 * nothing left to complete.
 */
export function buildFallbackQuestions(
  ctx: SelfContext,
  locale: string | null | undefined,
  includedSections: readonly HealthProfileAiSection[] = DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
): string[] {
  const included = new Set(includedSections);
  const t = getServerTranslator(resolveLocale(locale)).t;
  const hints: string[] = [];
  if (included.has("CONDITIONS") && !ctx.conditions) {
    hints.push(t("coachNudges.questionConditions"));
  }
  if (included.has("COACH_FOCUS") && !ctx.coachFocus) {
    hints.push(t("coachNudges.questionFocus"));
  }
  if (included.has("ALLERGIES") && !ctx.allergies) {
    hints.push(t("coachNudges.questionAllergies"));
  }
  if (included.has("ABOUT_ME") && !ctx.aboutMe) {
    hints.push(t("coachNudges.questionAboutMe"));
  }
  return hints.slice(0, 2);
}

/**
 * Extract a string[] from a model reply that should be a JSON array.
 * Tolerates code fences and prose around the array; everything else
 * yields `[]` so the caller falls back deterministically.
 */
export function parseQuestionsReply(content: string): string[] {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    return clampPendingQuestions(JSON.parse(content.slice(start, end + 1)));
  } catch {
    return [];
  }
}

export function buildPrompts(
  ctx: SelfContext,
  locale: Locale,
  snapshotJson?: string | null,
  includedSections: readonly HealthProfileAiSection[] = DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
): { systemPrompt: string; userPrompt: string } {
  const language = LANGUAGE_NAMES[locale];
  const systemPrompt = `You help complete a health-app user's self-description for their AI health coach. Based on what the user has already shared — and on the health-data snapshot of what they track in the app — write AT MOST 3 short, specific follow-up questions that would best complete the included fields listed below. Omitted fields are excluded by the user and must never be requested. Prefer questions grounded in the user's own data and stated focus over generic ones. Never ask for anything already answered. Never ask for a diagnosis. Write the questions in ${language}, addressed informally to the user. Reply with ONLY a JSON array of strings — no prose, no code fences.`;
  const included = new Set(includedSections);
  const fieldLines: string[] = [];
  if (included.has("CONDITIONS")) {
    fieldLines.push(`conditions: ${ctx.conditions ?? "(not answered)"}`);
  }
  if (included.has("ALLERGIES")) {
    fieldLines.push(
      `allergies/intolerances: ${ctx.allergies ?? "(not answered)"}`,
    );
  }
  if (included.has("COACH_FOCUS")) {
    fieldLines.push(`coach focus: ${ctx.coachFocus ?? "(not answered)"}`);
  }
  if (included.has("ABOUT_ME")) {
    fieldLines.push(`free text: ${ctx.aboutMe ?? "(not answered)"}`);
  }
  const userPrompt = snapshotJson
    ? `${fieldLines.join("\n")}\n\nHEALTH DATA SNAPSHOT\n${snapshotJson}`
    : fieldLines.join("\n");
  return { systemPrompt, userPrompt };
}

/**
 * Resolve the chain that will serve this generation, so the consent gate and
 * the daily cap both see the SAME provider set the call will actually use.
 * Mirrors `resolveStatusChain` in `@/lib/insights/status-provider`: the chain
 * first, then the legacy single provider tagged `admin-openai` — the
 * conservative tag, because `resolveProvider`'s admin fallback returns a bare
 * `OpenAIClient` that is indistinguishable from a BYOK key at the instance
 * level. Tagging it as server-managed makes the gate fail closed. Returns null
 * when nothing can serve.
 */
async function resolveQuestionsChain(
  userId: string,
): Promise<ProviderChainResolved[] | null> {
  const chain = await resolveProviderChain(userId);
  if (chain.length > 0) return chain;

  const legacy = await resolveProvider(userId);
  if (legacy.type === "none") return null;
  return [{ providerType: "admin-openai", instance: legacy }];
}

/**
 * Derive the pending questions for a freshly saved self-context.
 * Never throws — every failure path lands on the deterministic
 * fallback so the PUT route stays robust.
 */
export async function deriveClarifyingQuestions(
  userId: string,
  ctx: SelfContext,
  locale: string | null | undefined,
  includedSections: readonly HealthProfileAiSection[] = DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
): Promise<{ questions: string[]; source: "ai" | "fallback" }> {
  const fallback = () => ({
    questions: buildFallbackQuestions(ctx, locale, includedSections),
    source: "fallback" as const,
  });
  const included = new Set(includedSections);
  // A free-form model reply cannot be proven not to cross into an omitted
  // field. Partial inclusion therefore stays on the closed deterministic
  // fallback; the AI path is available only when every question-bearing
  // section is included.
  if (!QUESTION_SECTIONS.every((section) => included.has(section))) {
    return fallback();
  }

  try {
    if (!(await hasAnyConfiguredProvider(userId))) return fallback();

    const chain = await resolveQuestionsChain(userId);
    if (chain === null) return fallback();

    // Consent gate — BEFORE the snapshot is built, let alone sent. This
    // prompt ships the complete Coach snapshot, so a chain that could egress
    // via the operator's server-managed credential needs an active
    // `ai_coach` / `ai_full` receipt. BYOK / local / ChatGPT-OAuth chains are
    // the user's own egress and stay ungated, matching every other surface.
    if (
      chainRequiresServerManagedConsent(chain) &&
      !(await hasActiveConsentForSurface(userId, "coach"))
    ) {
      annotate({
        action: { name: "coach.self_context.consent_required" },
        meta: { self_context_questions_source: "fallback" },
      });
      return fallback();
    }

    // Budget gate — the same per-day ledger the Coach chat enforces, via the
    // ATOMIC reserve/reconcile pair. The prior read-then-write
    // (`getDailyTokenSpend` then `recordSpend`) let two concurrent saves both
    // observe a sub-cap spend and both call the provider; the upsert-increment
    // serialises them on the row's unique key instead. The cap follows the
    // chain's cost owner, so a user on their own plan is not held to the
    // operator-cost ceiling.
    const dateKey = buildDateKey();
    const reservation = await reserveBudget(
      userId,
      QUESTIONS_MAX_TOKENS,
      dateKey,
      resolveDailyCap(chain),
      resolveCostOwner(chain),
    );
    if (!reservation.allowed) return fallback();

    const provider = chain[0].instance;
    // v1.16.6 — same snapshot the Coach chat rides; lets the model
    // ask about what the user actually tracks. Best-effort: a snapshot
    // failure must not cost the AI path, the prompt just stays
    // fields-only.
    const snapshotJson = await buildCoachSnapshot(userId)
      .then((s) => s.snapshotJson || null)
      .catch(() => null);
    const { systemPrompt, userPrompt } = buildPrompts(
      ctx,
      resolveLocale(locale),
      snapshotJson,
      includedSections,
    );

    let result;
    try {
      result = await provider.generateCompletion(
        singleUserTurn({
          system: systemPrompt,
          user: userPrompt,
          temperature: 0.4,
          maxTokens: QUESTIONS_MAX_TOKENS,
        }),
      );
    } catch (err) {
      // Reconcile the reservation down to zero actual spend before the
      // failure lands on the deterministic fallback.
      await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
        servedBy: null,
        reservedOwner: reservation.owner,
      }).catch(() => {});
      throw err;
    }

    await reconcileSpend(
      userId,
      reservation.reserved,
      result.tokensUsed ?? 0,
      dateKey,
      result.cachedInputTokens ?? 0,
      { servedBy: chain[0].providerType, reservedOwner: reservation.owner },
    ).catch(() => {});

    const questions = parseQuestionsReply(result.content);
    if (questions.length === 0) return fallback();

    annotate({
      meta: {
        self_context_questions_source: "ai",
        self_context_questions_count: questions.length,
      },
    });
    return { questions, source: "ai" };
  } catch {
    return fallback();
  }
}
