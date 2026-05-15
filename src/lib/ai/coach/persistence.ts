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
import { Buffer } from "node:buffer";

import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";

import type {
  CoachConversationDTO,
  CoachConversationDetailDTO,
  CoachMessageDTO,
  CoachMessageRole,
  CoachProvenance,
} from "./types";

const TITLE_MAX = 80;

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
  if (points.length <= TITLE_MAX) return collapsed;
  // Cut at TITLE_MAX-1 code points and append a single-character
  // ellipsis so the visible width matches TITLE_MAX. Cuts at the word
  // boundary when one is within reach of the limit.
  const sliced = points.slice(0, TITLE_MAX - 1).join("");
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace > TITLE_MAX - 20 ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.trimEnd()}…`;
}

/**
 * Encode a UTF-8 string as the AES-256-GCM payload format the schema
 * stores in `coach_messages.encrypted_content`.
 *
 * Prisma's `Bytes` type maps to `Uint8Array<ArrayBuffer>`, not Node's
 * `Buffer<ArrayBufferLike>`. We allocate a fresh ArrayBuffer-backed
 * Uint8Array so the structural type matches across Node versions.
 */
function encryptToBytes(plaintext: string): Uint8Array<ArrayBuffer> {
  const ciphertext = encrypt(plaintext);
  const encoded = Buffer.from(ciphertext, "utf8");
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

function decryptFromBytes(buf: Uint8Array): string {
  const text = Buffer.from(buf).toString("utf8");
  return decrypt(text);
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
}

export interface AppendMessageParams {
  conversationId: string;
  role: CoachMessageRole;
  content: string;
  metricSource?: CoachProvenance | null;
  providerType?: string | null;
  promptVersion?: string | null;
}

/**
 * Create a brand-new conversation row owned by `userId`. Caller is
 * expected to immediately append the first user message.
 */
export async function createConversation(
  params: CreateConversationParams,
): Promise<CoachConversationDTO> {
  const row = await prisma.coachConversation.create({
    data: {
      userId: params.userId,
      title: summariseTitle(params.title),
    },
  });
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messageCount: 0,
  };
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
  };
}

/**
 * Fetch one conversation + every message, decrypting each body on
 * read. Returns null when the conversation does not exist OR when the
 * supplied `userId` does not own it — callers should map both cases to
 * a 404 to avoid an existence-leak side channel.
 */
export async function fetchConversationWithMessages(
  userId: string,
  conversationId: string,
): Promise<CoachConversationDetailDTO | null> {
  const row = await prisma.coachConversation.findFirst({
    where: { id: conversationId, userId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!row) return null;

  const messages: CoachMessageDTO[] = row.messages.map((m) => ({
    id: m.id,
    role: m.role as CoachMessageRole,
    content: decryptFromBytes(m.encryptedContent),
    createdAt: m.createdAt.toISOString(),
    metricSource: provenanceFromJson(m.metricSourceJson),
    providerType: m.providerType,
    promptVersion: m.promptVersion,
  }));

  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messageCount: messages.length,
    messages,
  };
}

export interface ListConversationsParams {
  userId: string;
  cursor?: string | null;
  limit?: number;
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
  const rows = await prisma.coachConversation.findMany({
    where: { userId: params.userId },
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
    },
  });

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1].id : null;

  return {
    conversations: page.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      messageCount: r._count.messages,
    })),
    nextCursor,
  };
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

