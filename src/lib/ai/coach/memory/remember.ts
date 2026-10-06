/**
 * v1.41 — what the Coach remembers from a conversation, and how the person
 * answers.
 *
 * Three ways a fact gets into `coach_facts`:
 *
 * 1. `remember_fact`, the tool the Coach calls in a turn. A preference, a
 *    goal or life context is saved at once (`source: "coach"`) and shown as a
 *    note with "Undo". Anything that touches health (filed as `condition`,
 *    `constraint` or `medication`, or worded like one, `lexicon.ts`) is only
 *    proposed: nothing is written until the person taps "Yes, remember it".
 *    A fact must come from the person's current message: at least half of its
 *    words, and every figure in it, must appear there. That keeps a quote, a
 *    document or the Coach's own idea out of memory. One note per answer.
 * 2. The person's answer to a proposal (`memoryDecision` on the chat
 *    request). The fact is read from what the server stored on the assistant
 *    message (`coach_messages.trail_encrypted`), never from the request, so a
 *    tap can only accept what the Coach actually proposed.
 * 3. The remember button under one of the person's own messages: that
 *    message, classified by the lexicon, saved as `source: "user"`.
 *
 * Fact text never reaches `annotate()`; categories, outcomes and ids do.
 *
 * Server-only.
 */
import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

import { decryptFromBytes, encryptToBytes } from "../bytes-codec";
import {
  isHealthFact,
  isNearDuplicate,
  loadActiveFacts,
  tokenSet,
  type ActiveFact,
} from "../facts";
import {
  COACH_MEMORY_CATEGORIES,
  type CoachMemoryCategory,
  type CoachTrail,
} from "../types";
import type {
  DecideFactProposalArgs,
  DecideFactProposalOutcome,
  RememberFactArgs,
  RememberFactOutcome,
} from "./contract";
import { healthTermKind } from "./lexicon";
import {
  HEALTH_MEMORY_CATEGORIES,
  PROPOSED_FACT_SOURCE,
  REMEMBER_FACT_MAX_CHARS,
} from "./shared";

/** A fact the Coach saved in a turn. */
const COACH_FACT_CONFIDENCE = 80;
/** A fact the person confirmed or saved with the button. */
const USER_FACT_CONFIDENCE = 90;
/** Share of the fact's words that must come from the person's message. */
export const ORIGIN_OVERLAP_MIN = 0.5;
/** The prefix of a proposal id minted in a turn (a pending row uses its id). */
const TURN_PROPOSAL_PREFIX = "mp_";
/** How long a turn's "one note" mark is kept. */
const TURN_MARK_TTL_MS = 10 * 60_000;

/**
 * Words that carry no fact. The origin check counts the rest: "Wants to
 * reach 75 kg by December" has to find "reach", "75", "kg", "december" in
 * the message, not "to" and "by".
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // en
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "wants",
  "want",
  "has",
  "have",
  "is",
  "are",
  "was",
  "be",
  "to",
  "by",
  "of",
  "in",
  "on",
  "at",
  "an",
  "my",
  "their",
  "they",
  "them",
  "he",
  "she",
  "his",
  "her",
  "person",
  "user",
  "prefers",
  "likes",
  // de
  "der",
  "die",
  "das",
  "und",
  "mit",
  "für",
  "ist",
  "hat",
  "will",
  "möchte",
  "von",
  "bis",
  "zu",
  "im",
  "am",
  "ein",
  "eine",
  "einen",
  "sein",
  "seine",
  "ihre",
  "ihr",
  "person",
  "nutzer",
  "nutzerin",
  "mag",
]);

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenSet(text)) {
    if (!STOPWORDS.has(token)) out.add(token);
  }
  return out;
}

/**
 * Whether the fact comes from the message: at least
 * {@link ORIGIN_OVERLAP_MIN} of its content words, and every figure, appear
 * in it. Words match on a shared stem of five letters, so "walking" finds
 * "walk" and "Abendessen" finds "Abendessens".
 */
export function factComesFromMessage(fact: string, message: string): boolean {
  const factWords = contentTokens(fact);
  if (factWords.size === 0) return false;
  const messageWords = [...tokenSet(message)];
  const found = (word: string) =>
    messageWords.some((candidate) => {
      if (candidate === word) return true;
      if (/^\d/.test(word)) return false;
      const stem = Math.min(5, word.length, candidate.length);
      return (
        stem >= 4 &&
        candidate.slice(0, stem) === word.slice(0, stem) &&
        Math.abs(candidate.length - word.length) <= 4
      );
    });
  let hits = 0;
  for (const word of factWords) {
    if (found(word)) hits += 1;
    else if (/^\d/.test(word)) return false;
  }
  return hits / factWords.size >= ORIGIN_OVERLAP_MIN;
}

/** The category a fact is filed under once its wording has been read. */
export function settleCategory(
  category: CoachMemoryCategory,
  text: string,
): CoachMemoryCategory {
  if (HEALTH_MEMORY_CATEGORIES.has(category)) return category;
  const kind = healthTermKind(text);
  return kind ?? category;
}

/** A fact's text as stored: one line, at most the fact limit. */
export function normaliseFactText(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= REMEMBER_FACT_MAX_CHARS) return flat;
  const cut = flat.slice(0, REMEMBER_FACT_MAX_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > REMEMBER_FACT_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// ── One note per answer ────────────────────────────────────────────────────

const turnMarks = new Map<string, number>();

function turnKey(conversationId: string, userMessageId: string): string {
  return `${conversationId}:${userMessageId}`;
}

/** Marks the turn as having its note; false when it already had one. */
function claimTurnNote(key: string, now: number): boolean {
  for (const [k, at] of turnMarks) {
    if (now - at > TURN_MARK_TTL_MS) turnMarks.delete(k);
  }
  if (turnMarks.has(key)) return false;
  turnMarks.set(key, now);
  return true;
}

/** Test seam: forget every turn mark. */
export function resetTurnMarksForTests(): void {
  turnMarks.clear();
}

/** The conversation's newest user message, which the current turn answers. */
async function latestUserMessageId(
  userId: string,
  conversationId: string,
): Promise<string | null> {
  const row = await prisma.coachMessage.findFirst({
    where: { conversationId, role: "user", conversation: { userId } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return row?.id ?? null;
}

// ── remember_fact ──────────────────────────────────────────────────────────

/**
 * Runs a `remember_fact` call. `userMessage` is the person's current message,
 * the only text a fact may come from.
 */
export async function rememberFactFromTool(
  args: RememberFactArgs,
): Promise<RememberFactOutcome> {
  const outcome = await runRemember(args);
  annotate({
    action: { name: "coach.memory.remember" },
    meta: {
      outcome: outcome.kind,
      ...(outcome.kind === "declined"
        ? { reason: outcome.reason }
        : { category: outcome.note.category }),
    },
  });
  return outcome;
}

async function runRemember(
  args: RememberFactArgs,
): Promise<RememberFactOutcome> {
  const { userId, conversationId, call } = args;
  if (
    !(COACH_MEMORY_CATEGORIES as readonly string[]).includes(call.category) ||
    typeof call.fact !== "string"
  ) {
    return { kind: "declined", reason: "invalid" };
  }
  const fact = call.fact.replace(/\s+/g, " ").trim();
  if (fact.length < 3 || fact.length > REMEMBER_FACT_MAX_CHARS) {
    return { kind: "declined", reason: "invalid" };
  }
  if (!factComesFromMessage(fact, args.userMessage)) {
    return { kind: "declined", reason: "not_from_message" };
  }

  const userMessageId =
    args.userMessageId ?? (await latestUserMessageId(userId, conversationId));
  if (!userMessageId) return { kind: "declined", reason: "unavailable" };

  const category = settleCategory(call.category, fact);
  const health = isHealthFact(category, fact);
  const active = await loadActiveFacts(prisma, userId);

  const pending = active.find(
    (row) =>
      row.source === PROPOSED_FACT_SOURCE && isNearDuplicate(fact, [row.text]),
  );
  const known = active.some(
    (row) =>
      row.source !== PROPOSED_FACT_SOURCE && isNearDuplicate(fact, [row.text]),
  );
  if (known) return { kind: "declined", reason: "duplicate" };

  if (!claimTurnNote(turnKey(conversationId, userMessageId), Date.now())) {
    return { kind: "declined", reason: "one_per_answer" };
  }

  if (health) {
    return {
      kind: "proposed",
      note: pending
        ? pendingNote(pending)
        : {
            proposal: true,
            proposalId: `${TURN_PROPOSAL_PREFIX}${randomUUID()}`,
            category,
            fact,
          },
    };
  }

  const row = await prisma.coachFact.create({
    data: {
      userId,
      factEncrypted: encryptToBytes(fact),
      category,
      confidence: COACH_FACT_CONFIDENCE,
      sourceConversationId: conversationId,
      sourceMessageId: userMessageId,
      source: "coach",
    },
    select: { id: true },
  });
  return {
    kind: "saved",
    note: { proposal: false, factId: row.id, category, fact },
  };
}

function pendingNote(row: ActiveFact) {
  return {
    proposal: true,
    proposalId: row.id,
    category: row.category as CoachMemoryCategory,
    fact: row.text,
  };
}

// ── The person's answer ─────────────────────────────────────────────────────

/** The trail stored on a message, or null when it has none or is unreadable. */
export function readStoredTrail(bytes: Uint8Array | null): CoachTrail | null {
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(decryptFromBytes(bytes));
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as CoachTrail;
  } catch {
    return null;
  }
}

/**
 * Answers a fact proposal. The fact is read from the trail stored on
 * `messageId`, never from the request.
 */
export async function decideFactProposal(
  args: DecideFactProposalArgs,
): Promise<DecideFactProposalOutcome> {
  const outcome = await runDecide(args).catch(
    (): DecideFactProposalOutcome => ({ kind: "stale" }),
  );
  annotate({
    action: { name: "coach.memory.decided" },
    meta: { accept: args.accept, outcome: outcome.kind },
  });
  return outcome;
}

async function runDecide(
  args: DecideFactProposalArgs,
): Promise<DecideFactProposalOutcome> {
  const { userId, conversationId, messageId, proposalId, accept } = args;
  const message = await prisma.coachMessage.findFirst({
    where: {
      id: messageId,
      conversationId,
      role: "assistant",
      conversation: { userId },
    },
    select: { trailEncrypted: true },
  });
  const proposal = readStoredTrail(message?.trailEncrypted ?? null)?.proposal;
  if (
    !proposal ||
    proposal.proposalId !== proposalId ||
    typeof proposal.fact !== "string" ||
    !(COACH_MEMORY_CATEGORIES as readonly string[]).includes(proposal.category)
  ) {
    return { kind: "stale" };
  }

  // A health fact the background found: the row is already there, waiting.
  if (!proposalId.startsWith(TURN_PROPOSAL_PREFIX)) {
    const { count } = await prisma.coachFact.updateMany({
      where: {
        id: proposalId,
        userId,
        deletedAt: null,
        source: PROPOSED_FACT_SOURCE,
      },
      data: accept
        ? { source: "user", sourceMessageId: messageId }
        : { deletedAt: new Date() },
    });
    if (count === 0) return { kind: "stale" };
    return accept
      ? { kind: "saved", factId: proposalId }
      : { kind: "declined" };
  }

  if (!accept) return { kind: "declined" };

  // Answered before: the fact this message proposed is already saved.
  const already = await prisma.coachFact.findFirst({
    where: { userId, sourceMessageId: messageId, source: "user" },
    select: { id: true },
  });
  if (already) return { kind: "stale" };

  const fact = normaliseFactText(proposal.fact);
  const active = await loadActiveFacts(prisma, userId);
  const twin = active.find(
    (row) =>
      row.source !== PROPOSED_FACT_SOURCE && isNearDuplicate(fact, [row.text]),
  );
  if (twin) return { kind: "saved", factId: twin.id };

  const row = await prisma.coachFact.create({
    data: {
      userId,
      factEncrypted: encryptToBytes(fact),
      category: proposal.category,
      confidence: USER_FACT_CONFIDENCE,
      sourceConversationId: conversationId,
      sourceMessageId: messageId,
      source: "user",
    },
    select: { id: true },
  });
  return { kind: "saved", factId: row.id };
}

// ── The remember button ─────────────────────────────────────────────────────

export interface RememberedMessage {
  id: string;
  category: CoachMemoryCategory;
  text: string;
  source: "user";
  created: boolean;
}

/**
 * Saves one of the person's own messages as a fact: the remember button. The
 * person's tap is the confirmation, so a health message is saved too, filed
 * under `medication` or `condition` by the lexicon; anything else is
 * `context`. Null when the message is not the caller's own user message, or
 * has no text.
 */
export async function rememberMessageAsFact(args: {
  userId: string;
  messageId: string;
}): Promise<RememberedMessage | null> {
  const message = await prisma.coachMessage.findFirst({
    where: {
      id: args.messageId,
      role: "user",
      conversation: { userId: args.userId },
    },
    select: { id: true, conversationId: true, encryptedContent: true },
  });
  if (!message) return null;
  let content: string;
  try {
    content = decryptFromBytes(message.encryptedContent);
  } catch {
    return null;
  }
  const text = normaliseFactText(content);
  if (text.length < 3) return null;
  const category: CoachMemoryCategory = healthTermKind(text) ?? "context";

  const active = await loadActiveFacts(prisma, args.userId);
  const twin = active.find((row) => isNearDuplicate(text, [row.text]));
  if (twin && twin.source !== PROPOSED_FACT_SOURCE) {
    return {
      id: twin.id,
      category: twin.category as CoachMemoryCategory,
      text: twin.text,
      source: "user",
      created: false,
    };
  }
  if (twin) {
    // A proposal for the same fact was waiting: the button answers it.
    await prisma.coachFact.updateMany({
      where: { id: twin.id, userId: args.userId, deletedAt: null },
      data: { source: "user", sourceMessageId: message.id },
    });
    return {
      id: twin.id,
      category: twin.category as CoachMemoryCategory,
      text: twin.text,
      source: "user",
      created: false,
    };
  }

  const row = await prisma.coachFact.create({
    data: {
      userId: args.userId,
      factEncrypted: encryptToBytes(text),
      category,
      confidence: USER_FACT_CONFIDENCE,
      sourceConversationId: message.conversationId,
      sourceMessageId: message.id,
      source: "user",
    },
    select: { id: true },
  });
  return { id: row.id, category, text, source: "user", created: true };
}
