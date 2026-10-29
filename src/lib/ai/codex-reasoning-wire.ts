/**
 * The reasoning half of the Codex wire: what `reasoning` field a request
 * sends for a requested level, and what a slug that refuses it is asked
 * instead. A slug's refusals are learned per slug in the shared dialect cache
 * (`reasoning/dialect-cache.ts`), so the next request does not pay the
 * refused round-trip again.
 */
import {
  annotateReasoningDowngrade,
  isReasoningParameterRejection,
  learnedReasoningDialect,
  rememberReasoningDialect,
} from "./reasoning/dialect-cache";
import type { ReasoningLevel } from "./reasoning/levels";
import type { CompletionParams } from "./types";

/** The responses endpoint, and the key its learned dialects are kept under. */
export const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/**
 * The Responses-API efforts in ascending order. The Codex backend names the
 * values a slug accepts in its 400 body ("Supported values are: 'none',
 * 'low', …"), which is how a slug's ladder is learned.
 */
const CODEX_EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** What one request sends: `null` is today's `reasoning: null`. */
export type CodexReasoningWire = { effort: string; summary: boolean } | null;

/** What a slug was learned to refuse (see `reasoning/dialect-cache.ts`). */
interface CodexReasoningDialect {
  /** The slug refused `reasoning` altogether. */
  disabled?: true;
  /** The slug refused `reasoning.summary`. */
  noSummary?: true;
  /** The efforts the slug named as supported when it refused one. */
  efforts?: string[];
}

function dialectKey(slug: string) {
  return { provider: "codex", endpoint: CODEX_ENDPOINT, model: slug };
}

function readCodexDialect(slug: string): CodexReasoningDialect {
  const raw = learnedReasoningDialect(dialectKey(slug));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CodexReasoningDialect;
  } catch {
    return {};
  }
}

function wantedEffort(level: ReasoningLevel): string {
  // "Off" is a real off on the current slugs: a 2026-10-06 probe answered
  // `effort: "none"` on gpt-5.5 with a non-reasoning reply. A slug that
  // refuses it learns its lowest supported value instead.
  return level === "off" ? "none" : level;
}

/** The supported effort closest to `wanted` from below, else the lowest. */
function nearestEffort(wanted: string, supported: string[]): string | null {
  const rank = (e: string) =>
    (CODEX_EFFORT_ORDER as readonly string[]).indexOf(e);
  const known = supported
    .filter((e) => rank(e) >= 0)
    .sort((a, b) => rank(a) - rank(b));
  if (known.length === 0) return null;
  const below = known.filter((e) => rank(e) <= rank(wanted));
  return below.length > 0 ? below[below.length - 1] : known[0];
}

export function planCodexReasoning(
  reasoning: CompletionParams["reasoning"],
  slug: string,
): CodexReasoningWire {
  if (!reasoning) return null;
  const dialect = readCodexDialect(slug);
  if (dialect.disabled) return null;
  let effort: string | null = wantedEffort(reasoning.effort);
  if (dialect.efforts && !dialect.efforts.includes(effort)) {
    effort = nearestEffort(effort, dialect.efforts);
  }
  if (!effort) return null;
  return {
    effort,
    summary: reasoning.summaries && effort !== "none" && !dialect.noSummary,
  };
}

/**
 * True when the request asks for the encrypted reasoning items, the only
 * reasoning state a `store: false` request can hand to the next round.
 */
export function asksEncryptedReasoning(wire: CodexReasoningWire): boolean {
  return wire !== null && wire.effort !== "none";
}

/**
 * Read a 400 that refuses a reasoning parameter and learn what the slug
 * accepts instead. Returns the lesser wire to retry with, or `undefined`
 * when the body is not about reasoning (the caller's error path takes it).
 */
export function learnFromReasoningRejection(
  slug: string,
  wire: Exclude<CodexReasoningWire, null>,
  status: number,
  body: string,
): CodexReasoningWire | undefined {
  // Only a 400 that refuses the reasoning parameter counts; a 400 about the
  // prompt or a tool, and a replay error about a reasoning item handed back
  // from an earlier round, must not teach the slug anything.
  if (!isReasoningParameterRejection(status, body, /reasoning/i, slug)) {
    return undefined;
  }
  const dialect = readCodexDialect(slug);
  let next: CodexReasoningWire;
  if (wire.summary && /reasoning\.summary|summary/i.test(body)) {
    dialect.noSummary = true;
    next = { effort: wire.effort, summary: false };
  } else {
    const listed = /supported values are:([^"\n]*)/i.exec(body);
    const efforts = listed
      ? Array.from(listed[1].matchAll(/'([a-z]+)'/g), (m) => m[1])
      : [];
    const nearest =
      efforts.length > 0 && !efforts.includes(wire.effort)
        ? nearestEffort(wire.effort, efforts)
        : null;
    if (nearest) {
      dialect.efforts = efforts;
      next = { effort: nearest, summary: wire.summary && nearest !== "none" };
    } else {
      dialect.disabled = true;
      next = null;
    }
  }
  rememberReasoningDialect(dialectKey(slug), JSON.stringify(dialect));
  annotateReasoningDowngrade(
    "codex",
    wire.effort,
    next ? next.effort : "default",
  );
  return next;
}
