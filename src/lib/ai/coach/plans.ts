/**
 * v1.21.3 (B1) — durable goal / if-then implementation-plan memory.
 *
 * The Coach learns the concrete PLANS a user agrees to in a conversation —
 * an implementation intention of the form "IF <cue> THEN <action>" attached
 * to a metric, with an optional target — and persists them encrypted at rest
 * so future turns can recall and review them instead of re-negotiating the
 * same plan cold. Plans are the user's OWN committed intentions, never a
 * prescription the Coach invents.
 *
 * Coach-proposes-then-user-confirms is the spine of the feature: the
 * extractor here only ever writes a plan as `status: "proposed"`. ONLY the
 * user-facing PATCH (`/api/coach/plans/[id]`) flips a plan to `active`. There
 * is no silent self-edit of the user's plan set — the extractor surfaces a
 * candidate; the user confirms it.
 *
 * `extractAndStorePlanProposals` is the background compute: load active +
 * proposed plans and the recent turns, run one bounded `runStatusCompletion`,
 * parse `{"plans":[…]}` (or a bare array), drop anything the Zod gate rejects,
 * de-dup against the existing set, enforce the caps, and persist survivors
 * field-by-field (no mass-assignment spread) as `proposed`.
 *
 * v1.41 — in a turn the Coach proposes a plan itself (`propose_plan`,
 * `memory/propose-plan.ts`) and the person takes it on with one tap; this
 * extraction is the net once a conversation has gone quiet. Active plans
 * reach every turn through the memory block (`memory/context-block.ts`).
 *
 * The cue / action / target TEXT is encrypted via `bytes-codec.ts` (the same
 * AES-256-GCM codec as `CoachFact`). `metric`, `status` and the dates stay
 * plain so the picker can rank / filter without paying a per-row decrypt.
 * Annotations carry counts + ids only — plan text is NEVER logged.
 *
 * Server-only — reads `@/lib/db`.
 */
import { z } from "zod";

import { prisma } from "@/lib/db";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { annotate } from "@/lib/logging/context";

import { decryptFromBytes, encryptToBytes } from "./bytes-codec";
import { readJsonList } from "./facts";
import { MAX_OPEN_PLAN_PROPOSALS } from "./memory/shared";
import { REMINDERS_INJECT_TOP_N } from "./reminders";

/**
 * App-side closed status enum (NOT a DB enum — matches the schema column).
 * v1.22 (W9, C2) adds the n-of-1 experiment lifecycle: `review_due` (the review
 * date passed) and `reviewed` (the read-back outcome was generated + stored).
 */
export const COACH_PLAN_STATUSES = [
  "proposed",
  "active",
  "met",
  "abandoned",
  "review_due",
  "reviewed",
] as const;

/** Hard cap on non-terminal (proposed + active) plans per user. */
export const MAX_PLANS_PER_USER = 25;
/** Per-field text length cap (mirrors the Zod gate + the prompt instruction). */
export const PLAN_FIELD_MAX_CHARS = 160;
/** How many active plans the memory block carries into a turn. */
export const PLANS_INJECT_TOP_N = 6;

/** Cap on recent turns fed into the extraction prompt (bounds prompt size). */
const RECENT_TURNS_CAP = 10;

type RunCompletionFn = typeof runStatusCompletion;
type PrismaLike = Pick<typeof prisma, "coachPlan" | "coachConversation">;
type ReminderPrismaLike = Pick<typeof prisma, "coachReminder">;

interface ExtractOpts {
  runCompletion?: RunCompletionFn;
  prisma?: PrismaLike;
  locale?: string;
}

// ---------------------------------------------------------------------------
// Extraction prompt (EN + DE mirror)
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT_EN = `You extract concrete implementation PLANS the user has AGREED to in a coaching conversation, for the assistant's long-term memory. A plan is an "if-then" intention tied to ONE metric. Return one JSON object (no prose, no fences): { "plans": [ … ] }. Each item: { "metric": "<short metric key, e.g. WEIGHT, SLEEP, BLOOD_PRESSURE, STEPS>", "ifCue": "<the trigger, one short clause>", "thenAction": "<the action, one short clause>", "target": "<optional plain target, or omit>" }.
ONLY extract a plan the user has clearly COMMITTED to in their own words ("I'll weigh myself every morning", "if I skip the gym I'll walk after dinner"). Record it descriptively in the user's framing — NEVER prescribe a plan the user did not agree to, never invent a clinical target, never record a raw measurement as a plan. EXCLUDE: vague wishes ("I should sleep more"), one-off intentions, and anything the user asked you to drop. If no concrete plan was agreed, return { "plans": [] }. Prefer FEW clear plans over many speculative ones.`;

const EXTRACTION_PROMPT_DE = `Du extrahierst konkrete UMSETZUNGS-PLÄNE, denen die Nutzerin oder der Nutzer in einem Coaching-Gespräch ZUGESTIMMT hat, für das Langzeitgedächtnis des Assistenten. Ein Plan ist eine "Wenn-dann"-Absicht, die an EINE Metrik gebunden ist. Gib ein JSON-Objekt zurück (kein Fließtext, keine Code-Zäune): { "plans": [ … ] }. Jedes Element: { "metric": "<kurzer Metrik-Schlüssel, z. B. WEIGHT, SLEEP, BLOOD_PRESSURE, STEPS>", "ifCue": "<der Auslöser, ein kurzer Satzteil>", "thenAction": "<die Handlung, ein kurzer Satzteil>", "target": "<optionales einfaches Ziel, oder weglassen>" }.
Extrahiere NUR einen Plan, zu dem sich die Person klar in eigenen Worten VERPFLICHTET hat ("ich wiege mich jeden Morgen", "wenn ich das Training auslasse, gehe ich nach dem Essen spazieren"). Halte ihn beschreibend in der Formulierung der Person fest — VERORDNE NIEMALS einen Plan, dem die Person nicht zugestimmt hat, erfinde kein klinisches Ziel und erfasse keine reine Messung als Plan. SCHLIESSE AUS: vage Wünsche ("ich sollte mehr schlafen"), einmalige Absichten und alles, worum die Person gebeten hat, es fallen zu lassen. Wenn kein konkreter Plan vereinbart wurde, gib { "plans": [] } zurück. Bevorzuge WENIGE klare Pläne gegenüber vielen spekulativen.`;

function extractionSystemPrompt(locale: string | undefined): string {
  return locale?.toLowerCase().startsWith("de")
    ? EXTRACTION_PROMPT_DE
    : EXTRACTION_PROMPT_EN;
}

// ---------------------------------------------------------------------------
// Zod gate for the model's JSON
// ---------------------------------------------------------------------------

const rawPlanSchema = z.object({
  metric: z.string().trim().min(1).max(60),
  ifCue: z.string().trim().min(1).max(PLAN_FIELD_MAX_CHARS),
  thenAction: z.string().trim().min(1).max(PLAN_FIELD_MAX_CHARS),
  target: z.string().trim().min(1).max(PLAN_FIELD_MAX_CHARS).optional(),
});

interface ParsedPlan {
  metric: string;
  ifCue: string;
  thenAction: string;
  target?: string;
}

/**
 * Parse the model output into validated plans. Returns `null` only when the
 * top-level JSON is unparseable (the caller then annotates `parse_failed`);
 * individual malformed items are dropped silently, not fatal.
 */
export function parsePlans(
  content: string,
): { plans: ParsedPlan[]; dropped: number } | null {
  // `{"plans":[…]}` under the JSON-object mode, or a bare array (`facts.ts`).
  const list = readJsonList(content, "plans");
  if (list === null) return null;

  const plans: ParsedPlan[] = [];
  let dropped = 0;
  for (const item of list) {
    const parsed = rawPlanSchema.safeParse(item);
    if (parsed.success) {
      const plan: ParsedPlan = {
        metric: parsed.data.metric,
        ifCue: parsed.data.ifCue,
        thenAction: parsed.data.thenAction,
      };
      if (parsed.data.target) plan.target = parsed.data.target;
      plans.push(plan);
    } else {
      dropped += 1;
    }
  }
  return { plans, dropped };
}

// ---------------------------------------------------------------------------
// De-dup — lowercase-normalise + token-overlap against the existing set
// ---------------------------------------------------------------------------

const TOKEN_SPLIT = /[^a-z0-9äöüß]+/i;

function tokenSet(text: string): Set<string> {
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

/** A plan's de-dup signature is its if-then prose (metric-agnostic). */
function planSignature(plan: ParsedPlan): string {
  return `${plan.ifCue} ${plan.thenAction}`;
}

function isNearDuplicate(candidate: string, existing: string[]): boolean {
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
// Loading
// ---------------------------------------------------------------------------

function decryptOrNull(buf: Uint8Array | null): string | null {
  if (!buf) return null;
  try {
    return decryptFromBytes(buf);
  } catch {
    return null;
  }
}

interface ExistingPlanRow {
  id: string;
  ifCueEncrypted: Uint8Array;
  thenActionEncrypted: Uint8Array;
  status: string;
}

/**
 * Load the non-terminal (proposed + active) plans and decrypt their if-then
 * signature fault-isolated (undecryptable rows skipped). Used both for the
 * cap count and for de-dup against the existing set.
 */
async function loadExistingPlans(
  db: PrismaLike,
  userId: string,
): Promise<Array<{ id: string; signature: string; status: string }>> {
  const rows = (await db.coachPlan.findMany({
    where: { userId, deletedAt: null, status: { in: ["proposed", "active"] } },
    select: {
      id: true,
      ifCueEncrypted: true,
      thenActionEncrypted: true,
      status: true,
    },
  })) as ExistingPlanRow[];

  const out: Array<{ id: string; signature: string; status: string }> = [];
  for (const r of rows) {
    const ifCue = decryptOrNull(r.ifCueEncrypted);
    const thenAction = decryptOrNull(r.thenActionEncrypted);
    if (ifCue === null || thenAction === null) continue;
    out.push({
      id: r.id,
      signature: `${ifCue} ${thenAction}`,
      status: r.status,
    });
  }
  return out;
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
  existingSignatures: string[],
): string {
  const transcript = turns.map((t) => `${t.role}: ${t.content}`).join("\n");
  const existing =
    existingSignatures.length > 0
      ? `\n\nEXISTING PLANS (do not re-emit these):\n${existingSignatures
          .map((p) => `- ${p}`)
          .join("\n")}`
      : "\n\nEXISTING PLANS: none";
  return `${transcript}${existing}`;
}

// ---------------------------------------------------------------------------
// Extraction entry point
// ---------------------------------------------------------------------------

/**
 * Extract concrete plans the user agreed to and persist the survivors as
 * `status: "proposed"` — the user confirms them through the PATCH route.
 *
 * Returns:
 *  - `{status:"stored", count}` — at least one new proposal persisted.
 *  - `{status:"none", count:0}` — the model produced nothing concrete (or the
 *    JSON was unparseable, in which case `coach.plans.parse_failed` is
 *    annotated).
 *  - `{status:"skipped", count:0}` — no usable provider / timeout / error, or
 *    every candidate was a dup / dropped / displaced by the cap.
 */
export async function extractAndStorePlanProposals(
  conversationId: string,
  userId: string,
  opts?: ExtractOpts,
): Promise<{ status: "stored" | "none" | "skipped"; count: number }> {
  const db = opts?.prisma ?? prisma;
  const runCompletion = opts?.runCompletion ?? runStatusCompletion;

  const [existing, turns] = await Promise.all([
    loadExistingPlans(db, userId),
    loadRecentTurns(db, conversationId, userId),
  ]);

  if (turns.length === 0) {
    return { status: "skipped", count: 0 };
  }

  const existingSignatures = existing.map((p) => p.signature);
  const result = await runCompletion({
    userId,
    cacheAction: "coach.plans",
    capability: "coach",
    systemPrompt: extractionSystemPrompt(opts?.locale),
    userPrompt: buildUserPrompt(turns, existingSignatures),
    temperature: 0.2,
    maxTokens: 400,
  });

  if (result.kind !== "ok") {
    return { status: "skipped", count: 0 };
  }

  const parsed = parsePlans(result.content);
  if (parsed === null) {
    annotate({
      action: { name: "coach.plans.parse_failed" },
      meta: { conversationId },
    });
    return { status: "none", count: 0 };
  }

  if (parsed.plans.length === 0) {
    return { status: "none", count: 0 };
  }

  // De-dup against the existing set; grow the seen-set as we accept candidates
  // so two near-identical candidates in one batch can't both land.
  const seen = [...existingSignatures];
  const accepted: ParsedPlan[] = [];
  for (const cand of parsed.plans) {
    const sig = planSignature(cand);
    if (isNearDuplicate(sig, seen)) continue;
    accepted.push(cand);
    seen.push(sig);
  }

  if (accepted.length === 0) {
    return { status: "skipped", count: 0 };
  }

  // Cap enforcement: never let proposals push the non-terminal set past the
  // per-user cap, and never hold more than `MAX_OPEN_PLAN_PROPOSALS` open
  // proposals at once. A person with a full set gets no new proposals until
  // they act on (confirm / decline) the ones they have, or those lapse.
  const openProposals = existing.filter((p) => p.status === "proposed").length;
  const remainingCapacity = Math.min(
    MAX_PLANS_PER_USER - existing.length,
    MAX_OPEN_PLAN_PROPOSALS - openProposals,
  );
  if (remainingCapacity <= 0) {
    return { status: "skipped", count: 0 };
  }
  const toStore = accepted.slice(0, remainingCapacity);

  for (const p of toStore) {
    // Field-by-field, no spread (mass-assignment rule, CLAUDE.md). Always
    // written as "proposed" — only the user-facing PATCH activates a plan.
    await db.coachPlan.create({
      data: {
        userId,
        metric: p.metric,
        ifCueEncrypted: encryptToBytes(p.ifCue),
        thenActionEncrypted: encryptToBytes(p.thenAction),
        targetEncrypted: p.target ? encryptToBytes(p.target) : null,
        status: "proposed",
        sourceConversationId: conversationId,
      },
    });
  }

  annotate({
    action: { name: "coach.plans.extracted" },
    meta: { count: toStore.length, conversationId },
  });

  return { status: "stored", count: toStore.length };
}

// ---------------------------------------------------------------------------
// v1.22 (W9, C2) — n-of-1 experiment outcome read-back block
// ---------------------------------------------------------------------------

/** How recent a reviewed experiment stays in the snapshot read-back block. */
const EXPERIMENT_OUTCOME_RECALL_DAYS = 30;
/** Max reviewed outcomes carried into the snapshot. */
const EXPERIMENT_OUTCOME_TOP_N = 3;
const EXPERIMENT_OUTCOME_RECALL_MS =
  EXPERIMENT_OUTCOME_RECALL_DAYS * 86_400_000;

/** One reviewed experiment as the snapshot read-back block carries it. */
export interface ExperimentOutcomeEntry {
  metric: string;
  /** The grounded, association-only read-back prose (decrypted). */
  outcome: string;
}

interface ReviewedPlanRow {
  metric: string;
  outcomeEncrypted: Uint8Array | null;
  updatedAt: Date;
}

/**
 * Build the experiment-outcome read-back block: recently-`reviewed` plans whose
 * `outcomeEncrypted` carries a grounded result, decrypted fault-isolated. This
 * is the C2 read-back surface; the caller (`snapshot.ts`) attaches it ONLY when
 * the experiment-verdict flag is on, so the user-visible read-back stays gated
 * until its live B0 cases clear. Returns `null` when nothing recent qualifies.
 */
export async function buildExperimentOutcomeBlock(
  userId: string,
  opts?: { prisma?: PrismaLike; now?: Date },
): Promise<{ experiments: ExperimentOutcomeEntry[] } | null> {
  const db = opts?.prisma ?? prisma;
  const now = opts?.now ?? new Date();
  const since = new Date(now.getTime() - EXPERIMENT_OUTCOME_RECALL_MS);

  const rows = (await db.coachPlan.findMany({
    where: {
      userId,
      deletedAt: null,
      status: "reviewed",
      outcomeEncrypted: { not: null },
      updatedAt: { gte: since },
    },
    orderBy: [{ updatedAt: "desc" }],
    take: EXPERIMENT_OUTCOME_TOP_N,
    select: { metric: true, outcomeEncrypted: true, updatedAt: true },
  })) as ReviewedPlanRow[];

  const experiments: ExperimentOutcomeEntry[] = [];
  for (const r of rows) {
    const outcome = decryptOrNull(r.outcomeEncrypted);
    if (outcome === null) continue;
    experiments.push({ metric: r.metric, outcome });
  }
  if (experiments.length === 0) return null;
  return { experiments };
}

// ---------------------------------------------------------------------------
// v1.22 (B2/B3) — episodic reminder recall sub-block
// ---------------------------------------------------------------------------

/**
 * How far ahead of `now` an active reminder enters the recall block. A
 * reminder due within this horizon (or already overdue) is "near" enough that
 * the Coach should reference it unprompted on the next message; a reminder due
 * far in the future stays dormant until its window approaches.
 */
const REMINDER_RECALL_HORIZON_DAYS = 3;
const REMINDER_RECALL_HORIZON_MS = REMINDER_RECALL_HORIZON_DAYS * 86_400_000;

/** One reminder as the snapshot recall block carries it. */
export interface CoachReminderInjectEntry {
  note: string;
  metric?: string;
  /** ISO due moment, when the reminder is date-triggered. */
  dueAt?: string;
  /** Lifecycle status (active | due | surfaced) for the model's framing. */
  status: string;
}

interface InjectReminderRow {
  noteEncrypted: Uint8Array;
  metric: string | null;
  dueAt: Date | null;
  status: string;
  updatedAt: Date;
}

/**
 * Build the recall sub-block: the reminders the Coach should reference next
 * time — anything already `due`/`surfaced` (the sweep flipped it and the user
 * has not resolved it) plus `active` reminders whose `dueAt` is near or overdue.
 * A recall-only `active` note (no `dueAt`) is also surfaced so the Coach honours
 * the user's explicit "remember this" even without a fire moment. Decrypt is
 * fault-isolated — an undecryptable row is skipped, never thrown. Returns `null`
 * when the user has nothing to recall.
 *
 * This is the read half of the episodic memory type; the write half lives in
 * `reminders.ts`. The memory block (`memory/context-block.ts`) carries it.
 */
export async function buildCoachRemindersBlock(
  userId: string,
  now: Date,
  opts?: { prisma?: ReminderPrismaLike },
): Promise<{ reminders: CoachReminderInjectEntry[] } | null> {
  const db = opts?.prisma ?? prisma;
  const horizon = new Date(now.getTime() + REMINDER_RECALL_HORIZON_MS);

  const rows = (await db.coachReminder.findMany({
    where: {
      userId,
      deletedAt: null,
      OR: [
        // Already surfaced by the sweep and not yet resolved.
        { status: { in: ["due", "surfaced"] } },
        // Active + near/overdue date trigger.
        { status: "active", dueAt: { lte: horizon } },
        // Active recall-only note (no fire moment) — honour the explicit ask.
        { status: "active", dueAt: null },
      ],
    },
    // Soonest-due first, then most-recently touched.
    orderBy: [{ dueAt: "asc" }, { updatedAt: "desc" }],
    take: REMINDERS_INJECT_TOP_N * 3,
    select: {
      noteEncrypted: true,
      metric: true,
      dueAt: true,
      status: true,
      updatedAt: true,
    },
  })) as InjectReminderRow[];

  const reminders: CoachReminderInjectEntry[] = [];
  for (const r of rows) {
    if (reminders.length >= REMINDERS_INJECT_TOP_N) break;
    const note = decryptOrNull(r.noteEncrypted);
    if (note === null) continue;
    const entry: CoachReminderInjectEntry = { note, status: r.status };
    if (r.metric) entry.metric = r.metric;
    if (r.dueAt) entry.dueAt = r.dueAt.toISOString();
    reminders.push(entry);
  }

  if (reminders.length === 0) return null;
  return { reminders };
}
