/**
 * How long a job's model work can take at most.
 *
 * Every model call has the record owner's response timeout to itself
 * (`User.aiResponseTimeoutSeconds`, up to `AI_RESPONSE_TIMEOUT_MAX_SECONDS`),
 * and the work a job does is a known number of calls in a row behind an outer
 * bound. pg-boss fails and retries a job that runs past its expiry, and it
 * does not stop the handler, so an expiry below that work lets a retry run
 * beside the first attempt (#1274). The bounds here are what the outer aborts
 * use and what the expiries in `queue-runtime.ts` are derived from, so both
 * move together when a call count or the setting's ceiling does.
 *
 * No server import: the queue modules that carry an expiry into a send read
 * these without loading a generator.
 */
import {
  AI_BUDGETS,
  COMPREHENSIVE_MODEL_CALLS,
  STATUS_MODEL_CALLS,
} from "@/lib/ai/ai-budgets";
import {
  AI_RESPONSE_TIMEOUT_MAX_SECONDS,
  resolveEffectiveTimeoutMs,
} from "@/lib/ai/effective-timeout";

const AI_RESPONSE_TIMEOUT_MAX_MS = AI_RESPONSE_TIMEOUT_MAX_SECONDS * 1000;

/**
 * Room inside a comprehensive warm for what runs around its calls: feature
 * extraction, prompt assembly, the cache write.
 */
const COMPREHENSIVE_WARM_HEADROOM_MS = 30_000;

/** The longest comprehensive generation the largest setting allows. */
export const COMPREHENSIVE_WARM_CEILING_MS =
  AI_RESPONSE_TIMEOUT_MAX_MS * COMPREHENSIVE_MODEL_CALLS +
  COMPREHENSIVE_WARM_HEADROOM_MS;

/**
 * Outer-abort budget (ms) for one comprehensive generation run out of band
 * (the nightly warm, the forced warm, the morning refresh): the account's
 * per-call timeout times the calls one generation may make, plus headroom,
 * clamped to the ceiling. A bound of one call plus headroom cut a local model
 * that needs 300 s per answer at 630 s, in the middle of its corrective retry,
 * however high the setting stood (#1274).
 */
export function comprehensiveWarmBudgetMs(
  aiResponseTimeoutSeconds: number | null | undefined,
): number {
  const effectiveTimeoutMs = resolveEffectiveTimeoutMs(
    aiResponseTimeoutSeconds,
    AI_BUDGETS.comprehensive.timeoutMs,
  );
  return Math.min(
    effectiveTimeoutMs * COMPREHENSIVE_MODEL_CALLS +
      COMPREHENSIVE_WARM_HEADROOM_MS,
    COMPREHENSIVE_WARM_CEILING_MS,
  );
}

/**
 * The longest one completion takes at the largest setting, as the clients run
 * it: the call and the one repeat the Local and gateway clients send when a
 * thinking model answered with reasoning alone (`STATUS_MODEL_CALLS`), each
 * at the full timeout. A document read's call and its corrective retry are
 * two completions; a status run (`runStatusCompletion`) is one.
 */
export const COMPLETION_CEILING_MS =
  AI_RESPONSE_TIMEOUT_MAX_MS * STATUS_MODEL_CALLS;

/**
 * Room a job's expiry leaves on top of its model work for what the handler
 * does around it: reading the record, building the prompt, persisting.
 */
export const JOB_MODEL_HEADROOM_SECONDS = 120;

/** A job expiry (seconds) that sits above `modelMs` of model work. */
export function expireAboveModelTime(modelMs: number): number {
  return Math.ceil(modelMs / 1000) + JOB_MODEL_HEADROOM_SECONDS;
}
