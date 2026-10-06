/**
 * v1.41 — the budget one Coach turn runs under: tokens, wall time and a hard
 * round cap, fixed by who pays for the turn.
 *
 * The loop asks `check()` before every tool round after the first. A reason
 * means the next round is the final one: it is sent without tools and the
 * answer is written from what was read so far. The checks run in the order
 * the plan fixes:
 *
 *   1. tokens: spent + the next round + the final answer would pass the
 *      turn's token budget (`budget`);
 *   2. time: elapsed + a typical round + the final round would pass the wall
 *      time (`time`);
 *   3. rounds: the next round is the last one the cap allows (`cap`).
 *
 * The final answer is reserved before anything else is spent: whichever
 * check stops the loop, there is always room for the answer, so a turn never
 * ends without one.
 *
 * Cached input counts at a tenth of its size. A provider that serves the
 * prompt prefix from its cache bills it at a fraction, and later rounds of a
 * turn resend almost the whole prompt; counting it whole would stop a long
 * turn for tokens nobody paid for.
 *
 * Pure: no database, no provider, no clock unless one is passed.
 */
import type { CoachStopReason } from "@/lib/ai/coach/types";
import {
  REASONING_THINKING_BUDGET,
  type ReasoningLevel,
} from "@/lib/ai/reasoning/levels";

/** Who pays for the turn; the same split the daily ledger keeps. */
export type TurnPayer = "user" | "operator";

export interface TurnLimits {
  /** Tokens per turn, cached input weighted (`CACHED_INPUT_WEIGHT`). */
  tokens: number;
  /** Wall time per turn, in milliseconds. */
  wallMs: number;
  /** Rounds per turn, the final answer included. */
  maxRounds: number;
}

/**
 * Fixed per payer, not configurable: the person's own plan, key or local
 * model gets room for a long "why" chain; a turn the operator pays for gets
 * a third of the tokens and half the rounds.
 */
export const TURN_LIMITS: Readonly<Record<TurnPayer, TurnLimits>> = {
  user: { tokens: 120_000, wallMs: 150_000, maxRounds: 12 },
  operator: { tokens: 40_000, wallMs: 90_000, maxRounds: 6 },
};

/** The answer budget of one round, before any thinking budget. */
export const ROUND_ANSWER_TOKENS = 600;

/** What the final answer is given on top of its input. */
export const FINAL_ANSWER_TOKENS = 1_200;

/** Cached input counts at this share of its size. */
export const CACHED_INPUT_WEIGHT = 0.1;

/** A typical round, before one has been measured. */
const DEFAULT_ROUND_MS = 8_000;

/** A token count from a provider: a finite non-negative integer, else 0. */
function tokens(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * The output allowance of one round: the answer budget plus the thinking
 * budget of the level, where the level thinks at all.
 */
export function roundOutputAllowance(effort: ReasoningLevel | undefined): number {
  return (
    ROUND_ANSWER_TOKENS +
    (effort && effort !== "off" ? REASONING_THINKING_BUDGET[effort] : 0)
  );
}

/** A round's tokens as the turn budget counts them. */
export function weightedRoundTokens(usage: {
  tokens: number | null | undefined;
  cachedTokens: number | null | undefined;
}): number {
  const gross = tokens(usage.tokens);
  const cached = Math.min(gross, tokens(usage.cachedTokens));
  return Math.ceil(gross - cached + cached * CACHED_INPUT_WEIGHT);
}

/**
 * A rough input estimate from prompt text: four characters a token. Only
 * the first round needs it; every later round is estimated from the one
 * before.
 */
export function estimateInputTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export interface RoundUsage {
  tokens: number | null | undefined;
  cachedTokens: number | null | undefined;
  durationMs: number;
}

export interface TurnBudget {
  readonly payer: TurnPayer;
  readonly limits: TurnLimits;
  /** Rounds completed so far. */
  rounds(): number;
  /** Weighted tokens spent so far. */
  spent(): number;
  elapsedMs(): number;
  /** Records a finished round. */
  endRound(usage: RoundUsage): void;
  /**
   * Text the next round sends that the last one did not (the assistant turn
   * and the tool results), in tokens. It is new, so it is never cached.
   */
  addInput(tokenCount: number): void;
  /**
   * What the first round is expected to cost: its whole input, uncached, and
   * a round's output. What a turn reserves before anything runs.
   */
  firstRoundEstimate(): number;
  /** What the next tool round is expected to cost, weighted. */
  nextRoundEstimate(): number;
  /** What the final answer is held back for, weighted. */
  finalReserve(): number;
  /**
   * Why the next round must be the final one, or null when it may still
   * fetch. Asked before every round after the first.
   */
  check(): Exclude<CoachStopReason, "no_progress"> | null;
}

export function createTurnBudget(args: {
  payer: TurnPayer;
  effort?: ReasoningLevel;
  /** The first round's input, estimated from the prompt. */
  initialInputTokens: number;
  /** Injected for tests. */
  now?: () => number;
  /** Overrides for tests. */
  limits?: TurnLimits;
}): TurnBudget {
  const now = args.now ?? Date.now;
  const limits = args.limits ?? TURN_LIMITS[args.payer];
  const started = now();
  const output = roundOutputAllowance(args.effort);
  const durations: number[] = [];
  let spent = 0;
  let rounds = 0;
  // The prompt the last round sent, which the next one resends as its
  // prefix, and what was added to it since.
  let prefix = tokens(args.initialInputTokens);
  let added = 0;
  // The share of a resent prefix the turn is charged for. Optimistic until a
  // later round says otherwise: providers cache a resent prefix, and the
  // first round cannot show whether this one does.
  let prefixWeight = CACHED_INPUT_WEIGHT;

  const median = (): number => {
    if (durations.length === 0) return DEFAULT_ROUND_MS;
    const sorted = [...durations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[mid]
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  // What the last round really cost, weighted: a round resends the same
  // prefix, so it bounds the estimate from above whatever the cache did.
  let lastRound = Number.POSITIVE_INFINITY;
  const nextInput = (): number =>
    Math.min(lastRound, Math.ceil(prefix * prefixWeight)) + added;

  const budget: TurnBudget = {
    payer: args.payer,
    limits,
    rounds: () => rounds,
    spent: () => spent,
    elapsedMs: () => now() - started,
    endRound(usage) {
      const gross = tokens(usage.tokens);
      const weighted = weightedRoundTokens(usage);
      spent += weighted;
      if (gross > 0) lastRound = weighted;
      rounds += 1;
      durations.push(Math.max(0, Math.round(usage.durationMs)));
      // From the second round on, a round's own cache share says how much
      // of a resent prefix this provider really charges.
      if (rounds >= 2 && gross > 0) {
        const cached = Math.min(gross, tokens(usage.cachedTokens));
        prefixWeight = Math.max(
          CACHED_INPUT_WEIGHT,
          1 - (cached / gross) * (1 - CACHED_INPUT_WEIGHT),
        );
      }
      prefix += added + output;
      added = 0;
    },
    addInput(tokenCount) {
      added += tokens(tokenCount);
    },
    firstRoundEstimate: () => tokens(args.initialInputTokens) + output,
    nextRoundEstimate: () => nextInput() + output,
    finalReserve: () => nextInput() + FINAL_ANSWER_TOKENS,
    check() {
      if (
        spent + budget.nextRoundEstimate() + budget.finalReserve() >
        limits.tokens
      ) {
        return "budget";
      }
      // The next round and the final one, each about as long as a typical
      // round so far.
      if (budget.elapsedMs() + 2 * median() > limits.wallMs) return "time";
      // Rounds are counted with the final one: the round that would be the
      // last allowed must be the answer.
      if (rounds + 1 >= limits.maxRounds) return "cap";
      return null;
    },
  };
  return budget;
}
