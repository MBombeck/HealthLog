/**
 * Deleting a Coach conversation against a real Postgres: the row, its
 * messages and its document attachments go, the document itself stays, the
 * list no longer carries it, a foreign account gets 404, and two deletes of
 * the same row (a client re-sending one it could not confirm) answer 200 and
 * 404 instead of failing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedUser(username: string): Promise<string> {
  const user = await getPrismaClient().user.create({
    data: { username, role: "USER" },
  });
  return user.id;
}

async function signIn(userId: string): Promise<void> {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function seedConversation(userId: string) {
  const prisma = getPrismaClient();
  const { encryptDocumentContent } = await import("@/lib/documents/store");
  const { content, codec } = encryptDocumentContent(Buffer.from("letter"));
  const document = await prisma.inboundDocument.create({
    data: {
      userId,
      kind: "OTHER",
      filename: "letter.txt",
      mimeType: "text/plain",
      byteSize: 6,
      status: "STORED",
      contentEncrypted: content,
      contentCodec: codec,
    },
  });
  const { appendMessage, createConversation } =
    await import("@/lib/ai/coach/persistence");
  const convo = await createConversation({
    userId,
    title: "Old thread",
    documentScoped: true,
    attachmentIds: [document.id],
  });
  await appendMessage({
    conversationId: convo.id,
    role: "user",
    content: "What does the letter say?",
  });
  await appendMessage({
    conversationId: convo.id,
    role: "assistant",
    content: "It confirms the appointment.",
  });
  return { conversationId: convo.id, documentId: document.id };
}

type IdRoute = (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

async function deleteThread(id: string): Promise<Response> {
  const { DELETE } = await import("@/app/api/insights/chat/[id]/route");
  return (DELETE as unknown as IdRoute)(
    new Request(`http://localhost/api/insights/chat/${id}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function listIds(): Promise<string[]> {
  const { GET } = await import("@/app/api/insights/chat/route");
  const res = await (GET as unknown as (req: Request) => Promise<Response>)(
    new Request("http://localhost/api/insights/chat?limit=50"),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { conversations: { id: string }[] };
  };
  return body.data.conversations.map((c) => c.id);
}

describe("DELETE /api/insights/chat/[id]", () => {
  it("removes the thread, its messages and attachments, and keeps it out of the list", async () => {
    const userId = await seedUser("delete-owner");
    await signIn(userId);
    const kept = await seedConversation(userId);
    const { conversationId, documentId } = await seedConversation(userId);
    expect(await listIds()).toContain(conversationId);

    const res = await deleteThread(conversationId);
    expect(res.status).toBe(200);

    const prisma = getPrismaClient();
    expect(
      await prisma.coachConversation.findUnique({
        where: { id: conversationId },
      }),
    ).toBeNull();
    expect(await prisma.coachMessage.count({ where: { conversationId } })).toBe(
      0,
    );
    expect(
      await prisma.coachConversationDocument.count({
        where: { conversationId },
      }),
    ).toBe(0);
    expect(
      await prisma.inboundDocument.findUnique({ where: { id: documentId } }),
    ).not.toBeNull();

    expect(await listIds()).toEqual([kept.conversationId]);
  });

  it("answers 200 then 404 when the same delete arrives twice at once", async () => {
    const userId = await seedUser("delete-twice");
    await signIn(userId);
    const { conversationId } = await seedConversation(userId);

    const statuses = (
      await Promise.all([
        deleteThread(conversationId),
        deleteThread(conversationId),
      ])
    )
      .map((r) => r.status)
      .sort();

    expect(statuses).toEqual([200, 404]);
    expect(await listIds()).toEqual([]);
  });

  it("does not delete another account's thread", async () => {
    const ownerId = await seedUser("delete-victim");
    const { conversationId } = await seedConversation(ownerId);
    const intruderId = await seedUser("delete-intruder");
    await signIn(intruderId);

    const res = await deleteThread(conversationId);
    expect(res.status).toBe(404);
    expect(
      await getPrismaClient().coachConversation.findUnique({
        where: { id: conversationId },
      }),
    ).not.toBeNull();
  });
});
