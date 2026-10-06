/**
 * Result references: the names a table goes by, inside one turn and across
 * the turns of one conversation.
 *
 *   - `r<n>` — a table of the current message, `r1`..`r8`, handed out as the
 *     tool that produces it settles, so the model reads its own table's name
 *     in the tool result it cites from.
 *   - `m<k>.r<n>` — table `r<n>` of an earlier assistant message of the same
 *     conversation, `k` being that message's 1-based position among the
 *     conversation's assistant messages (stable however many are loaded). The names are drawn once per turn
 *     from the conversation the turn already read (owner-narrowed), and
 *     `show_result` resolves only against that same list, so a name can never
 *     reach a table of another conversation or another account.
 *   - `result:r<n>` — the mark the model leaves in its prose for a table its
 *     answer relies on. Stripped before the prose reaches anyone; the marked
 *     tables are shown expanded under the reply.
 *
 * Pure: no database, no provider. The reply guards import this module.
 */
import type { CoachResultMeta, CoachResultTable } from "@/lib/ai/coach/types";

/**
 * At most this many tables per message (`r1`..`r8`). v1.41 — eight, up from
 * six: a budgeted turn reads over more rounds. A ninth table call still
 * gives the model its summary; there is just no table to name.
 */
export const MAX_RESULTS_PER_TURN = 8;

const TURN_REF = /^r([1-9]\d?)$/;
const PRIOR_REF = /^m([1-9]\d{0,3})\.(r[1-9]\d?)$/;

/** True for a table name of the current message (`r1`..`r8`). */
export function isTurnResultRef(ref: string): boolean {
  const match = TURN_REF.exec(ref);
  return match !== null && Number(match[1]) <= MAX_RESULTS_PER_TURN;
}

/** Hands out `r1`..`r8` in order, then null: a turn keeps at most eight. */
export interface ResultRefAllocator {
  next(): string | null;
}

export function createResultRefAllocator(): ResultRefAllocator {
  let issued = 0;
  return {
    next() {
      if (issued >= MAX_RESULTS_PER_TURN) return null;
      issued += 1;
      return `r${issued}`;
    },
  };
}

// ── Earlier tables of the conversation ─────────────────────────────────────

/** One earlier assistant message that holds tables. */
export interface PriorResultTurn {
  messageId: string;
  /** 1-based position among the conversation's assistant messages. */
  turnIndex: number;
  results: CoachResultMeta[];
}

/** The minimum of a loaded message this module needs. */
interface LoadedMessage {
  id: string;
  role: string;
  metricSource: { results?: CoachResultMeta[] } | null;
}

/**
 * The earlier assistant messages of a loaded conversation that hold tables,
 * oldest first, each with the index its tables are named by.
 */
export function collectPriorResults(
  messages: ReadonlyArray<LoadedMessage>,
  /**
   * Assistant messages written before the first loaded one, so an index is
   * the message's position in the whole conversation, not in the window the
   * turn happened to load.
   */
  earlierAssistantMessages = 0,
): PriorResultTurn[] {
  const out: PriorResultTurn[] = [];
  let turnIndex = earlierAssistantMessages;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    turnIndex += 1;
    const results = message.metricSource?.results ?? [];
    if (results.length === 0) continue;
    out.push({ messageId: message.id, turnIndex, results: [...results] });
  }
  return out;
}

/** `m<k>.r<n>` for table `ref` of the earlier message at `turnIndex`. */
export function formatPriorResultRef(turnIndex: number, ref: string): string {
  return `m${turnIndex}.${ref}`;
}

/** The parts of an `m<k>.r<n>` name, or null when it is not one. */
export function parsePriorResultRef(
  value: string,
): { turnIndex: number; ref: string } | null {
  const match = PRIOR_REF.exec(value.trim());
  if (!match || !isTurnResultRef(match[2])) return null;
  return { turnIndex: Number(match[1]), ref: match[2] };
}

/** Where an `m<k>.r<n>` name points, within this conversation only. */
export interface PriorResultTarget {
  messageId: string;
  ref: string;
  meta: CoachResultMeta;
}

/**
 * Resolve an `m<k>.r<n>` name against the earlier tables of THIS
 * conversation. Anything else (a malformed name, an index or ref the
 * conversation does not hold) is null: the caller reports an unknown
 * result, it never goes looking elsewhere.
 */
export function resolvePriorResultRef(
  value: string,
  prior: ReadonlyArray<PriorResultTurn>,
): PriorResultTarget | null {
  const parsed = parsePriorResultRef(value);
  if (!parsed) return null;
  const turn = prior.find((entry) => entry.turnIndex === parsed.turnIndex);
  const meta = turn?.results.find((entry) => entry.ref === parsed.ref);
  if (!turn || !meta) return null;
  return { messageId: turn.messageId, ref: parsed.ref, meta };
}

// ── Marks in the prose ──────────────────────────────────────────────────

/**
 * `result:r1`, bare or wrapped whole in one pair of parentheses or brackets,
 * with or without a space after the colon. Case-insensitive: the model's
 * spelling varies, the mark it means does not.
 */
const RESULT_MARK =
  /\(\s*result:\s?(r[1-9]\d?)\s*\)|\[\s*result:\s?(r[1-9]\d?)\s*\]|\bresult:\s?(r[1-9]\d?)\b/gi;

/**
 * Strip the `result:rN` marks from the reply prose and list the refs they
 * named, first mention first. The marks go before the number check reads
 * the prose, so their digits never count as a figure.
 */
export function stripResultRefs(prose: string): {
  prose: string;
  referenced: string[];
} {
  const referenced: string[] = [];
  let found = false;
  const stripped = prose.replace(
    RESULT_MARK,
    (_match, paren?: string, bracket?: string, bare?: string) => {
      found = true;
      const normalised = (paren ?? bracket ?? bare ?? "").toLowerCase();
      if (isTurnResultRef(normalised) && !referenced.includes(normalised)) {
        referenced.push(normalised);
      }
      return "";
    },
  );
  if (!found) return { prose, referenced };
  return {
    prose: stripped
      // A mark removed mid-sentence leaves a doubled or stray space.
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([.,;:!?)\]])/g, "$1")
      .replace(/([([])[ \t]+/g, "$1")
      .replace(/[ \t]+$/gm, "")
      .trim(),
    referenced,
  };
}

// ── What a message keeps ──────────────────────────────────────────────────

/**
 * The at-rest ceiling for one message's tables, as JSON before encryption.
 * Tables arrive trimmed to 400 rows; a message whose tables still exceed
 * this keeps the leading tables that fit.
 */
export const RESULTS_MAX_BYTES = 128 * 1024;

/**
 * The tables a message keeps: the leading ones whose JSON fits
 * `RESULTS_MAX_BYTES`, whole tables dropped from the end. Applied once,
 * before the turn streams them, so the tables the person sees live are the
 * tables a reload reads back, and the metadata never names a table the
 * ciphertext does not hold.
 */
export function fitResultsToStorage(
  results: readonly CoachResultTable[],
): CoachResultTable[] {
  const kept = results.slice(0, MAX_RESULTS_PER_TURN);
  while (
    kept.length > 0 &&
    new TextEncoder().encode(JSON.stringify(kept)).byteLength >
      RESULTS_MAX_BYTES
  ) {
    kept.pop();
  }
  return kept;
}
