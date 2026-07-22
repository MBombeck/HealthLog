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
import { prisma } from "@/lib/db";
import { decryptFromBytes, encryptToBytes } from "./bytes-codec";
import { COACH_CONVERSATION_TITLE_MAX } from "./types";

import type {
  CoachConversationAttachmentDTO,
  CoachConversationDTO,
  CoachConversationDetailDTO,
  CoachMessageDTO,
  CoachMessageRole,
  CoachProvenance,
} from "./types";

/**
 * Title-from-message — first 80 chars trimmed, ellipsis on overflow.
 * Stays plain text (the history rail needs to render without paying
 * the per-message decrypt cost), so callers should pass already-
 * sanitised input.
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

function provenanceToJson(provenance: CoachProvenance | null): string | null {
  if (!provenance) return null;
  return JSON.stringify(provenance);
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
    return { windows, metrics, counts, ...(keyValues ? { keyValues } : {}) };
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
}

/**
 * Create a brand-new conversation row owned by `userId`. Caller is
 * expected to immediately append the first user message.
 */
export async function createConversation(
  params: CreateConversationParams,
): Promise<CoachConversationDTO> {
  const attachmentIds = params.attachmentIds ?? [];
  const row = await prisma.$transaction(async (tx) => {
    const conversation = await tx.coachConversation.create({
      data: {
        userId: params.userId,
        title: summariseTitle(params.title),
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
    title: row.title,
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
      },
    });
    await tx.coachConversation.update({
      where: { id: params.conversationId },
      data: { updatedAt: new Date() },
    });
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
        title: summariseTitle(params.title),
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
  opts?: { documentScoped?: boolean; attachedDocumentId?: string },
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
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messageCount: messages.length,
    messages,
    summary,
    fenced: row.documentScoped,
    attachments,
    attachmentCount: attachments.length,
    documentTitle: attachments[0]?.title ?? null,
  };
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
   * match against `title` only — the only plaintext column on the row;
   * `CoachMessage.encryptedContent` cannot be searched without decrypting
   * every message, so message BODIES are out of scope for this pass (see
   * the route's doc comment). Trimmed empty string is treated as "no
   * filter", matching the pre-existing cursor/limit handling style.
   */
  q?: string;
}

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
  const rows = await prisma.coachConversation.findMany({
    where: {
      userId: params.userId,
      ...(params.attachedDocumentId
        ? { attachments: { some: { documentId: params.attachedDocumentId } } }
        : {}),
      ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor
      ? {
          cursor: { id: params.cursor },
          skip: 1,
        }
      : {}),
    include: {
      _count: { select: { messages: true } },
      // v1.29.x (S7) — the live attachment set (label columns only) so the rail
      // can badge a fenced thread with a paperclip + the first document's title.
      // Empty on a health thread.
      attachments: {
        orderBy: { addedAt: "asc" },
        include: { document: { select: { title: true, filename: true } } },
      },
    },
  });

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1].id : null;

  return {
    conversations: page.map((r) => {
      const attachments = mapAttachments(r.attachments);
      return {
        id: r.id,
        title: r.title,
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
    data: { title },
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
