/**
 * v1.18.7 — batched per-metric status generation.
 *
 * A warm cycle on a fully instrumented account used to fire SEVEN
 * specialised `runStatusCompletion` calls — blood-pressure / weight / pulse /
 * bmi / mood / medication-compliance / general — each rebuilding its own
 * graded snapshot and re-analysing measurement rows the comprehensive
 * briefing already covered. This generator collapses those seven warm calls
 * into ONE:
 *
 *   1. Run each card's `prepare<Metric>StatusForUser` (snapshot build + cache
 *      read + read-only miss + content-hash gate — NO provider call). Cards
 *      that resolve without the LLM (`served`) are returned as-is; the hash
 *      gate still short-circuits unchanged data per metric, so a quiet cycle
 *      makes no call at all.
 *   2. Collect the `pending` cards, compose ONE prompt for
 *      `{ perMetric: { ... } }` (only the metrics with data — absent metrics
 *      are omitted, never fabricated), and run ONE completion with one
 *      JSON-correction retry.
 *   3. Fan each returned summary back into that metric's `finalize`, which
 *      stores the SAME per-metric status note the standalone
 *      generator wrote — so the card read path is unchanged.
 *
 * Graceful degradation (audit requirement): any metric the batch omits, or
 * every metric when the batch call fails outright, falls back to its own
 * single-card path (`runPreparedStatusCard`). The cycle never crashes on a
 * partial or failed batch.
 */
import { prepareBloodPressureStatusForUser } from "@/lib/insights/blood-pressure-status";
import { prepareWeightStatusForUser } from "@/lib/insights/weight-status";
import { preparePulseStatusForUser } from "@/lib/insights/pulse-status";
import { prepareBmiStatusForUser } from "@/lib/insights/bmi-status";
import { prepareMoodStatusForUser } from "@/lib/insights/mood-status";
import { prepareMedicationComplianceStatusForUser } from "@/lib/insights/medication-compliance-status";
import { prepareGeneralStatusForUser } from "@/lib/insights/general-status";
import {
  runPreparedStatusCard,
  type PendingStatusCard,
  type PreparedStatusCard,
  type StatusCardResult,
} from "@/lib/insights/status-card-generation";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import {
  stripJsonFences,
  type SupportedLocale,
} from "@/lib/insights/status-shared";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import {
  buildStatusBatchUserPrompt,
  getStatusBatchSystemPrompt,
  STATUS_BATCH_KEY_BY_METRIC,
} from "@/lib/ai/prompts/status-batch";
import type { Locale } from "@/lib/i18n/config";
import { annotate } from "@/lib/logging/context";
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";

/** The seven specialised prepares, in the warm order the cron used. */
const PREPARES: ReadonlyArray<
  (
    userId: string,
    options: { locale: SupportedLocale; force?: boolean },
  ) => Promise<PreparedStatusCard>
> = [
  prepareBloodPressureStatusForUser,
  preparePulseStatusForUser,
  prepareWeightStatusForUser,
  prepareBmiStatusForUser,
  prepareMoodStatusForUser,
  prepareMedicationComplianceStatusForUser,
  prepareGeneralStatusForUser,
];

export interface StatusBatchResult {
  /** Cards resolved without the LLM (cache hit / unchanged / no provider). */
  served: number;
  /** Metrics whose assessment came from the single batched provider call. */
  batched: number;
  /** Metrics that fell back to a single-card call (omitted by the batch, or
   *  the batch failed). */
  fellBack: number;
  /**
   * Of `fellBack`, the metrics whose own single-card call came back with a
   * model-written assessment. The rest served their deterministic fallback:
   * no provider, a failed or cooling-down provider, or a screened reply.
   * `batched + fellBackAnswered` is what a warm pass may call warmed (#1384);
   * `fellBack` alone counted a night of six failed calls as six assessments.
   */
  fellBackAnswered: number;
  /** True when the one batched provider call was issued. */
  batchCallMade: boolean;
}

/**
 * Whether a single-card run ended in a model-written assessment: the persisted
 * shape is the only one with a provider and no cache flag. The no-key, the
 * timeout / error stub and the screened fallback all carry `cached: true`.
 */
function modelAnswered(result: StatusCardResult): boolean {
  return result.hasProvider === true && result.cached === false;
}

/** Pull `perMetric` out of a (possibly fenced) model completion. */
function parsePerMetric(content: string): Record<string, string> | null {
  const tryParse = (raw: string): Record<string, string> | null => {
    try {
      const parsed = JSON.parse(raw) as { perMetric?: unknown };
      if (parsed && typeof parsed.perMetric === "object" && parsed.perMetric) {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(
          parsed.perMetric as Record<string, unknown>,
        )) {
          if (typeof value === "string" && value.trim().length > 0) {
            out[key] = value;
          }
        }
        return out;
      }
    } catch {
      // not parseable as-is
    }
    return null;
  };
  return tryParse(content) ?? tryParse(stripJsonFences(content));
}

/**
 * Generate the seven specialised status assessments for one user with a
 * SINGLE batched provider call. The public per-card generators stay the
 * single-card entry; this is what the warm passes (nightly cron + forced
 * warm) call so the seven warm calls collapse into one.
 */
export async function generateStatusBatchForUser(
  userId: string,
  options: { locale: SupportedLocale; force?: boolean },
): Promise<StatusBatchResult> {
  const result: StatusBatchResult = {
    served: 0,
    batched: 0,
    fellBack: 0,
    fellBackAnswered: 0,
    batchCallMade: false,
  };

  // The capability before any snapshot is built: someone whose status notes
  // are unavailable (switch, AI analysis off, no provider, consent withdrawn)
  // costs one capability read, not seven snapshot builds. The chokepoint
  // re-checks it at the wire.
  const capability = await aiCapabilityForJob(userId, "statusText");
  if (!capability.available) {
    annotate({
      action: { name: "insights.status.batch.skipped" },
      meta: { reason: capability.reason },
    });
    return result;
  }

  // Build every card's snapshot once. A prepare that throws must not abort
  // the whole batch — that one metric is simply skipped this cycle.
  const prepared = await Promise.all(
    PREPARES.map(async (prepare) => {
      try {
        return await prepare(userId, {
          locale: options.locale,
          force: options.force,
        });
      } catch {
        return null;
      }
    }),
  );

  const pending: PendingStatusCard[] = [];
  for (const card of prepared) {
    if (card === null) continue;
    if (card.phase === "served") {
      result.served++;
    } else {
      pending.push(card);
    }
  }

  if (pending.length === 0) {
    annotate({
      action: { name: "insights.status.batch" },
      meta: { served: result.served, batched: 0, fell_back: 0 },
    });
    return result;
  }

  // One metric still needing the LLM is not worth a batch envelope — run it
  // through its own single-card path (identical persisted result).
  if (pending.length === 1) {
    if (modelAnswered(await runPreparedStatusCard(pending[0]))) {
      result.fellBackAnswered++;
    }
    result.fellBack++;
    annotate({
      action: { name: "insights.status.batch" },
      meta: {
        served: result.served,
        batched: 0,
        fell_back: 1,
        fell_back_answered: result.fellBackAnswered,
        single: true,
      },
    });
    return result;
  }

  const sections = pending.map((card) => ({
    key: STATUS_BATCH_KEY_BY_METRIC[card.metric] ?? card.metric,
    userPrompt: card.userPrompt,
  }));
  const presentKeys = sections.map((s) => s.key);
  const systemPrompt = getStatusBatchSystemPrompt(
    options.locale as Locale,
    presentKeys,
  );
  const userPrompt = buildStatusBatchUserPrompt(sections);

  // ONE provider call for every pending metric. The cards run a touch warmer
  // at 0.45 individually; the batch budget pins the same temperature and a
  // token ceiling sized for up to seven short summaries.
  let outcome = await runStatusCompletion({
    userId,
    cacheAction: "insights.status-batch",
    capability: "statusText",
    systemPrompt,
    userPrompt,
    temperature: AI_BUDGETS.statusBatch.temperature,
    maxTokens: AI_BUDGETS.statusBatch.maxTokens,
  });

  // No provider / no consent — every pending card serves its own no-key
  // result. No fallback call is needed (the prepared `noProvider` result is
  // already computed); count them as fallbacks since none was batched.
  if (outcome.kind === "none") {
    // Every pending card would also resolve to its no-key result on its own
    // path; count them as fallbacks without re-issuing a doomed completion.
    result.fellBack += pending.length;
    annotate({
      action: { name: "insights.status.batch" },
      meta: {
        served: result.served,
        batched: 0,
        fell_back: pending.length,
        reason: "no-provider",
      },
    });
    return result;
  }

  result.batchCallMade = true;
  let perMetric: Record<string, string> | null = null;
  if (outcome.kind === "ok") {
    perMetric = parsePerMetric(outcome.content);
    // One JSON-correction retry before declaring the batch a miss — the
    // same robustness the comprehensive path now carries.
    if (perMetric === null) {
      annotate({ action: { name: "insights.status.batch.json_retry" } });
      const retry = await runStatusCompletion({
        userId,
        cacheAction: "insights.status-batch",
        capability: "statusText",
        systemPrompt,
        userPrompt: `${userPrompt}\n\nYour previous response was not valid JSON matching { "perMetric": { ... } }. Reply with that JSON object ONLY — no prose, no markdown fences.`,
        temperature: AI_BUDGETS.statusBatch.temperature,
        maxTokens: AI_BUDGETS.statusBatch.maxTokens,
      });
      if (retry.kind === "ok") {
        outcome = retry;
        perMetric = parsePerMetric(retry.content);
      }
    }
  }

  // Fan the batched response back into each metric's persist closure. A
  // metric the batch covered with a real summary is finalized through the
  // SAME cache row the standalone generator wrote; a metric the batch omitted
  // (or a total batch failure) falls back to its single-card path so it still
  // gets a real assessment rather than going dark.
  const ok = outcome.kind === "ok";
  const fanOuts = pending.map(async (card) => {
    const key = STATUS_BATCH_KEY_BY_METRIC[card.metric] ?? card.metric;
    const summary = ok && perMetric ? perMetric[key] : undefined;
    if (ok && summary) {
      // Wrap the per-metric string into the `{ "summary": ... }` envelope
      // each card's `finalize` parses (it runs `normalizeSummaryText` +
      // chart-token scrub + persists the SAME cache row the standalone
      // generator wrote).
      await card.finalize({
        content: JSON.stringify({ summary }),
        providerType: outcome.kind === "ok" ? outcome.providerType : "unknown",
        model: outcome.kind === "ok" ? outcome.model : "unknown",
        tokensUsed: outcome.kind === "ok" ? outcome.tokensUsed : null,
      });
      return "batched" as const;
    }
    // Batch missed this metric (omitted key, or timeout/error/invalid-json):
    // fall back to the single-card path. On a batch timeout/error this writes
    // the per-card negative stub via the card's own `timeout`.
    return modelAnswered(await runPreparedStatusCard(card))
      ? ("fellBackAnswered" as const)
      : ("fellBack" as const);
  });

  const outcomes = await Promise.all(fanOuts);
  for (const o of outcomes) {
    if (o === "batched") {
      result.batched++;
      continue;
    }
    result.fellBack++;
    if (o === "fellBackAnswered") result.fellBackAnswered++;
  }

  annotate({
    action: { name: "insights.status.batch" },
    meta: {
      served: result.served,
      batched: result.batched,
      fell_back: result.fellBack,
      fell_back_answered: result.fellBackAnswered,
      pending: pending.length,
    },
  });
  return result;
}
