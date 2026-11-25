/**
 * The comprehensive generator's steps after its inputs are loaded: the
 * unchanged-snapshot short circuit, the model run and its JSON repair, the
 * grounding gate, the citation annotation, the outbound screen and its
 * repair, and the guarded cache write. `generateComprehensiveInsight` wires
 * them in this order.
 */
import { withBriefingGeneratedAt } from "@/lib/insights/briefing-generated-at";
import {
  findUngroundedBriefingNumbers,
  readBriefingBlock,
  buildBriefingGroundingCorrection,
} from "@/lib/ai/briefing-grounding";
import { screenInsightPayloadProse } from "@/lib/ai/safety/insight-payload-screen";
import { computeCitationCoverage } from "@/lib/ai/citation-coverage";
import { buildRetryCorrectionMessage } from "@/lib/ai/retry-correction";
import { AllProvidersFailedError } from "@/lib/ai/provider-runner";
import { chainFailureFacts } from "@/lib/insights/chain-failure-facts";
import {
  BriefingBudgetExceededError,
  runBriefingCompletion,
} from "@/lib/insights/briefing-provider";
import { invalidateUserInsights } from "@/lib/cache/invalidate";
import type { SupportedLocale } from "@/lib/insights/status-shared";
import { applyBriefingShortForm } from "@/lib/insights/briefing-short-form";
import { annotate } from "@/lib/logging/context";
import { AI_BUDGETS, resolveInsightsMaxTokens } from "@/lib/ai/ai-budgets";
import { providerFailureKind } from "@/lib/ai/failure-kind";
import { recordBriefingFailure } from "@/lib/insights/briefing-failure-marker";
import { cachedPayloadCarriesBriefing } from "@/lib/insights/briefing-payload";
import { insightsCacheWrite } from "@/lib/insights/cached-text-cipher";
import type {
  GenerateOutcome,
  GenerationContext,
} from "@/lib/insights/comprehensive-generate";
import {
  buildOutboundScreenCorrection,
  buildRerollDateKey,
  commitInsightUnderScope,
  failBeforeProvider,
  rerollBriefingParagraph,
  scopeChangedSkip,
  type BriefingReply,
  type GroundedRun,
  type ModelRun,
  type StepResult,
} from "@/lib/insights/comprehensive-support";
import {
  parseInsightReply,
  type ParsedInsight,
  type ParsedReply,
} from "@/lib/insights/insight-reply";
import {
  briefingRequiredFor,
  previousRenderableBriefing,
} from "@/lib/ai/briefing-blocks";
import { noteAiJobFailure } from "@/lib/ai/job-failure/witness";

/**
 * Try cached: on an unchanged snapshot whose cache carries a briefing, re-roll
 * the paragraph once a day or refresh the stamp, and stop. Null when the
 * generation has to run.
 */
export async function tryUnchangedSnapshot(
  ctx: GenerationContext,
): Promise<GenerateOutcome | null> {
  const {
    userId,
    locale,
    signal,
    dbUser,
    cachedText,
    effectiveTimeoutMs,
    chain,
    modeAtRead,
    features,
    promptScopeAtRead,
    aboutMe,
    snapshotHash,
    groundingExtra,
    userPrompt,
    systemPrompt,
  } = ctx;
  // The unchanged short-circuit only holds when the cached
  // payload actually carries a briefing. A grounding-stripped (or model-
  // omitted) briefing left a briefingless payload WITH a stored hash;
  // on unchanged data every subsequent warm re-stamped the timestamp and
  // the briefing never came back — a permanent silent hole. Treating the
  // briefingless cache as "not unchanged" re-runs the full generation
  // (bounded by the nightly budget bucket + forced-warm caps).
  const cachedCarriesBriefing = cachedPayloadCarriesBriefing(cachedText);
  if (
    cachedText &&
    dbUser?.insightsSnapshotHash === snapshotHash &&
    !cachedCarriesBriefing
  ) {
    annotate({
      action: { name: "insights.generate.briefingless_cache_regenerate" },
      meta: { locale },
    });
  }
  if (
    cachedText &&
    dbUser?.insightsSnapshotHash === snapshotHash &&
    cachedCarriesBriefing
  ) {
    // Findings are byte-stable, but re-roll the daily-
    // briefing PARAGRAPH once per calendar day so the prose reads fresh
    // day-over-day. Gated on `insightsBriefingRerollDate` so it costs at
    // most one extra call/day; the higher, seedless temperature varies the
    // phrasing while the structured findings are preserved verbatim from the
    // cached payload. Any miss falls through to the plain timestamp refresh.
    const todayKey = buildRerollDateKey();
    if (dbUser?.insightsBriefingRerollDate !== todayKey) {
      const rerolled = await rerollBriefingParagraph({
        userId,
        chain,
        systemPrompt,
        userPrompt,
        cachedText,
        locale,
        signals: features.signalsOfDay ?? null,
        features,
        comparison: groundingExtra,
        effectiveTimeoutMs,
        signal,
      });
      if (rerolled) {
        // The reroll rewrites content derived from the scope captured before
        // the provider call. Refuse it if either privacy mode or included
        // self-context changed in flight.
        const committed = await commitInsightUnderScope(
          userId,
          modeAtRead,
          aboutMe,
          promptScopeAtRead,
          locale,
          rerolled.providerType,
          {
            insightsCachedAt: new Date(),
            ...insightsCacheWrite(rerolled.text),
            insightsCachedLocale: locale,
            insightsBriefingRerollDate: todayKey,
          },
        );
        const skipped = scopeChangedSkip(committed, locale);
        if (skipped) return skipped;
        invalidateUserInsights(userId);
        annotate({
          action: { name: "insights.generate.briefing_rerolled" },
          meta: { locale, provider: rerolled.providerType },
        });
        return { status: "rerolled", providerType: rerolled.providerType };
      }
      // A re-roll miss still stamps the day so a persistently failing
      // provider cannot be re-driven on every page-open; the next day retries.
      // Even a timestamp-only stamp must not make a cache cleared by a scope
      // change look fresh again.
      const stamped = await commitInsightUnderScope(
        userId,
        modeAtRead,
        aboutMe,
        promptScopeAtRead,
        locale,
        null,
        {
          insightsCachedAt: new Date(),
          // The fingerprint covers the generation locale, so a matching hash
          // means the stored text is in `locale`; tag it (a pre-tag row gets
          // its label on its first unchanged night).
          insightsCachedLocale: locale,
          insightsBriefingRerollDate: todayKey,
        },
      );
      const skipped = scopeChangedSkip(stamped, locale);
      if (skipped) return skipped;
      annotate({
        action: { name: "insights.generate.skipped_unchanged" },
        meta: { locale, rerollAttempted: true },
      });
      return { status: "unchanged" };
    }
    const stamped = await commitInsightUnderScope(
      userId,
      modeAtRead,
      aboutMe,
      promptScopeAtRead,
      locale,
      null,
      {
        insightsCachedAt: new Date(),
        insightsCachedLocale: locale,
      },
    );
    const skipped = scopeChangedSkip(stamped, locale);
    if (skipped) return skipped;
    annotate({
      action: { name: "insights.generate.skipped_unchanged" },
      meta: { locale },
    });
    return { status: "unchanged" };
  }
  return null;
}

/** Run model: the generation itself, at the comprehensive temperature. */
export async function runFirstPass(
  ctx: GenerationContext,
): Promise<StepResult<{ result: BriefingReply; workingProviderType: string }>> {
  const {
    userId,
    locale,
    signal,
    effectiveTimeoutMs,
    chain,
    userPrompt,
    systemPrompt,
  } = ctx;
  let result;
  let workingProviderType: string;
  try {
    const fallback = await runBriefingCompletion({
      userId,
      chain,
      systemPrompt,
      userPrompt,
      temperature: AI_BUDGETS.comprehensive.temperature,
      maxTokens: resolveInsightsMaxTokens(),
      // Wider upstream budget so the reasoning-heavy briefing
      // generation is not clipped at the client's 60 s default mid-stream.
      // Honours the per-user response-timeout setting.
      timeoutMs: effectiveTimeoutMs,
      signal,
      stage: "generate",
      // The briefing is one of the few background jobs that may
      // reason (medium on the person's own provider, low on the operator's,
      // never above the operator's cap, nothing when switched off). The JSON
      // and grounding retries below repair a reply and do not reason.
      reasoningJob: "daily_briefing",
    });
    result = fallback.result;
    workingProviderType = fallback.workingProvider.providerType;
  } catch (e) {
    // Over the day's token ceiling — no provider was contacted. Typed as
    // `skipped`, not `failed`: there is no upstream fault to retry against,
    // so the caller must not enqueue the 45-minute provider-failure retry or
    // hold the day provisional waiting for a briefing that will not come
    // until the ledger rolls over. No failure marker either — the ceiling is
    // an accounting outcome, not a broken generation.
    if (e instanceof BriefingBudgetExceededError) {
      annotate({
        action: { name: "insights.generate.budget_exceeded" },
        meta: { locale, stage: e.stage, totalAfter: e.totalAfter },
      });
      return { stop: { status: "skipped", reason: "budget" } };
    }
    // Make the failed generation queryable. This path used to return
    // a `failed` outcome with NO annotation, so a provider that consistently
    // failed (e.g. a codex briefing aborted by the 60 s timeout on a large
    // account) left the cached block empty AND emitted nothing the operator
    // could grep — the briefing and the insights trend narrative that share
    // the block stayed blank with no signal. No cache row is written, so the
    // next warm / visit retries; the wider `timeoutMs` above is what lets that
    // retry actually land.
    const reason =
      e instanceof AllProvidersFailedError
        ? "all-providers-failed"
        : "provider-error";
    const err = e as { httpStatus?: number; message?: string };
    annotate({
      action: { name: "insights.generate.comprehensive_failed" },
      meta: {
        locale,
        reason,
        provider_status:
          typeof err.httpStatus === "number" ? err.httpStatus : null,
        provider_message: err.message?.slice(0, 240) ?? null,
      },
    });
    // Record a dated failure marker so the read path can surface a
    // discreet "couldn't refresh" hint alongside the preserved last-good
    // briefing. No cache row is written here, so `insightsCachedTextEncrypted` (the
    // last good payload) stays intact and the surface never blanks.
    void recordBriefingFailure({
      userId,
      reason,
      locale,
      httpStatus: typeof err.httpStatus === "number" ? err.httpStatus : null,
      failureKind:
        e instanceof AllProvidersFailedError
          ? (e.attempts?.[0]?.failureKind ?? null)
          : providerFailureKind(e).failure,
    });
    return { stop: { status: "failed", reason, ...chainFailureFacts(e) } };
  }
  return { next: { result, workingProviderType } };
}

/** The correction the one repair pass is sent with, by what the reply missed. */
function replyCorrection(miss: Extract<ParsedReply, { ok: false }>): string {
  return miss.reason === "invalid-json"
    ? buildRetryCorrectionMessage(
        "Response was not valid JSON",
        "The previous reply could not be parsed as a JSON object.",
      )
    : buildRetryCorrectionMessage(
        "The dailyBriefing block did not match its schema",
        `${miss.issues.join("; ")}. dailyBriefing needs a non-empty "paragraph", "keyFindings" (0-5 rows) and optional "signalsOfDay" (0-3 rows); every row carries "delta" (a string or null) and a "sourceMetric" from the listed enum.`,
      );
}

/**
 * Annotate and mark a reply that may not be stored, and stop the run. The
 * provider answered, so the job's witness saw it served and would clear the
 * briefing's entry on the AI settings card; noting the failure keeps the
 * entry, with its "Try again", until a generation is stored.
 */
function failReply(
  ctx: GenerationContext,
  miss: Extract<ParsedReply, { ok: false }>,
  providerMessage: string,
  providerType: string,
): StepResult<ModelRun> {
  const { userId, locale } = ctx;
  noteAiJobFailure("provider_error", providerType);
  annotate({
    action: { name: "insights.generate.comprehensive_failed" },
    meta: {
      locale,
      reason: miss.reason,
      provider_status: null,
      provider_message: providerMessage,
      issueCount: miss.issues.length,
    },
  });
  void recordBriefingFailure({ userId, reason: miss.reason, locale });
  return { stop: { status: "failed", reason: miss.reason } };
}

/**
 * Parse the reply and run the commit gate on it, with one corrective retry
 * when it is not JSON or its briefing cannot be rendered. A reply that still
 * misses is a failed generation: nothing is written, the marker is recorded,
 * and the nightly pass queues its retry.
 */
export async function parseOrRepairReply(
  ctx: GenerationContext,
  first: { result: BriefingReply; workingProviderType: string },
): Promise<StepResult<ModelRun>> {
  const {
    userId,
    locale,
    signal,
    effectiveTimeoutMs,
    chain,
    userPrompt,
    systemPrompt,
  } = ctx;
  const gate = {
    briefingRequired: briefingRequiredFor(ctx.features.signalsOfDay),
  };
  let { result, workingProviderType } = first;
  // Anthropic + local have no native JSON mode, so a ```json-fenced or
  // sentence-prefixed reply would otherwise fail the whole generation.
  // Strip the fence before parsing; clean JSON passes through unchanged.
  let parsed = parseInsightReply(result.content, gate);
  if (!parsed.ok) {
    // One corrective retry before declaring failure, reusing the same
    // `buildRetryCorrectionMessage` the strict insight wrapper uses next
    // door. A briefing the card could not render gets the same one pass as
    // a reply that is not JSON: it is the model's output that missed, and
    // the correction names what it missed.
    annotate({
      action: {
        name:
          parsed.reason === "invalid-json"
            ? "insights.generate.json_retry"
            : "insights.generate.briefing_schema_retry",
      },
      meta: { locale, issueCount: parsed.issues.length },
    });
    try {
      const retry = await runBriefingCompletion({
        userId,
        chain,
        systemPrompt,
        userPrompt: `${userPrompt}\n\n${replyCorrection(parsed)}`,
        temperature: AI_BUDGETS.comprehensive.temperature,
        maxTokens: resolveInsightsMaxTokens(),
        // Wider upstream budget; see the first generation call.
        // Honours the per-user response-timeout setting.
        timeoutMs: effectiveTimeoutMs,
        signal,
        stage: "json-retry",
      });
      result = retry.result;
      workingProviderType = retry.workingProvider.providerType;
    } catch (retryErr) {
      // The first pass already landed and was charged; the correction pass is
      // what the ceiling refused. Same `skipped` treatment as the first call —
      // a budget refusal is not a provider fault to retry against.
      if (retryErr instanceof BriefingBudgetExceededError) {
        annotate({
          action: { name: "insights.generate.budget_exceeded" },
          meta: {
            locale,
            stage: retryErr.stage,
            totalAfter: retryErr.totalAfter,
          },
        });
        return { stop: { status: "skipped", reason: "budget" } };
      }
      // Annotate alongside the marker so the night is greppable under the
      // same action as every other failure class.
      return failReply(
        ctx,
        parsed,
        retryErr instanceof Error
          ? retryErr.message.slice(0, 240)
          : "retry-transport-failed",
        workingProviderType,
      );
    }
    parsed = parseInsightReply(result.content, gate);
    if (!parsed.ok) {
      // Truncation-aware: a `length` finish means the token ceiling cut the
      // reply mid-string, a budget problem, not a model-quality one.
      return failReply(
        ctx,
        parsed,
        result.finishReason === "length"
          ? "response-truncated-at-token-ceiling"
          : parsed.reason === "invalid-json"
            ? "retry-also-invalid-json"
            : "retry-also-invalid-briefing",
        workingProviderType,
      );
    }
  }
  if (parsed.repairs.length > 0) {
    annotate({
      action: { name: "insights.generate.briefing_repaired" },
      meta: { locale, repairs: parsed.repairs.join(",") },
    });
  }
  return { next: { insights: parsed.insights, result, workingProviderType } };
}

/**
 * Screen: the number-grounding gate over the briefing, with one corrective
 * retry, then the previous briefing (or none) in place of an ungrounded one.
 */
export async function applyBriefingGroundingGate(
  ctx: GenerationContext,
  run: ModelRun,
): Promise<GroundedRun> {
  const {
    userId,
    locale,
    signal,
    cachedText,
    effectiveTimeoutMs,
    chain,
    features,
    groundingExtra,
    userPrompt,
    systemPrompt,
  } = ctx;
  let { insights, result, workingProviderType } = run;
  // Daily-briefing number-grounding gate. The cron +
  // force-warm path produces the same briefing the POST route does, so it
  // enforces the same cross-check: every number the briefing restates must
  // trace to a `features.signalsOfDay` figure. One corrective retry, then strip
  // the briefing rather than persist a fabricated number.
  // True when the grounding gate stripped the briefing HARD (no
  // previous-cached fallback available). Persisted as a dated marker after
  // the cache write so the read path can render the honest "briefing
  // withheld" state instead of a silent generic empty card.
  let briefingStrippedHard = false;
  {
    const signals = features.signalsOfDay ?? null;
    let retryTransportFailed = false;
    let ungrounded = findUngroundedBriefingNumbers(
      readBriefingBlock(insights),
      signals,
      features,
      groundingExtra,
    );
    if (ungrounded.length > 0) {
      annotate({
        action: { name: "insights.generate.briefing_grounding_retry" },
        meta: { locale, ungroundedCount: ungrounded.length },
      });
      try {
        const retry = await runBriefingCompletion({
          userId,
          chain,
          systemPrompt,
          userPrompt: `${userPrompt}\n\n${buildBriefingGroundingCorrection(ungrounded)}`,
          temperature: AI_BUDGETS.comprehensive.temperature,
          maxTokens: resolveInsightsMaxTokens(),
          // Wider upstream budget; see the first generation call.
          // Honours the per-user response-timeout setting.
          timeoutMs: effectiveTimeoutMs,
          signal,
          stage: "grounding-retry",
        });
        // The corrected reply passes the same commit gate as a first pass:
        // one the card could not render is no better than an ungrounded one.
        const retryParsed = parseInsightReply(retry.result.content, {
          briefingRequired: briefingRequiredFor(signals),
        });
        const retryUngrounded = retryParsed.ok
          ? findUngroundedBriefingNumbers(
              readBriefingBlock(retryParsed.insights),
              signals,
              features,
              groundingExtra,
            )
          : ungrounded;
        if (retryParsed.ok && retryUngrounded.length === 0) {
          insights = retryParsed.insights;
          result = retry.result;
          workingProviderType = retry.workingProvider.providerType;
          ungrounded = [];
        } else {
          ungrounded = retryUngrounded;
        }
      } catch {
        // Retry failed on TRANSPORT (provider outage / timeout) or on the
        // day's budget ceiling, rather than on content. Recorded for the
        // annotation only — the disposal below no longer forks on it.
        retryTransportFailed = true;
      }
    }
    if (ungrounded.length > 0 && insights && typeof insights === "object") {
      // The freshly generated briefing is DISCARDED either way — that is the
      // anti-fabrication guarantee and it is absolute. The only question left
      // is what stands in its place, and the answer does not depend on WHY the
      // retry failed.
      //
      // This used to fall back to the previous payload's briefing on a
      // transport failure but leave a hole on a content failure. The asymmetry
      // had no justification: the previous briefing passed this identical gate
      // when it was written, so it carries no fabricated figure in either
      // case, and the user never sees the rejected text either way. All the
      // hole did was cost the reader their paragraph, signals-of-day, key
      // findings and recommendations over one unverifiable number — while the
      // "briefing withheld" notice told them something had gone wrong without
      // giving them anything usable. A day-old grounded briefing beats a
      // vanished one on both paths, and the next successful run replaces it.
      // Only a previous briefing that renders may stand in.
      const fallbackBriefing = previousRenderableBriefing(cachedText);
      (insights as Record<string, unknown>).dailyBriefing = fallbackBriefing;
      briefingStrippedHard = fallbackBriefing == null;
      annotate({
        action: { name: "insights.generate.briefing_grounding_stripped" },
        meta: {
          locale,
          ungroundedCount: ungrounded.length,
          retryFailure: retryTransportFailed ? "transport" : "content",
          briefing_fallback:
            fallbackBriefing != null ? "previous-cached" : "stripped",
        },
      });
    }
  }
  return { insights, result, workingProviderType, briefingStrippedHard };
}

export function annotateCitationCoverage(
  locale: SupportedLocale,
  insights: ParsedInsight,
): void {
  // Citation coverage. This annotation is what the admin AI-quality dashboard
  // slices to track how many normative recommendations carry a curated
  // medical-reference id. It used to hang off a wrapper that had no production
  // caller, so the dashboard was reading a metric nothing emitted.
  // Observational only — an uncited normative rec is a logged warning, never a
  // reason to fail the generation.
  if (insights && typeof insights === "object") {
    const payload = insights as Record<string, unknown>;
    if (Array.isArray(payload.recommendations)) {
      // The recommendations are written in `locale`, so the normative-claim
      // bank has to be the reader's. Grading them against English alone
      // reported "no normative claims" for four of the six shipped languages.
      const coverage = computeCitationCoverage(
        { recommendations: payload.recommendations },
        locale,
      );
      annotate({
        action: { name: "insights.generate.citation_coverage" },
        meta: {
          locale,
          totalRecommendations: coverage.totalRecommendations,
          normativeRecommendations: coverage.normativeRecommendations,
          citedNormativeRecommendations: coverage.citedNormativeRecommendations,
          uncitedNormativeCount:
            coverage.uncitedNormativeRecommendationIds.length,
        },
      });
    }
  }
}

/** Screen and repair: the outbound safety screen, with one bounded repair. */
export async function screenAndRepairOutbound(
  ctx: GenerationContext,
  run: GroundedRun,
): Promise<StepResult<GroundedRun>> {
  const {
    userId,
    locale,
    signal,
    effectiveTimeoutMs,
    chain,
    features,
    groundingExtra,
    userPrompt,
    systemPrompt,
  } = ctx;
  let { insights, result, workingProviderType, briefingStrippedHard } = run;
  // Outbound safety screen over the WHOLE prose surface.
  //
  // SURFACE POLICY — WITHHOLD. This payload is generated in the background and
  // persisted as the cached insight; nobody is waiting on the turn. Unlike the
  // number-grounding gate above, a safety violation cannot be surgically
  // stripped: a dose imperative may sit in `recommendations[]`, in `summary`,
  // or in the briefing, and deleting an arbitrary field would leave a payload
  // whose remaining prose still refers to it. So the whole generation fails and
  // persists NOTHING -- the previous cached payload stays, exactly as a
  // provider outage or an unparseable response already behaves. The next run
  // regenerates from scratch.
  //
  // One bounded repair before giving up, the way the grounding gate
  // above gets one corrective retry. A withheld generation used to fail
  // outright, and the nightly pass then queued its 45-minute provider retry,
  // which asked the same model the same question and was screened again: on
  // one account that was eight wasted generations a night over a single
  // causal sentence. The repair names the contract that tripped and asks for
  // the whole object again; the repaired payload has to pass the same JSON
  // parse, the same number grounding and the same screen as a first pass, or
  // nothing is persisted, exactly as before. A screened outcome is final for
  // the caller: it is not a provider fault, so nothing retries it.
  const screened = screenInsightPayloadProse(insights, locale);
  if (screened) {
    annotate({
      action: { name: "insights.generate.outbound_blocked" },
      meta: { locale, reason: screened },
    });
    let repaired = false;
    try {
      const retry = await runBriefingCompletion({
        userId,
        chain,
        systemPrompt,
        userPrompt: `${userPrompt}\n\n${buildOutboundScreenCorrection(screened)}`,
        temperature: AI_BUDGETS.comprehensive.temperature,
        maxTokens: resolveInsightsMaxTokens(),
        timeoutMs: effectiveTimeoutMs,
        signal,
        stage: "screen-retry",
      });
      // The repaired payload passes the same commit gate as a first pass.
      const retryParsed = parseInsightReply(retry.result.content, {
        briefingRequired: briefingRequiredFor(features.signalsOfDay),
      });
      const retryUngrounded = retryParsed.ok
        ? findUngroundedBriefingNumbers(
            readBriefingBlock(retryParsed.insights),
            features.signalsOfDay ?? null,
            features,
            groundingExtra,
          )
        : [];
      if (
        retryParsed.ok &&
        retryUngrounded.length === 0 &&
        screenInsightPayloadProse(retryParsed.insights, locale) === null
      ) {
        insights = retryParsed.insights;
        result = retry.result;
        workingProviderType = retry.workingProvider.providerType;
        briefingStrippedHard = false;
        repaired = true;
      }
    } catch {
      // A transport failure or the day's budget on the repair: the first
      // pass stays withheld, nothing else changes.
    }
    annotate({
      action: { name: "insights.generate.outbound_repair" },
      meta: { locale, reason: screened, repaired },
    });
    if (!repaired) {
      void recordBriefingFailure({
        userId,
        reason: "outbound-screened",
        locale,
      });
      return { stop: { status: "failed", reason: "outbound-screened" } };
    }
  }
  return {
    next: { insights, result, workingProviderType, briefingStrippedHard },
  };
}

/** Persist: the guarded cache write and the withheld-briefing marker. */
export async function persistGeneratedInsight(
  ctx: GenerationContext,
  run: GroundedRun,
): Promise<GenerateOutcome> {
  const {
    userId,
    locale,
    signal,
    modeAtRead,
    promptScopeAtRead,
    aboutMe,
    briefingForm,
    snapshotHash,
  } = ctx;
  const { workingProviderType, briefingStrippedHard } = run;
  let { insights } = run;
  // The caller abandoned this generation (its bound fired). Bail out before
  // the cache write, annotated and marked like every other failure: an
  // abandoned generation is a real "no fresh briefing tonight" outcome.
  if (signal?.aborted) {
    return failBeforeProvider(userId, locale, "aborted");
  }

  // The short form holds its counts whatever the model wrote.
  if (briefingForm === "short") {
    insights = applyBriefingShortForm(insights);
  }

  // The payload was built under the privacy and profile scope captured before
  // the provider call. Recheck both before the write so an inclusion change
  // cannot be overwritten by stale in-flight content.
  const committed = await commitInsightUnderScope(
    userId,
    modeAtRead,
    aboutMe,
    promptScopeAtRead,
    locale,
    workingProviderType,
    {
      insightsCachedAt: new Date(),
      ...insightsCacheWrite(
        JSON.stringify(withBriefingGeneratedAt(insights, new Date())),
      ),
      insightsCachedLocale: locale,
      insightsSnapshotHash: snapshotHash,
    },
  );
  const skipped = scopeChangedSkip(committed, locale);
  if (skipped) return skipped;
  // No blanket per-status eviction here any more. The cards
  // track their own data through the ingest invalidator and their own
  // content-hash gates; a fresh comprehensive briefing does not change
  // what a per-metric card should say, and the old sweep was the reason
  // every warm had to regenerate ~45 cards across both locales.
  invalidateUserInsights(userId);

  // The generation SUCCEEDED but the grounding gate withheld the
  // briefing. Record the marker AFTER the cache write so it is newer than
  // `insightsCachedAt` and the read path surfaces "briefing withheld"
  // instead of a silent generic empty card until the next generation.
  if (briefingStrippedHard) {
    void recordBriefingFailure({
      userId,
      reason: "briefing-ungrounded",
      locale,
    });
  }

  return { status: "generated", providerType: workingProviderType };
}
