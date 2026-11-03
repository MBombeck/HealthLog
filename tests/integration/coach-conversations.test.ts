/**
 * Integration coverage for the v1.4.20 Coach conversation endpoints.
 *
 *   GET    /api/insights/chat            — list (cursor-paginated)
 *   GET    /api/insights/chat/[id]       — fetch one + messages
 *   DELETE /api/insights/chat/[id]       — hard-delete the thread
 *
 * Ownership boundaries: a foreign user's id maps to 404 (NOT 403) so
 * the existence channel never leaks. Decryption round-trips on read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedUserWithSession(username = "coach-list-user"): Promise<{
  userId: string;
}> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: { username, role: "USER" },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return { userId: user.id };
}

interface Envelope<T> {
  data: T | null;
  error?: string | null;
}

describe("GET /api/insights/chat — list integration", () => {
  it("returns the user's conversations newest-first", async () => {
    const { userId } = await seedUserWithSession();
    const { appendMessage, createConversation } =
      await import("@/lib/ai/coach/persistence");
    const a = await createConversation({ userId, title: "first thread" });
    await appendMessage({
      conversationId: a.id,
      role: "user",
      content: "first turn",
    });
    const b = await createConversation({ userId, title: "second thread" });
    await appendMessage({
      conversationId: b.id,
      role: "user",
      content: "second turn",
    });

    const { GET } = await import("@/app/api/insights/chat/route");
    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/chat"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as Envelope<{
      conversations: Array<{ id: string; messageCount: number }>;
      nextCursor: string | null;
    }>;
    expect(env.data?.conversations.length).toBe(2);
    // most recently updated first
    expect(env.data?.conversations[0].id).toBe(b.id);
    expect(env.data?.conversations[0].messageCount).toBe(1);
    expect(env.data?.nextCursor).toBeNull();
  });

  it("only returns conversations owned by the caller", async () => {
    const prisma = getPrismaClient();
    const foreign = await prisma.user.create({
      data: { username: "foreign", role: "USER" },
    });
    await prisma.coachConversation.create({
      data: { userId: foreign.id, title: "not yours" },
    });
    const { userId } = await seedUserWithSession();
    const { createConversation } = await import("@/lib/ai/coach/persistence");
    await createConversation({ userId, title: "yours" });

    const { GET } = await import("@/app/api/insights/chat/route");
    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/chat"),
    );
    const env = (await res.json()) as Envelope<{
      conversations: Array<{ title: string }>;
    }>;
    expect(env.data?.conversations.map((c) => c.title)).toEqual(["yours"]);
  });
});

describe("GET /api/insights/chat/[id] — fetch single", () => {
  it("decrypts every message body on read", async () => {
    const { userId } = await seedUserWithSession();
    const { appendMessage, createConversation } =
      await import("@/lib/ai/coach/persistence");
    const convo = await createConversation({ userId, title: "encrypted test" });
    await appendMessage({
      conversationId: convo.id,
      role: "user",
      content: "this is the user message",
    });
    await appendMessage({
      conversationId: convo.id,
      role: "assistant",
      content: "this is the assistant reply",
      metricSource: { windows: ["last30days"], metrics: ["bp"] },
      providerType: "openai",
      promptVersion: "4.20.0",
    });

    const { GET } = await import("@/app/api/insights/chat/[id]/route");
    const res = await (
      GET as unknown as (
        req: Request,
        ctx: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(new Request(`http://localhost/api/insights/chat/${convo.id}`), {
      params: Promise.resolve({ id: convo.id }),
    });
    expect(res.status).toBe(200);
    const env = (await res.json()) as Envelope<{
      messages: Array<{
        role: string;
        content: string;
        providerType: string | null;
      }>;
    }>;
    expect(env.data?.messages.length).toBe(2);
    expect(env.data?.messages[0].content).toBe("this is the user message");
    expect(env.data?.messages[1].content).toBe("this is the assistant reply");
    expect(env.data?.messages[1].providerType).toBe("openai");
  });

  it("returns 404 (not 403) when fetching another user's conversation", async () => {
    const prisma = getPrismaClient();
    const foreign = await prisma.user.create({
      data: { username: "foreign-fetch", role: "USER" },
    });
    const foreignConvo = await prisma.coachConversation.create({
      data: { userId: foreign.id, title: "secret" },
    });
    await seedUserWithSession();

    const { GET } = await import("@/app/api/insights/chat/[id]/route");
    const res = await (
      GET as unknown as (
        req: Request,
        ctx: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(new Request(`http://localhost/api/insights/chat/${foreignConvo.id}`), {
      params: Promise.resolve({ id: foreignConvo.id }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/insights/chat/[id]", () => {
  it("removes the conversation and cascades messages", async () => {
    const { userId } = await seedUserWithSession();
    const { appendMessage, createConversation } =
      await import("@/lib/ai/coach/persistence");
    const convo = await createConversation({ userId, title: "to delete" });
    await appendMessage({
      conversationId: convo.id,
      role: "user",
      content: "ephemeral",
    });

    const { DELETE } = await import("@/app/api/insights/chat/[id]/route");
    const res = await (
      DELETE as unknown as (
        req: Request,
        ctx: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(
      new Request(`http://localhost/api/insights/chat/${convo.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: convo.id }) },
    );
    expect(res.status).toBe(200);

    const prisma = getPrismaClient();
    expect(await prisma.coachConversation.count()).toBe(0);
    expect(await prisma.coachMessage.count()).toBe(0);
  });

  it("returns 404 when deleting another user's conversation", async () => {
    const prisma = getPrismaClient();
    const foreign = await prisma.user.create({
      data: { username: "foreign-delete", role: "USER" },
    });
    const foreignConvo = await prisma.coachConversation.create({
      data: { userId: foreign.id, title: "secret" },
    });
    await seedUserWithSession();

    const { DELETE } = await import("@/app/api/insights/chat/[id]/route");
    const res = await (
      DELETE as unknown as (
        req: Request,
        ctx: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(
      new Request(`http://localhost/api/insights/chat/${foreignConvo.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: foreignConvo.id }) },
    );
    expect(res.status).toBe(404);

    // Foreign conversation still on disk
    expect(
      await prisma.coachConversation.count({ where: { userId: foreign.id } }),
    ).toBe(1);
  });
});
