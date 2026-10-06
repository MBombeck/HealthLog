/**
 * v1.11.1 (Epic B, B-W7) — durable personal-fact extraction + injection.
 *
 * The Coach learns STABLE facts about a user from a conversation — standing
 * preferences, conditions the user STATES about themselves, durable goals,
 * standing constraints, durable life context — and persists them encrypted
 * at rest so future turns can personalise without re-asking. Facts are
 * DESCRIPTIVE (the user's own framing), never diagnostic: the extractor is
 * forbidden from inferring a medical condition or recording a measurement.
 *
 * v1.41 — this is the background NET, not the main path. In a turn the Coach
 * saves what it hears through `remember_fact` (`memory/remember.ts`); this
 * extraction runs once a conversation has gone quiet and catches what the
 * turn did not. Nothing it finds becomes active on its own: a preference, goal
 * or context fact is stored as `extracted`, a health fact (`condition`,
 * `constraint`, `medication`, or any text the lexicon reads as one) is stored
 * as `proposed` and offered to the person once, at the next turn.
 *
 * `extractAndStoreFacts` loads active facts + recent turns, runs one bounded
 * `runStatusCompletion`, parses `{"facts":[…]}` (or a bare array), drops
 * anything the Zod gate rejects, de-dups against the active set, enforces a
 * per-user cap, and persists survivors field-by-field (no mass-assignment
 * spread). The memory block every turn starts with is built in
 * `memory/context-block.ts`.
 *
 * The fact TEXT is encrypted via `bytes-codec.ts` (the same AES-256-GCM codec
 * as `CoachMessage`). category/confidence/sourceConversationId stay plain so
 * the ranker can sort without paying a per-row decrypt. Annotations carry
 * counts + ids only — fact text is NEVER logged.
 *
 * Server-only — reads `@/lib/db`.
 */
import { z } from "zod";

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { annotate } from "@/lib/logging/context";

import {
  COACH_MEMORY_CATEGORIES,
  type CoachMemoryCategory,
} from "@/lib/ai/coach/types";
import { extractJsonObject } from "@/lib/ai/json-extract";

import { decryptFromBytes, encryptToBytes } from "./bytes-codec";
import { healthTermKind } from "./memory/lexicon";
import {
  HEALTH_MEMORY_CATEGORIES,
  PROPOSED_FACT_SOURCE,
  type CoachFactSource,
} from "./memory/shared";

/**
 * Closed category enum — app-side (no DB enum), matching the schema column.
 * v1.41 — the Coach memory's own list, `medication` included.
 */
export const COACH_FACT_CATEGORIES = COACH_MEMORY_CATEGORIES;

export type CoachFactCategory = CoachMemoryCategory;

/** Hard cap on active facts per user; at cap, only strictly-higher-confidence facts displace. */
export const MAX_FACTS_PER_USER = 50;
/** Per-fact text length cap (mirrors the Zod gate + the prompt instruction). */
export const FACT_MAX_CHARS = 160;
/** How many active facts the memory block carries into a turn. */
export const FACTS_INJECT_TOP_N = 8;

/** Cap on recent turns fed into the extraction prompt (bounds prompt size). */
const RECENT_TURNS_CAP = 10;

type RunCompletionFn = typeof runStatusCompletion;
type PrismaLike = Pick<typeof prisma, "coachFact" | "coachConversation">;

interface ExtractOpts {
  runCompletion?: RunCompletionFn;
  prisma?: PrismaLike;
  locale?: string;
}

// ---------------------------------------------------------------------------
// Extraction prompt (EN + DE mirror)
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT_EN = `You extract DURABLE personal facts about the user from a coaching conversation, for the assistant's long-term memory. Return one JSON object (no prose, no fences): { "facts": [ … ] }. Each item: { "category": one of preference|goal|context|condition|constraint|medication, "fact": "<one short descriptive sentence>", "confidence": 0-100 }.
ONLY extract facts that are STABLE and will still be true next month: standing preferences, conditions the user STATES about themselves, durable goals, standing constraints, durable life context. Record descriptively in the user's own framing — NEVER diagnose, infer a medical condition the user did not state, or record a number/measurement (those live in the data). EXCLUDE: transient feelings ("tired today"), one-off events, anything time-bound, sensitive detail beyond what is needed to coach, and anything the user asked you to forget. A medication the user says they take is "medication"; a diagnosis or health condition they state is "condition"; a standing limitation (an injury, a diet they must keep) is "constraint". If nothing durable was said, return { "facts": [] }. Prefer FEW high-confidence facts over many speculative ones.`;

const EXTRACTION_PROMPT_DE = `Du extrahierst DAUERHAFTE persönliche Fakten über die Nutzerin oder den Nutzer aus einem Coaching-Gespräch für das Langzeitgedächtnis des Assistenten. Gib ein JSON-Objekt zurück (kein Fließtext, keine Code-Zäune): { "facts": [ … ] }. Jedes Element: { "category": eines von preference|goal|context|condition|constraint|medication, "fact": "<ein kurzer beschreibender Satz>", "confidence": 0-100 }.
Extrahiere NUR Fakten, die STABIL sind und auch nächsten Monat noch zutreffen: dauerhafte Vorlieben, Bedingungen, die die Person SELBST über sich AUSSAGT, dauerhafte Ziele, dauerhafte Einschränkungen, dauerhafter Lebenskontext. Halte sie beschreibend in der eigenen Formulierung der Person fest — DIAGNOSTIZIERE NIEMALS, leite keine medizinische Bedingung ab, die die Person nicht selbst genannt hat, und erfasse keine Zahl oder Messung (die liegen in den Daten). SCHLIESSE AUS: vorübergehende Gefühle ("heute müde"), einmalige Ereignisse, alles Zeitgebundene, sensible Details über das fürs Coaching Nötige hinaus und alles, worum die Person gebeten hat, es zu vergessen. Ein Medikament, das die Person nach eigener Aussage nimmt, ist "medication"; eine genannte Diagnose oder Erkrankung ist "condition"; eine dauerhafte Einschränkung (eine Verletzung, eine einzuhaltende Ernährung) ist "constraint". Wenn nichts Dauerhaftes gesagt wurde, gib { "facts": [] } zurück. Bevorzuge WENIGE Fakten mit hoher Sicherheit gegenüber vielen spekulativen.`;

function extractionSystemPrompt(locale: string | undefined): string {
  return locale?.toLowerCase().startsWith("de")
    ? EXTRACTION_PROMPT_DE
    : EXTRACTION_PROMPT_EN;
}

// ---------------------------------------------------------------------------
// Zod gate for the model's JSON
// ---------------------------------------------------------------------------

const rawFactSchema = z.object({
  category: z.enum(COACH_FACT_CATEGORIES),
  fact: z.string().trim().min(1).max(FACT_MAX_CHARS),
  confidence: z.coerce.number().int().min(0).max(100),
});

const rawFactArraySchema = z.array(z.unknown());

/**
 * The model's list, wherever it put it. v1.41 — the prompt asks for
 * `{"facts":[…]}` because `runStatusCompletion` runs in JSON-object mode: an
 * OpenAI chain then cannot return a bare array at all, and an Anthropic chain
 * is told to reply with "a single JSON object". Asking for an array under that
 * mode made every non-Codex extraction fail to parse. A bare array (an older
 * prompt, a model that ignores the wrapper) still parses.
 */
export function readJsonList(content: string, key: string): unknown[] | null {
  const trimmed = content.trim();
  const candidates = [trimmed, extractJsonObject(trimmed)];
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenced) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    const direct = rawFactArraySchema.safeParse(json);
    if (direct.success) return direct.data;
    if (json !== null && typeof json === "object") {
      const nested = rawFactArraySchema.safeParse(
        (json as Record<string, unknown>)[key],
      );
      if (nested.success) return nested.data;
    }
  }
  return null;
}

interface ParsedFact {
  category: CoachFactCategory;
  fact: string;
  confidence: number;
}

/**
 * Parse the model output into validated facts. Returns `null` only when the
 * top-level JSON is unparseable (the caller then annotates `parse_failed`);
 * individual malformed items are dropped silently, not fatal.
 */
export function parseFacts(
  content: string,
): { facts: ParsedFact[]; dropped: number } | null {
  const list = readJsonList(content, "facts");
  if (list === null) return null;

  const facts: ParsedFact[] = [];
  let dropped = 0;
  for (const item of list) {
    const parsed = rawFactSchema.safeParse(item);
    if (parsed.success) {
      facts.push({
        category: parsed.data.category,
        fact: parsed.data.fact,
        confidence: Math.max(
          0,
          Math.min(100, Math.round(parsed.data.confidence)),
        ),
      });
    } else {
      dropped += 1;
    }
  }
  return { facts, dropped };
}

// ---------------------------------------------------------------------------
// De-dup — lowercase-normalise + token-overlap against the active set
// ---------------------------------------------------------------------------

const TOKEN_SPLIT = /[^a-z0-9äöüß]+/i;

export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(TOKEN_SPLIT)
      .filter((t) => t.length > 1),
  );
}

/** Jaccard-style overlap of the two token sets, 0..1. */
function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const DEDUP_OVERLAP_THRESHOLD = 0.6;

export function isNearDuplicate(
  candidate: string,
  existing: readonly string[],
): boolean {
  const cTokens = tokenSet(candidate);
  const cNorm = candidate.trim().toLowerCase();
  for (const ex of existing) {
    if (ex.trim().toLowerCase() === cNorm) return true;
    if (tokenOverlap(cTokens, tokenSet(ex)) >= DEDUP_OVERLAP_THRESHOLD)
      return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Conversation-turn loading
// ---------------------------------------------------------------------------

export function decryptOrNull(buf: Uint8Array): string | null {
  try {
    return decryptFromBytes(buf);
  } catch {
    return null;
  }
}

interface ActiveFactRow {
  id: string;
  factEncrypted: Uint8Array;
  category: string;
  confidence: number;
  source?: string;
}

/** One live fact, decrypted. `proposed` rows included: they count for de-dup. */
export interface ActiveFact {
  id: string;
  text: string;
  category: string;
  confidence: number;
  source: string;
}

/**
 * Load the live (not deleted) facts, proposals included, and decrypt them
 * fault-isolated (undecryptable rows skipped).
 */
export async function loadActiveFacts(
  db: Pick<typeof prisma, "coachFact">,
  userId: string,
): Promise<ActiveFact[]> {
  const rows = (await db.coachFact.findMany({
    where: { userId, deletedAt: null },
    select: {
      id: true,
      factEncrypted: true,
      category: true,
      confidence: true,
      source: true,
    },
  })) as ActiveFactRow[];

  const out: ActiveFact[] = [];
  for (const r of rows) {
    const text = decryptOrNull(r.factEncrypted);
    if (text === null) continue;
    out.push({
      id: r.id,
      text,
      category: r.category,
      confidence: r.confidence,
      source: r.source ?? "extracted",
    });
  }
  return out;
}

/**
 * Whether a fact is a health fact: filed under one, or worded like one. A
 * health fact is never saved without the person's tap.
 */
export function isHealthFact(category: string, text: string): boolean {
  return (
    HEALTH_MEMORY_CATEGORIES.has(category as CoachMemoryCategory) ||
    healthTermKind(text) !== null
  );
}

/** The source a background fact is written under: health facts wait. */
function backgroundSource(
  category: string,
  text: string,
  fallback: CoachFactSource,
): CoachFactSource {
  return isHealthFact(category, text) ? PROPOSED_FACT_SOURCE : fallback;
}

interface ConversationTurnRow {
  role: string;
  encryptedContent: Uint8Array;
}

/** Load the last `RECENT_TURNS_CAP` turns of a conversation, decrypted. */
async function loadRecentTurns(
  db: PrismaLike,
  conversationId: string,
  userId: string,
): Promise<Array<{ role: string; content: string }>> {
  const row = (await db.coachConversation.findFirst({
    where: { id: conversationId, userId },
    select: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: RECENT_TURNS_CAP,
        select: { role: true, encryptedContent: true },
      },
    },
  })) as { messages: ConversationTurnRow[] } | null;

  if (!row) return [];

  // Loaded newest-first; reverse to chronological for the prompt.
  const turns: Array<{ role: string; content: string }> = [];
  for (const m of [...row.messages].reverse()) {
    const content = decryptOrNull(m.encryptedContent);
    if (content === null) continue;
    // #781 — skip empty bodies: a cancelled-turn marker (an empty assistant
    // row closing an aborted turn) carries nothing to extract from.
    if (!content.trim()) continue;
    turns.push({ role: m.role, content });
  }
  return turns;
}

function buildUserPrompt(
  turns: Array<{ role: string; content: string }>,
  activeFacts: string[],
): string {
  const transcript = turns.map((t) => `${t.role}: ${t.content}`).join("\n");
  const existing =
    activeFacts.length > 0
      ? `\n\nEXISTING FACTS (do not re-emit these):\n${activeFacts.map((f) => `- ${f}`).join("\n")}`
      : "\n\nEXISTING FACTS: none";
  return `${transcript}${existing}`;
}

// ---------------------------------------------------------------------------
// Extraction entry point
// ---------------------------------------------------------------------------

/**
 * Extract durable facts from a conversation and persist the survivors.
 *
 * Returns:
 *  - `{status:"stored", count}` — at least one new fact persisted.
 *  - `{status:"none", count:0}` — the model produced nothing durable (or the
 *    JSON was unparseable, in which case `coach.facts.parse_failed` is annotated).
 *  - `{status:"skipped", count:0}` — no usable provider / timeout / error, or
 *    every candidate was a dup / dropped / displaced by the cap.
 */
export async function extractAndStoreFacts(
  conversationId: string,
  userId: string,
  opts?: ExtractOpts,
): Promise<{ status: "stored" | "none" | "skipped"; count: number }> {
  const db = opts?.prisma ?? prisma;
  const runCompletion = opts?.runCompletion ?? runStatusCompletion;

  const [active, turns] = await Promise.all([
    loadActiveFacts(db, userId),
    loadRecentTurns(db, conversationId, userId),
  ]);

  if (turns.length === 0) {
    return { status: "skipped", count: 0 };
  }

  const activeTexts = active.map((f) => f.text);
  const result = await runCompletion({
    userId,
    cacheAction: "coach.facts",
    capability: "coach",
    systemPrompt: extractionSystemPrompt(opts?.locale),
    userPrompt: buildUserPrompt(turns, activeTexts),
    temperature: 0.2,
    maxTokens: 300,
  });

  if (result.kind !== "ok") {
    return { status: "skipped", count: 0 };
  }

  const parsed = parseFacts(result.content);
  if (parsed === null) {
    annotate({
      action: { name: "coach.facts.parse_failed" },
      meta: { conversationId },
    });
    return { status: "none", count: 0 };
  }

  if (parsed.facts.length === 0) {
    return { status: "none", count: 0 };
  }

  // De-dup against the active set; grow the seen-set as we accept candidates
  // so two near-identical candidates in one batch can't both land.
  const seen = [...activeTexts];
  const accepted: ParsedFact[] = [];
  for (const cand of parsed.facts) {
    if (isNearDuplicate(cand.fact, seen)) continue;
    accepted.push(cand);
    seen.push(cand.fact);
  }

  if (accepted.length === 0) {
    return { status: "skipped", count: 0 };
  }

  // Cap enforcement: at/over cap, a candidate may only be stored if it is
  // strictly higher-confidence than the current lowest-confidence active fact
  // (the new row simply outranks it for injection; soft-delete/eviction of the
  // displaced row is the management surface's job, not the extractor's).
  let lowestActiveConfidence =
    active.length > 0 ? Math.min(...active.map((f) => f.confidence)) : -1;
  let remainingCapacity = MAX_FACTS_PER_USER - active.length;

  const toStore: ParsedFact[] = [];
  // Highest-confidence candidates first so a tight cap admits the best.
  for (const cand of [...accepted].sort(
    (a, b) => b.confidence - a.confidence,
  )) {
    if (remainingCapacity > 0) {
      toStore.push(cand);
      remainingCapacity -= 1;
      continue;
    }
    // At cap — only admit if strictly better than the weakest active fact.
    if (cand.confidence > lowestActiveConfidence) {
      toStore.push(cand);
      lowestActiveConfidence = cand.confidence;
    }
  }

  if (toStore.length === 0) {
    return { status: "skipped", count: 0 };
  }

  let proposed = 0;
  for (const f of toStore) {
    // Field-by-field, no spread (mass-assignment rule, CLAUDE.md). A health
    // fact waits for the person's tap; everything else is kept as extracted.
    const source = backgroundSource(f.category, f.fact, "extracted");
    if (source === PROPOSED_FACT_SOURCE) proposed += 1;
    await db.coachFact.create({
      data: {
        userId,
        factEncrypted: encryptToBytes(f.fact),
        category: f.category,
        confidence: f.confidence,
        sourceConversationId: conversationId,
        source,
      },
    });
  }

  annotate({
    action: { name: "coach.facts.extracted" },
    meta: { count: toStore.length, proposed, conversationId },
  });

  return { status: "stored", count: toStore.length };
}

// ---------------------------------------------------------------------------
// Deterministic always-remember extraction
// ---------------------------------------------------------------------------

/**
 * v1.16.1 — the LLM extraction above only runs once a conversation grows past
 * the history cap (the chat route enqueues the memory refresh at >20 turns),
 * so an allergy stated in the second message of a short chat never reached the
 * fact store at all. Allergies, intolerances and explicitly self-reported
 * diagnoses are the one category the Coach must NEVER drop, so they get a
 * deterministic, provider-free path that runs on every user message: a small
 * closed set of self-statement patterns ("ich habe eine X-Allergie", "I'm
 * allergic to X", …). Matches store as `condition` facts at confidence 95 —
 * high enough to displace at the cap and to rank into the injection top-N.
 *
 * The patterns stay deliberately narrow: they match explicit first-person
 * self-statements only, never an inferred or third-party condition, keeping
 * the "descriptive, never diagnostic" contract of the LLM prompt.
 */
export const DETERMINISTIC_FACT_CONFIDENCE = 95;

interface DeterministicPattern {
  re: RegExp;
  kind: "allergy" | "intolerance" | "diagnosis";
}

/**
 * v1.16.8 — closed filler-word tolerance. The original patterns
 * required the compound to follow "ich habe" immediately (modulo the
 * article), so a single conversational adverb — "ich habe übrigens
 * eine Erdnussallergie", "ich habe seit Jahren eine Pollenallergie" —
 * defeated the always-remember pass entirely. The filler list is a
 * CLOSED set of adverbs / temporal qualifiers / intensity adjectives:
 * an open `\w+` gap would let third-party clauses through ("ich habe
 * gehört dass seine …") and break the self-statement contract.
 */
const DE_FILLER =
  "(?:übrigens|auch|noch|außerdem|zudem|leider|schon|immer|seit|jahren|jahrzehnten|kindheit|geburt|kurzem|langem|der|eine?|'?ne|starke|leichte|schwere|ausgeprägte|diagnostizierte)";
const EN_FILLER =
  "(?:also|still|actually|unfortunately|always|btw|a|an|severe|mild|bad|slight|known|diagnosed)";

const DETERMINISTIC_PATTERNS: DeterministicPattern[] = [
  // German — allergies.
  {
    // "ich habe (übrigens / seit Jahren / …) eine Erdnussallergie" /
    // "ich hab 'ne Erdnuss-Allergie". The capture must be compounded
    // onto "-allergie" (no space) so the article in "eine Allergie
    // gegen X" can never be captured — that phrasing belongs to the
    // next pattern. Intervening words come only from the closed filler
    // list above.
    re: new RegExp(
      `\\bich\\s+hab(?:e)?\\s+(?:${DE_FILLER}\\s+){0,5}([a-zäöüß][\\wäöüß-]*?)-?allergie\\b`,
      "i",
    ),
    kind: "allergy",
  },
  {
    // "ich habe (auch / noch / …) eine Allergie gegen Erdnüsse" /
    // "ich bin (leider / auch / …) allergisch gegen/auf Erdnüsse"
    re: new RegExp(
      `\\bich\\s+(?:hab(?:e)?\\s+(?:${DE_FILLER}\\s+){0,5}allergie\\s+(?:gegen|auf)|bin\\s+(?:${DE_FILLER}\\s+){0,3}allergisch\\s+(?:gegen|auf))\\s+([a-zäöüß][\\wäöüß -]{1,40}?)(?=[.,;!?]|$)`,
      "im",
    ),
    kind: "allergy",
  },
  {
    // First-person possessive: "meine Erdnussallergie", "wegen meiner
    // Pollenallergie". A third-party owner ("die Allergie meiner
    // Schwester") never matches — the captured word must itself end in
    // "-allergie" right after the possessive.
    re: /\bmein(?:e|er)?\s+([a-zäöüß][\wäöüß-]*?)-?allergie\b/i,
    kind: "allergy",
  },
  // German — intolerances.
  {
    // "ich habe eine Laktoseunverträglichkeit / Laktose-Intoleranz".
    // Compound-only capture, same rationale as the allergy pattern.
    re: new RegExp(
      `\\bich\\s+hab(?:e)?\\s+(?:${DE_FILLER}\\s+){0,5}([a-zäöüß][\\wäöüß-]*?)-?(?:unverträglichkeit|intoleranz)\\b`,
      "i",
    ),
    kind: "intolerance",
  },
  {
    // "ich bin (übrigens / leider) laktoseintolerant"
    re: new RegExp(
      `\\bich\\s+bin\\s+(?:${DE_FILLER}\\s+){0,3}([a-zäöüß][\\wäöüß-]*?)[-\\s]?intolerant\\b`,
      "i",
    ),
    kind: "intolerance",
  },
  {
    // "meine Laktoseintoleranz" / "wegen meiner Histaminunverträglichkeit"
    re: /\bmein(?:e|er)?\s+([a-zäöüß][\wäöüß-]*?)-?(?:unverträglichkeit|intoleranz)\b/i,
    kind: "intolerance",
  },
  // German — explicit self-reported diagnosis.
  {
    // "bei mir wurde (kürzlich / übrigens) Asthma diagnostiziert"
    re: /\bbei\s+mir\s+wurde\s+(?:übrigens\s+|kürzlich\s+|gerade\s+|neulich\s+|letztes\s+jahr\s+)?([a-zäöüß][\wäöüß -]{1,40}?)\s+diagnostiziert\b/i,
    kind: "diagnosis",
  },
  // English — allergies.
  {
    // "I'm (also / severely) allergic to peanuts"
    re: new RegExp(
      `\\bI(?:'m|\\s+am)\\s+(?:(?:also|really|severely|very|quite|unfortunately|actually|still)\\s+){0,2}allergic\\s+to\\s+([a-z][\\w -]{1,40}?)(?=[.,;!?]|$)`,
      "im",
    ),
    kind: "allergy",
  },
  {
    // "I (also) have a (severe) peanut allergy"
    re: new RegExp(
      `\\bI\\s+(?:also\\s+|still\\s+|actually\\s+)?have\\s+(?:${EN_FILLER}\\s+){0,3}([a-z][\\w-]*)\\s+allergy\\b`,
      "i",
    ),
    kind: "allergy",
  },
  {
    // "my peanut allergy"
    re: /\bmy\s+([a-z][\w-]*)\s+allergy\b/i,
    kind: "allergy",
  },
  // English — intolerances.
  {
    // "I have a lactose intolerance" / "I'm lactose intolerant"
    re: new RegExp(
      `\\bI\\s+(?:also\\s+|still\\s+|actually\\s+)?have\\s+(?:${EN_FILLER}\\s+){0,3}([a-z][\\w-]*)\\s+intolerance\\b`,
      "i",
    ),
    kind: "intolerance",
  },
  {
    re: /\bI(?:'m|\s+am)\s+(?:(?:also|really|severely|very|quite|unfortunately|actually|still)\s+){0,2}([a-z][\w-]*)[-\s]intolerant\b/i,
    kind: "intolerance",
  },
  {
    // "my lactose intolerance"
    re: /\bmy\s+([a-z][\w-]*)\s+intolerance\b/i,
    kind: "intolerance",
  },
  // English — explicit self-reported diagnosis.
  {
    re: /\bI\s+(?:was|got)\s+(?:recently\s+|just\s+)?diagnosed\s+with\s+([a-z][\w -]{1,40}?)(?=[.,;!?]|$)/im,
    kind: "diagnosis",
  },
];

function cleanCapture(raw: string): string | null {
  const cleaned = raw
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/u, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 60) return null;
  return cleaned;
}

function deterministicFactText(
  kind: DeterministicPattern["kind"],
  subject: string,
  locale: string | undefined,
): string {
  // German only for a German reader; every other locale — and an absent one —
  // composes ENGLISH. The fact text is model-facing memory, so English is the
  // fallback body; the previous `?? true` made an unknown locale German.
  const de = locale?.toLowerCase().startsWith("de") ?? false;
  switch (kind) {
    case "allergy":
      return de
        ? `Allergie: ${subject} (eigene Angabe)`
        : `Allergy: ${subject} (self-reported)`;
    case "intolerance":
      return de
        ? `Unverträglichkeit: ${subject} (eigene Angabe)`
        : `Intolerance: ${subject} (self-reported)`;
    case "diagnosis":
      return de
        ? `Diagnose laut eigener Angabe: ${subject}`
        : `Self-reported diagnosis: ${subject}`;
  }
}

/**
 * Pure pattern pass over a single user message. Exported so the unit tests
 * pin the patterns without a DB. Returns zero or more `condition` facts.
 */
export function extractDeterministicFacts(
  message: string,
  locale?: string,
): ParsedFact[] {
  const out: ParsedFact[] = [];
  for (const { re, kind } of DETERMINISTIC_PATTERNS) {
    const match = re.exec(message);
    if (!match) continue;
    const subject = cleanCapture(match[1] ?? "");
    if (!subject) continue;
    const fact = deterministicFactText(kind, subject, locale);
    if (fact.length > FACT_MAX_CHARS) continue;
    out.push({
      category: "condition",
      fact,
      confidence: DETERMINISTIC_FACT_CONFIDENCE,
    });
  }
  return out;
}

/**
 * Run the deterministic pass on one user message and persist the survivors
 * (deduped against the active set). No provider call — safe to fire on every
 * turn from the chat route. Returns the number of facts stored.
 *
 * v1.41 — every match is a health fact (an allergy, an intolerance, a stated
 * diagnosis), so it is stored as `proposed`: never lost, never used before the
 * person confirms it, offered once at the next turn.
 */
export async function storeDeterministicFacts(args: {
  conversationId: string;
  userId: string;
  message: string;
  locale?: string;
  prisma?: PrismaLike;
}): Promise<number> {
  const db = args.prisma ?? prisma;

  const candidates = extractDeterministicFacts(args.message, args.locale);
  if (candidates.length === 0) return 0;

  const active = await loadActiveFacts(db, args.userId);
  const seen = active.map((f) => f.text);

  let stored = 0;
  for (const cand of candidates) {
    if (isNearDuplicate(cand.fact, seen)) continue;
    seen.push(cand.fact);
    // Field-by-field, no spread (mass-assignment rule, CLAUDE.md).
    await db.coachFact.create({
      data: {
        userId: args.userId,
        factEncrypted: encryptToBytes(cand.fact),
        category: cand.category,
        confidence: cand.confidence,
        sourceConversationId: args.conversationId,
        source: PROPOSED_FACT_SOURCE,
      },
    });
    stored += 1;
  }

  if (stored > 0) {
    annotate({
      action: { name: "coach.facts.deterministic_stored" },
      meta: { count: stored, conversationId: args.conversationId },
    });
  }
  return stored;
}
