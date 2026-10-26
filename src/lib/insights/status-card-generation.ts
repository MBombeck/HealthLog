/**
 * v1.18.7 — the shared "prepare → run → finalize" contract for the
 * seven specialised per-metric status cards.
 *
 * Before this, every `*-status.ts` generator was a single monolithic
 * function: cache-read → read-only miss → snapshot build → content-hash
 * gate → ONE `runStatusCompletion` → persist. A fully instrumented account
 * fired seven of those LLM round-trips per warm cycle, each re-analysing the
 * same measurement rows the comprehensive briefing already covered.
 *
 * The fix splits each generator at the LLM boundary:
 *
 *   prepare<Metric>StatusForUser(...)  → PreparedStatusCard
 *     runs everything up to (but not including) the provider call. Either it
 *     resolves to a finished `served` result (a cache hit, a read-only miss,
 *     an unchanged-data refresh, or no provider / no consent — every shape
 *     that never needed the LLM), or it returns a `pending` descriptor: the
 *     built prompts + snapshot hash + a `finalize(summary)` closure that
 *     persists exactly the cache row the old code wrote.
 *
 *   generate<Metric>StatusForUser(...)  (the unchanged public entry)
 *     calls prepare, and on `pending` runs ONE `runStatusCompletion` and
 *     finalizes — i.e. the single-card path is byte-for-byte the old
 *     behaviour, so a lone card visit still costs exactly one call and the
 *     graceful fallback is preserved.
 *
 *   generateStatusBatchForUser(...)  (status-batch.ts)
 *     calls all seven prepares, collects the `pending` ones, sends ONE
 *     prompt for `{ perMetric: { ... } }`, and fans each returned summary
 *     into that metric's `finalize` — so the warm passes pay one call for
 *     the whole set. A metric the batch omits or that the batch call fails
 *     for falls back to its own single-card path, never crashing the cycle.
 *
 * The cache + read contract is untouched: `finalize` persists the SAME
 * status note (`persistStatusInsight`, or the per-medication items
 * shape via a custom closure) the standalone generator wrote, so every card
 * keeps reading per-metric results with the same keys.
 */
import {
  runStatusCompletion,
  type StatusProviderResult,
} from "@/lib/insights/status-provider";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";

/**
 * The public return shape every standard `*-status.ts` generator shares.
 * (Medication-compliance widens this with `summary` + `medications`; it
 * supplies its own result objects through the same `finalize`/`served`
 * channel, so the generic batch loop treats it uniformly.)
 */
export interface StatusCardResult {
  hasProvider: boolean;
  text?: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  revalidating?: boolean;
  // Medication-compliance carries extra fields; kept open so its richer
  // result flows through the shared union without a separate type.
  [extra: string]: unknown;
}

/**
 * A status generation that still needs the provider. The `finalize` /
 * `timeout` closures own the persist + the public result shape, so the batch
 * loop never has to know a metric's snapshot internals.
 */
export interface PendingStatusCard {
  phase: "pending";
  /** The InsightStatus scope (`blood-pressure`, `weight`, …). */
  metric: string;
  userId: string;
  /** `insights.<metric>-status.<locale>` — the consent gate / run key. */
  cacheAction: string;
  systemPrompt: string;
  userPrompt: string;
  /** Snapshot fingerprint — persisted so the next run's hash gate can skip. */
  snapshotHash?: string;
  /** Per-card sampling temperature (the cards run a touch warmer at 0.45). */
  temperature: number;
  /**
   * The answer budget for the single-card call; `AI_BUDGETS.status` when
   * omitted. The archetype cards (generic metric, biomarker) compose a longer
   * prompt and pass `AI_BUDGETS.statusArchetype`.
   */
  maxTokens?: number;
  /**
   * The deterministic no-key / no-consent result. The provider call returns
   * `{ kind: "none" }` for both, and the prepare step already knows the
   * metric's no-key fallback text, so it precomputes the result rather than
   * re-deriving it here.
   */
  noProvider: StatusCardResult;
  /**
   * Build the success result + persist the cache row from the model's raw
   * completion content (the `{ "summary": … }` envelope). Returns the
   * generator's public result.
   */
  finalize: (outcome: {
    content: string;
    providerType: string;
    model: string;
    tokensUsed: number | null;
  }) => Promise<StatusCardResult>;
  /**
   * Build the timeout / error fallback result (serves the no-key text for
   * this render, writes the short-TTL negative stub, persists no assessment).
   */
  timeout: (reason: "timeout" | "error") => StatusCardResult;
}

/** A status generation that resolved without ever needing the provider. */
export interface ServedStatusCard {
  phase: "served";
  result: StatusCardResult;
}

export type PreparedStatusCard = ServedStatusCard | PendingStatusCard;

/**
 * Single-card path: drive a prepared card through its own provider call.
 * This is the exact tail every `*-status.ts` generator used to inline, so
 * the standalone generators keep their one-call-per-metric behaviour and
 * their existing tests stay green.
 */
export async function runPreparedStatusCard(
  prepared: PreparedStatusCard,
): Promise<StatusCardResult> {
  if (prepared.phase === "served") return prepared.result;

  const outcome: StatusProviderResult = await runStatusCompletion({
    userId: prepared.userId,
    cacheAction: prepared.cacheAction,
    capability: "statusText",
    systemPrompt: prepared.systemPrompt,
    userPrompt: prepared.userPrompt,
    temperature: prepared.temperature,
    maxTokens: prepared.maxTokens ?? AI_BUDGETS.status.maxTokens,
  });

  if (outcome.kind === "none") {
    // No provider / no consent — serve the precomputed no-key result. NOT
    // `timeout` (that would write a negative stub for a provider that simply
    // isn't configured).
    return prepared.noProvider;
  }
  if (outcome.kind === "timeout" || outcome.kind === "error") {
    return prepared.timeout(outcome.kind);
  }
  return prepared.finalize({
    content: outcome.content,
    providerType: outcome.providerType,
    model: outcome.model,
    tokensUsed: outcome.tokensUsed,
  });
}
