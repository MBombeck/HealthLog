/**
 * v1.41 — the no-progress brake of the Coach loop.
 *
 * A budget stops a turn that runs long; this stops one that runs in circles.
 * The next round becomes the final answer (`no_progress`) when
 *
 *   - every call of the last round repeated an earlier call of the turn (the
 *     same tool with the same arguments after normalising them);
 *   - two rounds in a row brought back nothing but misses that say nothing
 *     (`no_data`, a call that did not validate, a read that failed);
 *   - three rounds in a row read no new domain, window and period.
 *
 * A repeated call is never run again: the model gets `{ duplicateOf }` with
 * the id of the call it repeats, and the result it already holds.
 *
 * Pure: no database, no provider.
 */
import type { CoachToolResult } from "./executor";

/** Misses that tell the model nothing new about the record. */
const EMPTY_REASONS: ReadonlySet<string> = new Set([
  "no_data",
  "analyte_not_found",
  "invalid_arguments",
  "unknown_tool",
  "unsupported_metric",
  "use_get_glucose_panel",
  "use_get_medication_compliance",
  "use_get_workouts",
  "retrieval_failed",
  "no_data_unconfirmed",
  "duplicate",
]);

/** Rounds of nothing but empty misses before the brake. */
export const EMPTY_ROUNDS_LIMIT = 2;
/** Rounds without a new domain × window × period before the brake. */
export const STALE_ROUNDS_LIMIT = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sorted keys, so `{a,b}` and `{b,a}` are one call; strings trimmed and lower-cased. */
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined && value[key] !== null)
        .map((key) => [key, normalise(value[key])]),
    );
  }
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

/** The identity of a call: its name and its normalised arguments. */
export function callSignature(name: string, rawArguments: string): string {
  let parsed: unknown;
  try {
    parsed = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
  } catch {
    parsed = rawArguments.trim();
  }
  return `${name}:${JSON.stringify(normalise(parsed))}`;
}

/**
 * The stretch of the record a call reads: domain × window × period. A
 * metric call's domain is its metric; any other tool's is its name.
 */
export function callScope(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  const pick = (key: string): string | undefined =>
    typeof args?.[key] === "string" ? (args[key] as string) : undefined;
  const domain = pick("metric") ?? name;
  const second = pick("metricB");
  return [
    second ? `${domain}+${second}` : domain,
    pick("window") ?? "default",
    pick("period") ?? pick("basis") ?? "current",
  ].join("|");
}

export interface ProgressTracker {
  /**
   * The id of an earlier call of the turn this one repeats, or null. A call
   * that is not a repeat is remembered under `callId`.
   */
  duplicateOf(callId: string, signature: string): string | null;
  /** Records how one call of the current round came out. */
  record(args: {
    duplicate: boolean;
    scope: string | null;
    result: Pick<CoachToolResult, "present" | "reason"> | null;
  }): void;
  /** Closes the round; true when the next round must be the final one. */
  endRound(): boolean;
}

export function createProgressTracker(): ProgressTracker {
  const signatures = new Map<string, string>();
  const scopes = new Set<string>();
  let emptyRounds = 0;
  let staleRounds = 0;
  // The current round.
  let calls = 0;
  let duplicates = 0;
  let informative = 0;
  let newScope = false;

  return {
    duplicateOf(callId, signature) {
      const earlier = signatures.get(signature);
      if (earlier !== undefined) return earlier;
      signatures.set(signature, callId);
      return null;
    },
    record({ duplicate, scope, result }) {
      calls += 1;
      if (duplicate) duplicates += 1;
      // A call with no data result (a dialog tool) is neither empty nor news.
      if (
        result &&
        !duplicate &&
        (result.present || !EMPTY_REASONS.has(result.reason ?? ""))
      ) {
        informative += 1;
      }
      if (!result) informative += 1;
      if (scope !== null && !duplicate && !scopes.has(scope)) {
        scopes.add(scope);
        newScope = true;
      }
    },
    endRound() {
      const allDuplicates = calls > 0 && duplicates === calls;
      emptyRounds = calls > 0 && informative === 0 ? emptyRounds + 1 : 0;
      staleRounds = newScope ? 0 : staleRounds + 1;
      calls = 0;
      duplicates = 0;
      informative = 0;
      newScope = false;
      return (
        allDuplicates ||
        emptyRounds >= EMPTY_ROUNDS_LIMIT ||
        staleRounds >= STALE_ROUNDS_LIMIT
      );
    },
  };
}
