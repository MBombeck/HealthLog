/**
 * v1.4.23 — Coach assistant-message thumbs feedback route.
 *
 * Round-trip: seed a session + a coach conversation + an assistant
 * message, POST a thumbs rating, assert a `RecommendationFeedback` row
 * landed with `targetType="coach"` and the encoded prefs metric source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";

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

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: { username, email: `${username}@example.test` },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

async function seedAssistantMessage(userId: string, content: string) {
  const prisma = getPrismaClient();
  const conversation = await prisma.coachConversation.create({
    data: { userId, title: "Test conversation" },
  });
  const ciphertext = encrypt(content);
  return prisma.coachMessage.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      encryptedContent: Buffer.from(ciphertext, "utf8"),
      providerType: "codex",
      promptVersion: "4.23.0",
    },
  });
}

describe("POST /api/insights/chat/messages/:id/feedback", () => {
  it("persists a thumbs-up with target_type=coach and the encoded metric source", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("coach-feedback-h7");
    const message = await seedAssistantMessage(user.id, "Your last week...");

    const { POST } =
      await import("@/app/api/insights/chat/messages/[id]/feedback/route");
    const res = await (
      POST as (
        req: Request,
        ctx: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(
      new Request(
        `http://localhost/api/insights/chat/messages/${message.id}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: "helpful" }),
        },
      ),
      { params: Promise.resolve({ id: message.id }) },
    );
    expect(res.status).toBe(201);

    const rows = await prisma.recommendationFeedback.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].targetType).toBe("coach");
    expect(rows[0].helpful).toBe(true);
    expect(rows[0].recommendationSeverity).toBe("coach");
    // Default prefs encode as warm/default — the user has no
    // coachPrefsJson row so the route falls back to defaults.
    expect(rows[0].metricSourceType).toBe("coach:tone=warm:verbosity=default");
    expect(rows[0].providerType).toBe("codex");
    expect(rows[0].promptVersion).toBe("4.23.0");
    // Sr-H3 reconcile: the FK now carries the message id and the
    // legacy plaintext snapshot column stays NULL so the encrypted-
    // at-rest invariant of `coach_messages.encryptedContent` survives.
    expect(rows[0].coachMessageId).toBe(message.id);
    expect(rows[0].recommendationText).toBeNull();
  });

  it("dedupes a second submission for the same message via the partial unique index", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("coach-feedback-dedup");
    const message = await seedAssistantMessage(user.id, "Reply.");

    const { POST } =
      await import("@/app/api/insights/chat/messages/[id]/feedback/route");
    const post = (id: string) =>
      (
        POST as (
          req: Request,
          ctx: { params: Promise<{ id: string }> },
        ) => Promise<Response>
      )(
        new Request(
          `http://localhost/api/insights/chat/messages/${id}/feedback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rating: "helpful" }),
          },
        ),
        { params: Promise.resolve({ id }) },
      );
    const first = await post(message.id);
    expect(first.status).toBe(201);
    const second = await post(message.id);
    expect(second.status).toBe(409);

    const rows = await prisma.recommendationFeedback.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("returns 404 when the message belongs to another user", async () => {
    const otherUser = await getPrismaClient().user.create({
      data: { username: "other-coach-h7" },
    });
    const otherMessage = await seedAssistantMessage(otherUser.id, "private");
    await seedSession("attacker-h7");

    const { POST } =
      await import("@/app/api/insights/chat/messages/[id]/feedback/route");
    const res = await (
      POST as (
        req: Request,
        ctx: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(
      new Request(
        `http://localhost/api/insights/chat/messages/${otherMessage.id}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: "helpful" }),
        },
      ),
      { params: Promise.resolve({ id: otherMessage.id }) },
    );
    expect(res.status).toBe(404);
  });

  it("rejects an unknown rating value with 422", async () => {
    const user = await seedSession("coach-feedback-422");
    const message = await seedAssistantMessage(user.id, "Reply.");

    const { POST } =
      await import("@/app/api/insights/chat/messages/[id]/feedback/route");
    const res = await (
      POST as (
        req: Request,
        ctx: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(
      new Request(
        `http://localhost/api/insights/chat/messages/${message.id}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: "meh" }),
        },
      ),
      { params: Promise.resolve({ id: message.id }) },
    );
    expect(res.status).toBe(422);
  });
});
