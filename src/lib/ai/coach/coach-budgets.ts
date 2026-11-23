/**
 * The Coach budget a person sets for a self-hosted model: how large the data
 * snapshot in the prompt may grow, and how many tokens, rounds and seconds
 * one turn may spend.
 *
 * The built-in limits are sized for a hosted model with a large context:
 * 14,000 snapshot characters, 165,000 tokens, 16 rounds and 200 seconds per
 * turn. A small local model cannot read a snapshot that large, and a
 * workstation with a 64k context and its own GPU can read far more than that.
 * Only the person running the model knows which, so the two providers that
 * point at a host the person chose (Local and the OpenAI-compatible gateway)
 * each take their own budget. The hosted providers keep the built-in limits.
 *
 * Every value is clamped to `COACH_BUDGET_BOUNDS` twice: the settings write
 * refuses a value outside them, and the reader clamps whatever is stored
 * (a restore, a hand edit), so a turn never runs on an unbounded number.
 *
 * Which budget a turn runs under (`resolveCoachLimits`):
 *   * A turn the operator pays for keeps the operator limits, whatever is
 *     stored: a person cannot raise what somebody else is billed for.
 *   * Otherwise the turn and snapshot budgets come from the first provider
 *     of the chain, the one the turn is sized for.
 *   * A smaller snapshot set on any later provider of the chain wins, because
 *     the fallback hop must still fit the prompt it is handed.
 *   * A chain with an operator-funded fallback never gets a snapshot or a
 *     turn budget larger than the built-in one, for the same reason as the
 *     first rule: the turn has one budget, and the fallback hop may be the
 *     one that spends it. A smaller value the person set still holds.
 *
 * Pure: no database. The reader of the column is `readCoachBudgets`.
 */
import { z } from "zod/v4";

import type { ProviderChainType } from "@/lib/ai/provider-chain";

import {
  TURN_LIMITS,
  type TurnLimits,
  type TurnPayer,
} from "./tools/turn-budget";

/** The providers that take a budget of their own. */
export const COACH_BUDGET_PROVIDERS = ["local", "openai-compatible"] as const;
export type CoachBudgetProvider = (typeof COACH_BUDGET_PROVIDERS)[number];

export function isCoachBudgetProvider(
  type: string,
): type is CoachBudgetProvider {
  return (COACH_BUDGET_PROVIDERS as readonly string[]).includes(type);
}

/**
 * The built-in snapshot size, in compact JSON characters. Equal to
 * `MAX_SNAPSHOT_CHARS` in `snapshot-prelude.ts`, which cannot be imported
 * here because that module reads the database; a test holds the two equal.
 */
export const DEFAULT_SNAPSHOT_CHARS = 14_000;

/**
 * What a person may set. The floors keep a turn able to answer at all (a
 * snapshot under 4,000 characters cannot hold the blood pressure block of a
 * busy month, and one round is only the final answer); the ceilings keep a
 * turn inside what the daily ledger and the turn slot can carry.
 */
export const COACH_BUDGET_BOUNDS = {
  snapshotChars: { min: 4_000, max: 120_000 },
  turnTokens: { min: 20_000, max: 600_000 },
  maxRounds: { min: 2, max: 24 },
  turnSeconds: { min: 30, max: 600 },
} as const;

export type CoachBudgetField = keyof typeof COACH_BUDGET_BOUNDS;

/** The built-in value of each field, for the placeholders. */
export const COACH_BUDGET_DEFAULTS: Record<CoachBudgetField, number> = {
  snapshotChars: DEFAULT_SNAPSHOT_CHARS,
  turnTokens: TURN_LIMITS.user.tokens,
  maxRounds: TURN_LIMITS.user.maxRounds,
  turnSeconds: TURN_LIMITS.user.wallMs / 1000,
};

/** One provider's budget; an absent field keeps the built-in value. */
export type CoachBudget = Partial<Record<CoachBudgetField, number>>;

/** The stored column: one budget per provider. */
export type CoachBudgets = Partial<Record<CoachBudgetProvider, CoachBudget>>;

function field(name: CoachBudgetField) {
  const { min, max } = COACH_BUDGET_BOUNDS[name];
  return z
    .number()
    .int()
    .min(min, `${name} must be between ${min} and ${max}`)
    .max(max, `${name} must be between ${min} and ${max}`)
    .nullable()
    .optional();
}

/**
 * One provider's budget as the settings write accepts it. `null` on a field
 * restores its built-in value; `null` for the whole object clears the
 * provider's budget. Out-of-range values are refused, not clamped, so a typo
 * is visible.
 */
export const coachBudgetInputSchema = z
  .object({
    snapshotChars: field("snapshotChars"),
    turnTokens: field("turnTokens"),
    maxRounds: field("maxRounds"),
    turnSeconds: field("turnSeconds"),
  })
  .nullable()
  .describe(
    "Coach budget for this provider: snapshot size in characters, tokens, rounds and seconds per turn. A null field restores its built-in value; null for the object clears the budget.",
  );

export type CoachBudgetInput = z.infer<typeof coachBudgetInputSchema>;

function clampField(name: CoachBudgetField, value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const { min, max } = COACH_BUDGET_BOUNDS[name];
  return Math.min(max, Math.max(min, Math.round(value)));
}

const FIELDS = Object.keys(COACH_BUDGET_BOUNDS) as CoachBudgetField[];

/** One stored budget, clamped; fields that are not numbers are dropped. */
function parseBudget(raw: unknown): CoachBudget | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const out: CoachBudget = {};
  for (const name of FIELDS) {
    const value = clampField(name, (raw as Record<string, unknown>)[name]);
    if (value !== null) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The stored column, tolerant: anything malformed reads as no budget, so a
 * bad value can never stop a turn.
 */
export function parseCoachBudgets(raw: unknown): CoachBudgets {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: CoachBudgets = {};
  for (const provider of COACH_BUDGET_PROVIDERS) {
    const budget = parseBudget((raw as Record<string, unknown>)[provider]);
    if (budget) out[provider] = budget;
  }
  return out;
}

/**
 * The column after one provider's budget was written. A null field drops it,
 * a null input drops the provider, and a budget left with no field is
 * removed. Returns null when nothing is left, so the column clears.
 */
export function coachBudgetsAfterWrite(
  stored: unknown,
  provider: CoachBudgetProvider,
  input: CoachBudgetInput,
): CoachBudgets | null {
  const next = parseCoachBudgets(stored);
  if (input === null) {
    delete next[provider];
  } else {
    const budget: CoachBudget = { ...(next[provider] ?? {}) };
    for (const name of FIELDS) {
      const value = input[name];
      if (value === undefined) continue;
      if (value === null) delete budget[name];
      else budget[name] = value;
    }
    if (Object.keys(budget).length > 0) next[provider] = budget;
    else delete next[provider];
  }
  return Object.keys(next).length > 0 ? next : null;
}

/** What one turn runs under. */
export interface CoachLimits {
  /** The snapshot cap in the prompt, compact JSON characters. */
  snapshotChars: number;
  /** The tool-loop budget. */
  turn: TurnLimits;
  /** Whether any of it came from a stored budget. */
  custom: boolean;
}

function isOperatorFunded(type: ProviderChainType): boolean {
  return type === "admin-openai" || type === "admin-codex";
}

export function resolveCoachLimits(args: {
  payer: TurnPayer;
  chain: ReadonlyArray<{ providerType: ProviderChainType }>;
  budgets: CoachBudgets;
}): CoachLimits {
  const builtIn: CoachLimits = {
    snapshotChars: DEFAULT_SNAPSHOT_CHARS,
    turn: TURN_LIMITS[args.payer],
    custom: false,
  };
  if (args.payer === "operator") return builtIn;

  const budgetOf = (type: ProviderChainType): CoachBudget | undefined =>
    isCoachBudgetProvider(type) ? args.budgets[type] : undefined;
  const primary = args.chain[0]
    ? budgetOf(args.chain[0].providerType)
    : undefined;

  let snapshotChars = primary?.snapshotChars ?? DEFAULT_SNAPSHOT_CHARS;
  let operatorFallback = false;
  for (const entry of args.chain.slice(1)) {
    const own = budgetOf(entry.providerType)?.snapshotChars;
    if (own !== undefined) snapshotChars = Math.min(snapshotChars, own);
    if (isOperatorFunded(entry.providerType)) operatorFallback = true;
  }

  let turn: TurnLimits = {
    tokens: primary?.turnTokens ?? builtIn.turn.tokens,
    maxRounds: primary?.maxRounds ?? builtIn.turn.maxRounds,
    wallMs:
      primary?.turnSeconds !== undefined
        ? primary.turnSeconds * 1000
        : builtIn.turn.wallMs,
  };
  if (operatorFallback) {
    snapshotChars = Math.min(snapshotChars, DEFAULT_SNAPSHOT_CHARS);
    turn = {
      tokens: Math.min(turn.tokens, builtIn.turn.tokens),
      maxRounds: Math.min(turn.maxRounds, builtIn.turn.maxRounds),
      wallMs: Math.min(turn.wallMs, builtIn.turn.wallMs),
    };
  }
  const custom =
    snapshotChars !== DEFAULT_SNAPSHOT_CHARS ||
    turn.tokens !== builtIn.turn.tokens ||
    turn.maxRounds !== builtIn.turn.maxRounds ||
    turn.wallMs !== builtIn.turn.wallMs;
  return { snapshotChars, turn, custom };
}

/** The longest a turn can run under any budget. */
export const COACH_MAX_TURN_MS = Math.max(
  TURN_LIMITS.user.wallMs,
  COACH_BUDGET_BOUNDS.turnSeconds.max * 1000,
);

/**
 * The longest one person's turn can run under what they stored, read before
 * the chain is known: the built-in wall time, or the longest `turnSeconds`
 * of any provider when that is longer. The turn slot is held for this, so
 * only an account that set a longer turn holds its slot longer.
 */
export function coachTurnWindowMs(budgets: CoachBudgets): number {
  let longest = TURN_LIMITS.user.wallMs;
  for (const provider of COACH_BUDGET_PROVIDERS) {
    const seconds = budgets[provider]?.turnSeconds;
    if (seconds !== undefined) longest = Math.max(longest, seconds * 1000);
  }
  return Math.min(longest, COACH_MAX_TURN_MS);
}
