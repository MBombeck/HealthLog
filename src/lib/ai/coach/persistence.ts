/**
 * Persistence helpers for AI Coach conversations.
 *
 * Every message body crosses this module's encrypt boundary before
 * touching the database — the route layer never serialises raw text
 * directly. `encrypt()` / `decrypt()` from `src/lib/crypto.ts` stamp the
 * active key id into the ciphertext, so rotation works transparently.
 *
 * `metricSourceJson` is plain text on disk: it carries label-only
 * provenance (window names, metric tags, sample counts) and never raw
 * values, so it can be queried without decryption for analytics.
 */
import type { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { decryptFromBytes, encryptToBytes } from "./bytes-codec";
import {
  coachActivityMetaSchema,
  coachAssumptionSchema,
  coachClarificationSchema,
  coachFollowUpSchema,
  coachMemoryNoteMetaSchema,
  coachMethodSchema,
  coachPlanProposalMetaSchema,
  coachResultMetaSchema,
  coachResultTableSchema,
  coachStepSchema,
  coachStopSchema,
  coachTrailSchema,
} from "./stream-events";
import { ACTIVITY_MAX_ENTRIES, TRAIL_MAX_BYTES } from "./activity/contract";
import { commitTurnWrites } from "./memory/turn-writes";
import { COACH_CONVERSATION_TITLE_MAX } from "./types";
import { isRedundantViewChip } from "./follow-ups/view-chip";
import {
  MAX_RESULTS_PER_TURN,
  RESULTS_MAX_BYTES,
  fitResultsToStorage,
} from "./results/refs";
import {
  isCheckupIntervalId,
  isSuggestedActionType,
  type CoachSuggestedAction,
} from "./suggest-action";

import type {
  CoachClarification,
  CoachConversationAttachmentDTO,
  CoachConversationDTO,
  CoachConversationDetailDTO,
  CoachFollowUp,
  CoachMessageDTO,
  CoachMessageRole,
  CoachMethod,
  CoachProvenance,
  CoachResultEntry,
  CoachResultMeta,
  CoachResultTable,
  CoachStep,
  CoachStepDomain,
  CoachSuggestion,
  CoachTrail,
} from "./types";

/**
 * Title-from-message — first 80 chars trimmed, ellipsis on overflow.
 * Callers should pass already-sanitised input. The result is stored
 * encrypted (`titleEncrypted`, v1.39.3): it is the opening words of the
 * person's first message, which is as sensitive as the message itself.
 */
export function summariseTitle(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "New conversation";
  // Spread to a code-point array so the slice respects multi-code-unit
  // characters (emoji like "🩺" land as a single grapheme rather than
  // a half "?"). The visible-length metric is grapheme count, not
  // UTF-16 code units.
  const points = [...collapsed];
  if (points.length <= COACH_CONVERSATION_TITLE_MAX) return collapsed;
  // Cut at TITLE_MAX-1 code points and append a single-character
  // ellipsis so the visible width matches TITLE_MAX. Cuts at the word
  // boundary when one is within reach of the limit.
  const sliced = points.slice(0, COACH_CONVERSATION_TITLE_MAX - 1).join("");
  const lastSpace = sliced.lastIndexOf(" ");
  const cut =
    lastSpace > COACH_CONVERSATION_TITLE_MAX - 20
      ? sliced.slice(0, lastSpace)
      : sliced;
  return `${cut.trimEnd()}…`;
}

/** At most this many tables per message (`r1`..`r8`, v1.41). */
const MAX_RESULTS_PER_MESSAGE = MAX_RESULTS_PER_TURN;

function provenanceToJson(provenance: CoachProvenance | null): string | null {
  if (!provenance) return null;
  return JSON.stringify(provenance);
}

/**
 * v1.32.14 — defensive restore of the cadence-suggestion card. The value was
 * server-written (JSON.stringify of the envelope the server itself built), yet a
 * persisted blob is parsed shape-first and never blindly trusted: every field
 * must be the expected type or the whole card is dropped, mirroring the keyValues
 * restore. Fixes the reload gap where a persisted card silently vanished.
 */
function restoreSuggestion(raw: unknown): CoachSuggestion | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.cadenceId === "string" &&
    typeof c.measurementType === "string" &&
    typeof c.label === "string"
  ) {
    return {
      cadenceId: c.cadenceId,
      measurementType: c.measurementType,
      label: c.label,
    };
  }
  return undefined;
}

/**
 * v1.32.14 — defensive restore of the confirm→apply action card. Validates the
 * discriminated `params` against the SAME closed allowlists the write path used
 * (`isSuggestedActionType`, `isCheckupIntervalId`); anything that fails the shape
 * check is dropped rather than trusted. Fixes the reload gap.
 */
function restoreSuggestedAction(
  raw: unknown,
): CoachSuggestedAction | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.actionType !== "string" ||
    !isSuggestedActionType(c.actionType) ||
    typeof c.summary !== "string" ||
    typeof c.titleKey !== "string" ||
    !c.params ||
    typeof c.params !== "object"
  ) {
    return undefined;
  }
  const p = c.params as Record<string, unknown>;
  if (c.actionType === "checkup.create") {
    if (
      p.actionType === "checkup.create" &&
      typeof p.label === "string" &&
      typeof p.interval === "string" &&
      isCheckupIntervalId(p.interval)
    ) {
      return {
        actionType: "checkup.create",
        summary: c.summary,
        titleKey: c.titleKey,
        params: {
          actionType: "checkup.create",
          label: p.label,
          interval: p.interval,
        },
      };
    }
    return undefined;
  }
  // reminder.note — `note` required, `when` / `metric` optional strings.
  if (p.actionType === "reminder.note" && typeof p.note === "string") {
    return {
      actionType: "reminder.note",
      summary: c.summary,
      titleKey: c.titleKey,
      params: {
        actionType: "reminder.note",
        note: p.note,
        ...(typeof p.when === "string" ? { when: p.when } : {}),
        ...(typeof p.metric === "string" ? { metric: p.metric } : {}),
      },
    };
  }
  return undefined;
}

/**
 * v1.32.14 — defensive restore of the retrieval-tool trace ("what I looked at").
 * Keeps only well-formed `{ name, present }` entries; an empty or malformed array
 * restores to undefined. Fixes the reload gap.
 */
function restoreToolCalls(raw: unknown): CoachProvenance["toolCalls"] {
  if (!Array.isArray(raw)) return undefined;
  const cleaned: Array<{ name: string; present: boolean }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.name === "string" && typeof c.present === "boolean") {
      cleaned.push({ name: c.name, present: c.present });
    }
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * v1.39.4 — restore an array field of the provenance entry by entry against
 * the wire schema. A malformed entry is dropped, not the whole field; an
 * empty or absent array restores to undefined. The schemas strip keys they do
 * not know, so a stored blob can never widen what a reader sees.
 */
function restoreEach<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  cap: number,
): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned: T[] = [];
  for (const item of raw.slice(0, cap)) {
    const parsed = schema.safeParse(item);
    if (parsed.success) cleaned.push(parsed.data);
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/** One field of the provenance against its wire schema, or undefined. */
function restoreOne<T>(raw: unknown, schema: z.ZodType<T>): T | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The live steps a turn persisted (at most 48 per turn since v1.41). */
function restoreSteps(raw: unknown): CoachStep[] | undefined {
  return restoreEach(raw, coachStepSchema, 48);
}

/** The method line; dropped whole when it does not parse. */
function restoreMethod(raw: unknown): CoachMethod | undefined {
  const parsed = coachMethodSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The tables' metadata (at most 8 per message). No values live here. */
function restoreResultMetas(raw: unknown): CoachResultMeta[] | undefined {
  return restoreEach(raw, coachResultMetaSchema, MAX_RESULTS_PER_MESSAGE);
}

/** The chips offered under the reply (at most 3). */
function restoreFollowUps(raw: unknown): CoachFollowUp[] | undefined {
  return restoreEach(raw, coachFollowUpSchema, 3);
}

/** The clarification choices; dropped whole when they do not parse. */
function restoreClarification(raw: unknown): CoachClarification | undefined {
  const parsed = coachClarificationSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function provenanceFromJson(raw: string | null): CoachProvenance | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CoachProvenance>;
    if (!parsed || typeof parsed !== "object") return null;
    const windows = Array.isArray(parsed.windows)
      ? (parsed.windows.filter((w) => typeof w === "string") as ReadonlyArray<
          CoachProvenance["windows"][number]
        >)
      : [];
    const metrics = Array.isArray(parsed.metrics)
      ? (parsed.metrics.filter((m) => typeof m === "string") as ReadonlyArray<
          CoachProvenance["metrics"][number]
        >)
      : [];
    const counts =
      parsed.counts && typeof parsed.counts === "object"
        ? (parsed.counts as CoachProvenance["counts"])
        : undefined;
    // v1.4.22 — keyValues are persisted alongside the existing
    // windows/metrics/counts envelope so the evidence-block disclosure
    // re-renders on conversation reload. Defensive shape check to
    // tolerate legacy rows (no keyValues field) without throwing.
    let keyValues: CoachProvenance["keyValues"];
    if (Array.isArray(parsed.keyValues)) {
      const cleaned: Array<{
        label: string;
        value: string;
        unit?: string;
        window?: string;
      }> = [];
      for (const raw of parsed.keyValues) {
        if (!raw || typeof raw !== "object") continue;
        const candidate = raw as {
          label?: unknown;
          value?: unknown;
          unit?: unknown;
          window?: unknown;
        };
        if (
          typeof candidate.label !== "string" ||
          typeof candidate.value !== "string"
        ) {
          continue;
        }
        const entry: {
          label: string;
          value: string;
          unit?: string;
          window?: string;
        } = { label: candidate.label, value: candidate.value };
        if (typeof candidate.unit === "string") entry.unit = candidate.unit;
        if (typeof candidate.window === "string")
          entry.window = candidate.window;
        cleaned.push(entry);
      }
      if (cleaned.length > 0) keyValues = cleaned;
    }
    // v1.32.9 — the persisted per-turn tool figures the Grounding Ledger recalls
    // on a later turn. Bare finite numbers only; a legacy row without the field
    // is tolerated (undefined).
    let groundedFigures: CoachProvenance["groundedFigures"];
    if (Array.isArray(parsed.groundedFigures)) {
      const nums = parsed.groundedFigures.filter(
        (n): n is number => typeof n === "number" && Number.isFinite(n),
      );
      if (nums.length > 0) groundedFigures = nums;
    }
    // v1.32.14 — count of figures the grounding guard withheld from this reply.
    // Positive integer only; a legacy row without the field, a non-number, or a
    // zero/negative value restores to undefined (no notice).
    let unverifiedFigures: number | undefined;
    if (
      typeof parsed.unverifiedFigures === "number" &&
      Number.isInteger(parsed.unverifiedFigures) &&
      parsed.unverifiedFigures > 0
    ) {
      unverifiedFigures = parsed.unverifiedFigures;
    }
    // v1.32.14 — the action cards + tool trace were serialised on write but
    // previously dropped here, so they silently vanished on every conversation
    // reload despite the render layer expecting them to survive. Restore them
    // (defensively parsed) so the suggestion card, action card, and "what I
    // looked at" trace re-render.
    const suggestion = restoreSuggestion(parsed.suggestion);
    const suggestedAction = restoreSuggestedAction(parsed.suggestedAction);
    const toolCalls = restoreToolCalls(parsed.toolCalls);
    // v1.39.4 — the dialog fields: steps, method, table metadata, chips, the
    // clarification choices, and the forced-answer marker.
    const steps = restoreSteps(parsed.steps);
    const method = restoreMethod(parsed.method);
    const results = restoreResultMetas(parsed.results);
    // A reply stored before view chips were withheld for a table the answer
    // already shows with its own toggle reads back without them.
    const followUps = restoreFollowUps(parsed.followUps)?.filter(
      (chip) => !isRedundantViewChip(chip, results ?? []),
    );
    const clarification = restoreClarification(parsed.clarification);
    const forcedFinal = parsed.forcedFinal === true;
    // v1.41 — the trail's metadata, the stop, the assumptions, the fact
    // note and the plan proposal, each held to its wire schema.
    const activity = restoreEach(
      parsed.activity,
      coachActivityMetaSchema,
      ACTIVITY_MAX_ENTRIES,
    );
    const stop = restoreOne(parsed.stop, coachStopSchema);
    const assumptions = restoreEach(
      parsed.assumptions,
      coachAssumptionSchema,
      2,
    );
    const memoryNote = restoreOne(parsed.memoryNote, coachMemoryNoteMetaSchema);
    const planProposal = restoreOne(
      parsed.planProposal,
      coachPlanProposalMetaSchema,
    );
    const continuationOf =
      typeof parsed.continuationOf === "string" &&
      parsed.continuationOf.length > 0 &&
      parsed.continuationOf.length <= 64
        ? parsed.continuationOf
        : undefined;
    return {
      windows,
      metrics,
      counts,
      ...(keyValues ? { keyValues } : {}),
      ...(groundedFigures ? { groundedFigures } : {}),
      ...(suggestion ? { suggestion } : {}),
      ...(suggestedAction ? { suggestedAction } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      ...(unverifiedFigures !== undefined ? { unverifiedFigures } : {}),
      ...(steps ? { steps } : {}),
      ...(method ? { method } : {}),
      ...(results ? { results } : {}),
      ...(followUps && followUps.length > 0 ? { followUps } : {}),
      ...(clarification ? { clarification } : {}),
      ...(forcedFinal ? { forcedFinal: true as const } : {}),
      ...(continuationOf ? { continuationOf } : {}),
      ...(activity ? { activity } : {}),
      ...(stop ? { stop } : {}),
      ...(assumptions ? { assumptions } : {}),
      ...(memoryNote ? { memoryNote } : {}),
      ...(planProposal ? { planProposal } : {}),
    };
  } catch {
    return null;
  }
}

export interface CreateConversationParams {
  userId: string;
  title: string;
  /**
   * v1.29.x (S7) — create the conversation as a FENCED thread (sets the sticky
   * `documentScoped` flag). Omitted / false = a normal Coach conversation.
   */
  documentScoped?: boolean;
  /**
   * v1.29.x (S7) — the initial attachment set (join rows). The CALLER must have
   * validated every id (owned + live + indexed + within cap) before passing them
   * — this helper only writes the rows. Composite PK makes duplicates a no-op.
   */
  attachmentIds?: string[];
}

export interface AppendMessageParams {
  conversationId: string;
  role: CoachMessageRole;
  content: string;
  metricSource?: CoachProvenance | null;
  providerType?: string | null;
  promptVersion?: string | null;
  /**
   * v1.18.9 — per-turn token count + model the reply was produced with,
   * persisted so the quiet token footer survives a reload. Omitted on
   * user turns and refusals (no token count to record).
   */
  tokensUsed?: number | null;
  model?: string | null;
  /**
   * v1.39.4 — the tables of values this turn read. Encrypted into
   * `resultsEncrypted`; their metadata rides `metricSource.results`. Omitted
   * or empty on every turn without a table.
   */
  results?: CoachResultTable[];
  /**
   * v1.41 — the model text of the turn's trail and the facts it touched.
   * Encrypted into `trailEncrypted`; the structure rides
   * `metricSource.activity`. Omitted on every turn without one.
   */
  trail?: CoachTrail | null;
}

export { RESULTS_MAX_BYTES };

/**
 * Serialise a turn's trail for the ciphertext column, or null when there is
 * none. Over `TRAIL_MAX_BYTES` (the recorder already holds it under): the
 * texts go first, then the titles, and a trail that still does not fit is
 * not stored at all rather than cut mid-entry.
 */
function trailToBytes(
  trail: CoachTrail | null | undefined,
): Uint8Array<ArrayBuffer> | null {
  if (!trail) return null;
  const parsed = coachTrailSchema.safeParse(trail);
  if (!parsed.success) return null;
  const copy: CoachTrail = {
    ...parsed.data,
    entries: parsed.data.entries.map((entry) => ({ ...entry })),
  };
  const size = () => new TextEncoder().encode(JSON.stringify(copy)).byteLength;
  for (const field of ["text", "title"] as const) {
    for (const entry of copy.entries) {
      if (size() <= TRAIL_MAX_BYTES) break;
      delete entry[field];
    }
  }
  if (size() > TRAIL_MAX_BYTES) return null;
  return encryptToBytes(JSON.stringify(copy));
}

/**
 * Serialise a turn's tables for the ciphertext column, or null when there are
 * none. The turn already fitted them (`fitResultsToStorage`, before it
 * streamed them); fitting again here only guards a caller that did not.
 */
function resultsToBytes(
  results: CoachResultTable[] | undefined,
): Uint8Array<ArrayBuffer> | null {
  if (!results || results.length === 0) return null;
  const kept = fitResultsToStorage(results.slice(0, MAX_RESULTS_PER_MESSAGE));
  return kept.length > 0 ? encryptToBytes(JSON.stringify(kept)) : null;
}

/**
 * Create a brand-new conversation row owned by `userId`. Caller is
 * expected to immediately append the first user message.
 */
/**
 * v1.39.3 — the title's at-rest form. Always a ciphertext: `summariseTitle`
 * never returns an empty string and a rename is validated non-empty, so there
 * is no "no title" case to store as NULL.
 */
export function encryptConversationTitle(
  title: string,
): Uint8Array<ArrayBuffer> {
  return encryptToBytes(title);
}

/**
 * v1.39.3 — read a conversation title, ciphertext first. The readable column
 * is consulted only when there is no ciphertext, which is a row the free-text
 * encryption backfill has not reached yet. A present ciphertext that does not
 * decrypt throws, the same fail-closed posture as every note reader
 * (`readNote`); it never falls back to the readable column.
 */
export function readConversationTitle(row: {
  title: string | null;
  titleEncrypted: Uint8Array | null;
}): string {
  if (row.titleEncrypted && row.titleEncrypted.byteLength > 0) {
    return decryptFromBytes(row.titleEncrypted);
  }
  return row.title ?? "";
}

export async function createConversation(
  params: CreateConversationParams,
): Promise<CoachConversationDTO> {
  const attachmentIds = params.attachmentIds ?? [];
  const title = summariseTitle(params.title);
  const row = await prisma.$transaction(async (tx) => {
    const conversation = await tx.coachConversation.create({
      data: {
        userId: params.userId,
        titleEncrypted: encryptConversationTitle(title),
        documentScoped: params.documentScoped ?? false,
      },
    });
    if (attachmentIds.length > 0) {
      await tx.coachConversationDocument.createMany({
        // Composite PK — a duplicate id is skipped rather than throwing.
        data: attachmentIds.map((documentId) => ({
          conversationId: conversation.id,
          documentId,
        })),
        skipDuplicates: true,
      });
    }
    return conversation;
  });
  return {
    id: row.id,
    title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messageCount: 0,
    // The attachment labels are resolved lazily by the list/detail reads (which
    // join the document); create does not join, so a fresh thread reports the
    // fenced flag but an empty attachment list until reloaded.
    fenced: row.documentScoped,
    attachments: [],
    documentTitle: null,
  };
}

/**
 * v1.29.x (S7) — resolve a joined document's badge title: its user-given
 * `title`, falling back to the `filename`, or null when neither is set. Both
 * columns are plaintext already (see the schema note on `InboundDocument.title`),
 * so this leaks no health values the row did not already carry in the clear.
 */
function resolveDocumentTitle(
  document: { title: string | null; filename: string | null } | null,
): string | null {
  if (!document) return null;
  return document.title ?? document.filename ?? null;
}

/**
 * v1.29.x (S7) — map a conversation's included join rows to the attachment DTO
 * list (ordered by attach time), skipping any row whose document join is missing
 * (a corrupted/foreign row the owner-scoped `document` select could not resolve).
 */
function mapAttachments(
  rows: ReadonlyArray<{
    documentId: string;
    document: { title: string | null; filename: string | null } | null;
  }>,
): CoachConversationAttachmentDTO[] {
  return rows.map((r) => ({
    documentId: r.documentId,
    title: resolveDocumentTitle(r.document),
  }));
}

/**
 * Append one message to an existing conversation. Bumps the parent
 * `updatedAt` so the history rail orders by most-recent-activity.
 */
export async function appendMessage(
  params: AppendMessageParams,
): Promise<CoachMessageDTO> {
  const result = await prisma.$transaction(async (tx) => {
    const message = await tx.coachMessage.create({
      data: {
        conversationId: params.conversationId,
        role: params.role,
        encryptedContent: encryptToBytes(params.content),
        metricSourceJson: provenanceToJson(params.metricSource ?? null),
        providerType: params.providerType ?? null,
        promptVersion: params.promptVersion ?? null,
        tokensUsed: params.tokensUsed ?? null,
        model: params.model ?? null,
        resultsEncrypted: resultsToBytes(params.results),
        trailEncrypted: trailToBytes(params.trail),
      },
    });
    await tx.coachConversation.update({
      where: { id: params.conversationId },
      data: { updatedAt: new Date() },
    });
    // v1.41 — the fact and the plan the turn's tools kept are written with
    // the answer that carries them, never before (`memory/turn-writes.ts`).
    if (params.role === "assistant") {
      await commitTurnWrites(tx, {
        conversationId: params.conversationId,
        provenance: params.metricSource,
      });
    }
    return message;
  });

  return {
    id: result.id,
    role: result.role as CoachMessageRole,
    content: params.content,
    createdAt: result.createdAt.toISOString(),
    metricSource: provenanceFromJson(result.metricSourceJson),
    providerType: result.providerType,
    promptVersion: result.promptVersion,
    tokensUsed: result.tokensUsed,
    model: result.model,
  };
}

export interface RecordProactiveNudgeParams {
  userId: string;
  /** Conversation title (the nudge headline) — summarised to ≤80 chars. */
  title: string;
  /** The nudge body, persisted as the initial ASSISTANT message. */
  body: string;
}

/**
 * v1.18.6 (CCH-02) — record a proactive Coach nudge as a real
 * conversation so it shows up in the conversation rail regardless of
 * which push channel (if any) the user configured. The proactive cron
 * used to dispatch a notification ONLY; with no push channel the nudge
 * was entirely invisible.
 *
 * Creates a fresh conversation and writes the nudge as the initial
 * ASSISTANT message in one transaction so a partial write never leaves
 * an empty thread in the rail. The body crosses the same
 * `encryptToBytes` boundary as every other Coach message, so the nudge
 * text is encrypted at rest like a normal reply. Returns the new
 * conversation + message ids for the caller's annotation.
 */
export async function recordProactiveNudge(
  params: RecordProactiveNudgeParams,
): Promise<{ conversationId: string; messageId: string; createdAt: Date }> {
  return prisma.$transaction(async (tx) => {
    const conversation = await tx.coachConversation.create({
      data: {
        userId: params.userId,
        titleEncrypted: encryptConversationTitle(summariseTitle(params.title)),
      },
    });
    const message = await tx.coachMessage.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        encryptedContent: encryptToBytes(params.body),
        metricSourceJson: null,
        // Tags the message as a proactive nudge — the cron's frequency gate
        // reads this back to cap rail conversations for no-push-channel users.
        providerType: "nudge",
        promptVersion: null,
      },
    });
    // The conversation's `createdAt` == `updatedAt` on creation, so the
    // rail already orders it to the top; no extra `update` needed.
    return {
      conversationId: conversation.id,
      messageId: message.id,
      createdAt: message.createdAt,
    };
  });
}

// Very long threads previously decrypted every message on each open; the
// newest messages up to this cap cover the rendered window without the
// unbounded per-open AES-decrypt cost. The response shape is unchanged —
// the messages array still arrives oldest->newest (see the reverse below).
const CONVERSATION_MESSAGE_DETAIL_CAP = 200;

/**
 * Fetch one conversation + its messages, decrypting each body on
 * read. Returns null when the conversation does not exist OR when the
 * supplied `userId` does not own it — callers should map both cases to
 * a 404 to avoid an existence-leak side channel.
 *
 * Only the newest `CONVERSATION_MESSAGE_DETAIL_CAP` messages are loaded
 * and decrypted; the result stays ascending so the response envelope is
 * byte-for-byte the same shape callers already consume.
 */
export async function fetchConversationWithMessages(
  userId: string,
  conversationId: string,
  /**
   * v1.29.x (S7) — optional surface isolation, fail-closed. The reader is always
   * `userId`-narrowed; these narrow further:
   *   - `documentScoped` — require the sticky flag to equal this value. The tool
   *     route passes `false` (a fenced thread 404s there); the fenced endpoint
   *     passes `true` (a plain tool thread 404s there). One mode per conversation,
   *     both directions.
   *   - `attachedDocumentId` — additionally require a LIVE join row for this
   *     document (and `documentScoped: true`). The single-doc sheet route passes
   *     the path id so it can only ever load a conversation that actually holds
   *     that document. Never combined with `documentScoped`.
   */
  opts?: {
    documentScoped?: boolean;
    attachedDocumentId?: string;
    /**
     * v1.39.4 — also count the assistant messages older than the loaded
     * window (`earlierAssistantMessages`), so a turn names earlier tables by
     * their place in the whole conversation. One count, read only when the
     * window is full.
     */
    countEarlierAssistant?: boolean;
  },
): Promise<CoachConversationDetailDTO | null> {
  const row = await prisma.coachConversation.findFirst({
    where: {
      id: conversationId,
      userId,
      ...(opts?.documentScoped !== undefined
        ? { documentScoped: opts.documentScoped }
        : {}),
      ...(opts?.attachedDocumentId
        ? {
            documentScoped: true,
            attachments: { some: { documentId: opts.attachedDocumentId } },
          }
        : {}),
    },
    include: {
      messages: {
        // Fetch the newest N first, then restore ascending order in code
        // so the unbounded per-open decrypt cost is capped without
        // changing the oldest->newest contract the client renders.
        orderBy: { createdAt: "desc" },
        take: CONVERSATION_MESSAGE_DETAIL_CAP,
        // v1.39.4 — the tables are read lazily, one message at a time, through
        // `readMessageResults`; the detail read never loads their ciphertext.
        // v1.41 — and the trail, read the same way (`readMessageTrail`).
        omit: { resultsEncrypted: true, trailEncrypted: true },
      },
      // v1.29.x (S7) — the LIVE attachment set (join → document label columns
      // only; the encrypted body is untouched), ordered by attach time. Always
      // loaded: the tool route's drift guard reads the count, and the fenced
      // pipeline reads the ids as its grounding context.
      attachments: {
        orderBy: { addedAt: "asc" },
        include: { document: { select: { title: true, filename: true } } },
      },
    },
  });
  if (!row) return null;

  const orderedMessages = [...row.messages].reverse();
  const messages: CoachMessageDTO[] = orderedMessages.map((m) => ({
    id: m.id,
    role: m.role as CoachMessageRole,
    content: decryptFromBytes(m.encryptedContent),
    createdAt: m.createdAt.toISOString(),
    metricSource: provenanceFromJson(m.metricSourceJson),
    providerType: m.providerType,
    promptVersion: m.promptVersion,
    tokensUsed: m.tokensUsed,
    model: m.model,
  }));

  // v1.11.1 — decrypt the rolling conversation summary (fail-closed: an
  // undecryptable row is treated as absent so the chat turn never throws and
  // simply falls back to the placeholder).
  let summary: string | null = null;
  if (row.summaryEncrypted && row.summaryEncrypted.byteLength > 0) {
    try {
      summary = decryptFromBytes(row.summaryEncrypted);
    } catch {
      summary = null;
    }
  }

  const attachments = mapAttachments(row.attachments);
  const oldestLoaded = orderedMessages[0];
  const earlierAssistantMessages =
    opts?.countEarlierAssistant &&
    oldestLoaded &&
    row.messages.length >= CONVERSATION_MESSAGE_DETAIL_CAP
      ? await prisma.coachMessage.count({
          where: {
            conversationId: row.id,
            role: "assistant",
            createdAt: { lt: oldestLoaded.createdAt },
          },
        })
      : undefined;
  return {
    id: row.id,
    title: readConversationTitle(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messageCount: messages.length,
    messages,
    summary,
    fenced: row.documentScoped,
    attachments,
    attachmentCount: attachments.length,
    documentTitle: attachments[0]?.title ?? null,
    ...(earlierAssistantMessages !== undefined
      ? { earlierAssistantMessages }
      : {}),
  };
}

/**
 * v1.39.4 — the stored tables of one assistant message, for its owner.
 *
 * Narrowed like the conversation read: the message must sit in a
 * conversation `userId` owns, and a foreign or missing id is null (the route
 * answers 404 for both, so existence never leaks across accounts).
 *
 * One entry per table the message's provenance lists, in that order. A
 * table is served whole or withheld with a reason, never partially:
 *   - `module_disabled` — `withhold(domain)` said the table's domain is
 *     switched off for the record now. Such a table is not even decrypted.
 *   - `unavailable` — the ciphertext did not decrypt, did not parse, or did
 *     not carry that ref (a table dropped at the size ceiling). Fail closed
 *     and say so, rather than serve nothing silently.
 */
export async function readMessageResults(
  userId: string,
  conversationId: string,
  messageId: string,
  withhold: (domain: CoachStepDomain) => boolean = () => false,
): Promise<CoachResultEntry[] | null> {
  const row = await prisma.coachMessage.findFirst({
    where: {
      id: messageId,
      conversationId,
      conversation: { userId },
    },
    select: { metricSourceJson: true, resultsEncrypted: true },
  });
  if (!row) return null;

  const metas = provenanceFromJson(row.metricSourceJson)?.results ?? [];
  if (metas.length === 0) return [];

  const served = metas.filter((meta) => !withhold(meta.source.domain));
  const tables =
    served.length > 0 ? decryptResultTables(row.resultsEncrypted) : null;

  return metas.map((meta): CoachResultEntry => {
    if (withhold(meta.source.domain)) {
      return { ref: meta.ref, withheld: "module_disabled" };
    }
    const table = tables?.get(meta.ref);
    return table ?? { ref: meta.ref, withheld: "unavailable" };
  });
}

/**
 * v1.41 — the stored trail text of one assistant message, for its owner.
 *
 * Narrowed like `readMessageResults`: the message must sit in a
 * conversation `userId` owns; a foreign or missing id is `null` (the route
 * answers 404). A message with no trail, or one whose ciphertext does not
 * decrypt or parse, reads as `{ trail: null }`: fail closed, never a
 * partial trail.
 */
export async function readMessageTrail(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<{ trail: CoachTrail | null } | null> {
  const row = await prisma.coachMessage.findFirst({
    where: {
      id: messageId,
      conversationId,
      conversation: { userId },
    },
    select: { trailEncrypted: true },
  });
  if (!row) return null;
  if (!row.trailEncrypted || row.trailEncrypted.byteLength === 0) {
    return { trail: null };
  }
  try {
    const parsed = coachTrailSchema.safeParse(
      JSON.parse(decryptFromBytes(row.trailEncrypted)),
    );
    return { trail: parsed.success ? parsed.data : null };
  } catch {
    return { trail: null };
  }
}

/** Decrypt and parse a message's tables by ref; null when unreadable. */
function decryptResultTables(
  bytes: Uint8Array | null,
): Map<string, CoachResultTable> | null {
  if (!bytes || bytes.byteLength === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptFromBytes(bytes));
  } catch {
    return null;
  }
  const tables = restoreEach(
    parsed,
    coachResultTableSchema,
    MAX_RESULTS_PER_MESSAGE,
  );
  return new Map((tables ?? []).map((table) => [table.ref, table]));
}

export interface ListConversationsParams {
  userId: string;
  cursor?: string | null;
  limit?: number;
  /**
   * v1.29.x (S7) — optional surface filter. The Coach rail passes neither (a
   * union of health + fenced threads, badged client-side). The document sheet
   * passes `attachedDocumentId` (only conversations that hold that document via a
   * live join row). `userId` stays narrowed regardless.
   */
  attachedDocumentId?: string;
  /**
   * v1.30.2 (QoL H1) — optional server-side title search for the history
   * rail + the standalone conversations page. Case-insensitive substring
   * match against the title only; message BODIES are out of scope (see the
   * route's doc comment). Since v1.39.3 the title is encrypted at rest, so
   * the match runs on the decrypted titles in memory rather than in SQL (see
   * `TITLE_SEARCH_SCAN_CAP`). Trimmed empty string is treated as "no filter",
   * matching the pre-existing cursor/limit handling style.
   */
  q?: string;
}

/**
 * v1.39.3 — how many of an account's conversations a title search decrypts,
 * newest first. The title is encrypted at rest, so SQL cannot match it; the
 * search reads id + title for the account, decrypts, and filters in memory.
 * A title is at most 80 characters, so a scan of the whole cap is a few
 * milliseconds of AES. An account past the cap has its oldest threads left out
 * of search results (never out of the unfiltered rail), which no real account
 * comes near: the rail pages 20 at a time and a person opens a few a day.
 */
export const TITLE_SEARCH_SCAN_CAP = 5000;

const CONVERSATION_LIST_ORDER = [
  { updatedAt: "desc" as const },
  { id: "desc" as const },
];

/**
 * Cursor-paginated list of conversations for the rail. Default limit
 * 20, cap 50. Cursor is the id of the last item on the previous page;
 * callers receive `nextCursor: null` when they reach the end.
 */
export async function listConversations(
  params: ListConversationsParams,
): Promise<{
  conversations: CoachConversationDTO[];
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const q = params.q?.trim();
  const scope = {
    userId: params.userId,
    ...(params.attachedDocumentId
      ? { attachments: { some: { documentId: params.attachedDocumentId } } }
      : {}),
  };
  const include = {
    _count: { select: { messages: true } },
    // v1.29.x (S7) — the live attachment set (label columns only) so the rail
    // can badge a fenced thread with a paperclip + the first document's title.
    // Empty on a health thread.
    attachments: {
      orderBy: { addedAt: "asc" as const },
      include: { document: { select: { title: true, filename: true } } },
    },
  };

  let page;
  let nextCursor: string | null;
  if (q) {
    // Match on the decrypted titles, then page the matching ids with the same
    // cursor contract the SQL path has: the cursor is the last id of the
    // previous page, and an unknown cursor yields an empty page.
    const needle = q.toLocaleLowerCase();
    const candidates = await prisma.coachConversation.findMany({
      where: scope,
      orderBy: CONVERSATION_LIST_ORDER,
      take: TITLE_SEARCH_SCAN_CAP,
      select: { id: true, title: true, titleEncrypted: true },
    });
    const matching = candidates
      .filter((c) =>
        readConversationTitle(c).toLocaleLowerCase().includes(needle),
      )
      .map((c) => c.id);
    let start = 0;
    if (params.cursor) {
      const at = matching.indexOf(params.cursor);
      start = at === -1 ? matching.length : at + 1;
    }
    const pageIds = matching.slice(start, start + limit);
    nextCursor =
      matching.length > start + limit ? pageIds[pageIds.length - 1] : null;
    const rows = await prisma.coachConversation.findMany({
      where: { ...scope, id: { in: pageIds } },
      include,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    page = pageIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  } else {
    const rows = await prisma.coachConversation.findMany({
      where: scope,
      orderBy: CONVERSATION_LIST_ORDER,
      take: limit + 1,
      ...(params.cursor
        ? {
            cursor: { id: params.cursor },
            skip: 1,
          }
        : {}),
      include,
    });
    page = rows.slice(0, limit);
    nextCursor = rows.length > limit ? page[page.length - 1].id : null;
  }

  return {
    conversations: page.map((r) => {
      const attachments = mapAttachments(r.attachments);
      return {
        id: r.id,
        title: readConversationTitle(r),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        messageCount: r._count.messages,
        fenced: r.documentScoped,
        attachments,
        documentTitle: attachments[0]?.title ?? null,
      };
    }),
    nextCursor,
  };
}

/**
 * Rename one owned conversation. The owner constraint lives in the write
 * predicate itself so a foreign id and a missing id are indistinguishable and
 * no check-then-write race can cross account boundaries.
 */
export async function renameConversation(
  userId: string,
  conversationId: string,
  title: string,
): Promise<{ id: string; title: string } | null> {
  const { count } = await prisma.coachConversation.updateMany({
    where: { id: conversationId, userId },
    // The readable column is cleared on a rename so a legacy row never keeps
    // its old title beside the new ciphertext.
    data: { title: null, titleEncrypted: encryptConversationTitle(title) },
  });
  return count === 1 ? { id: conversationId, title } : null;
}

/**
 * Delete a conversation and every message under it. Returns false when
 * the conversation does not exist or is not owned by `userId` — the
 * route should map both to 404.
 */
export async function deleteConversation(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const row = await prisma.coachConversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });
  if (!row) return false;
  await prisma.coachConversation.delete({ where: { id: row.id } });
  return true;
}

// ─── S7: coach-conversation attachments ─────────────────────────────────────

/**
 * v1.29.x (S7) — the state the attach/detach routes need to decide the outcome:
 * the sticky flag (for the tool→fenced flip detection), the message count (a
 * flip only matters on a thread with prior turns), and the LIVE attachment ids
 * (for the cap + idempotency checks). Owner-scoped; null when the conversation
 * does not exist or is not owned by `userId` (route → 404).
 */
export interface ConversationAttachmentState {
  id: string;
  documentScoped: boolean;
  messageCount: number;
  attachmentIds: string[];
}

export async function fetchConversationAttachmentState(
  userId: string,
  conversationId: string,
): Promise<ConversationAttachmentState | null> {
  const row = await prisma.coachConversation.findFirst({
    where: { id: conversationId, userId },
    select: {
      id: true,
      documentScoped: true,
      _count: { select: { messages: true } },
      attachments: { select: { documentId: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    documentScoped: row.documentScoped,
    messageCount: row._count.messages,
    attachmentIds: row.attachments.map((a) => a.documentId),
  };
}

/**
 * v1.29.x (S7) — attach a document: create the join row (idempotent via the
 * composite PK) and set the sticky `documentScoped` flag TRUE. This is the ONE
 * legal, privilege-REDUCING tool→fenced flip. The flag is only ever set true
 * here — no code path clears it. The CALLER must have validated the document
 * (owned + live + indexed + within cap) first.
 */
export async function attachDocument(args: {
  conversationId: string;
  documentId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.coachConversationDocument.createMany({
      data: [
        { conversationId: args.conversationId, documentId: args.documentId },
      ],
      skipDuplicates: true,
    });
    await tx.coachConversation.update({
      where: { id: args.conversationId },
      // Unconditional set-true: the flag is already true or becoming true, never
      // anything else. Detaching / deleting never reaches this write.
      data: { documentScoped: true },
    });
  });
}

/**
 * v1.29.x (S7) — detach a document: delete the join row. Writes NO flag — a
 * detached conversation stays fenced (the sticky-flag invariant). The absence of
 * any `documentScoped` write here is the guarantee, not a guarded branch.
 * Returns false when the conversation is not owned or the row did not exist
 * (route → 404, no info leak).
 */
export async function detachDocument(args: {
  userId: string;
  conversationId: string;
  documentId: string;
}): Promise<boolean> {
  const owned = await prisma.coachConversation.findFirst({
    where: { id: args.conversationId, userId: args.userId },
    select: { id: true },
  });
  if (!owned) return false;
  const result = await prisma.coachConversationDocument.deleteMany({
    where: { conversationId: args.conversationId, documentId: args.documentId },
  });
  return result.count > 0;
}

/**
 * v1.29.x (S7) — the live attachment DTO list for a conversation (join → label
 * columns, attach-time order). Used by the attach/detach routes to echo the
 * refreshed pill set back to the client.
 */
export async function loadConversationAttachmentDTOs(
  conversationId: string,
): Promise<CoachConversationAttachmentDTO[]> {
  const rows = await prisma.coachConversationDocument.findMany({
    where: { conversationId },
    orderBy: { addedAt: "asc" },
    include: { document: { select: { title: true, filename: true } } },
  });
  return mapAttachments(rows);
}
