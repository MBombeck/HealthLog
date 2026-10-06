/**
 * v1.41 — the trail of a Coach reply against a real Postgres: the model text
 * is sealed in `coach_messages.trail_encrypted` (never in the plaintext
 * provenance), the conversation read leaves it out, the owner reads it back
 * through `GET …/messages/{messageId}/trail`, another account gets 404, and
 * nothing is served while the Coach's text may not be shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const serve = vi.hoisted(() => ({ available: true }));

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

// Whether the record's Coach text may be shown is its own suite's question
// (`ai-optional-*`); here it is a switch.
vi.mock("@/lib/ai/capabilities/gate", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  aiCapabilityToServe: vi.fn(async () =>
    serve.available
      ? { available: true, reason: null, onDeviceAllowed: true }
      : {
          available: false,
          reason: "disabled_by_user",
          onDeviceAllowed: false,
        },
  ),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  serve.available = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedUserWithSession(username: string): Promise<string> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({ data: { username, role: "USER" } });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user.id;
}

const TITLE = "Weighing the last two weeks";
const TEXT = "Sleep first, then the resting pulse beside it.";

async function seedReply(userId: string) {
  const { appendMessage, createConversation } =
    await import("@/lib/ai/coach/persistence");
  const convo = await createConversation({ userId, title: "why" });
  await appendMessage({
    conversationId: convo.id,
    role: "user",
    content: "Why am I sleeping worse?",
  });
  const reply = await appendMessage({
    conversationId: convo.id,
    role: "assistant",
    content: "Shorter nights since the 20th.",
    metricSource: {
      windows: [],
      metrics: [],
      activity: [
        {
          id: "a1",
          phase: "thinking",
          status: "done",
          round: 1,
          labelKey: "insights.coach.activity.thinking",
          label: "Thinking…",
          durationMs: 2100,
        },
      ],
      stop: { reason: "time", rounds: 5 },
    },
    providerType: "codex",
    trail: { entries: [{ id: "a1", title: TITLE, text: TEXT }] },
  });
  return { conversationId: convo.id, messageId: reply.id };
}

type TrailGet = (
  req: Request,
  ctx: { params: Promise<{ id: string; messageId: string }> },
) => Promise<Response>;

async function getTrail(conversationId: string, messageId: string) {
  const { GET } =
    await import("@/app/api/insights/chat/[id]/messages/[messageId]/trail/route");
  return (GET as unknown as TrailGet)(
    new Request(
      `http://localhost/api/insights/chat/${conversationId}/messages/${messageId}/trail`,
    ),
    { params: Promise.resolve({ id: conversationId, messageId }) },
  );
}

describe("the trail of a Coach reply", () => {
  it("is sealed in its own column and never in the plaintext provenance", async () => {
    const userId = await seedUserWithSession("trail-owner");
    const { messageId } = await seedReply(userId);
    const row = await getPrismaClient().coachMessage.findUniqueOrThrow({
      where: { id: messageId },
      select: { trailEncrypted: true, metricSourceJson: true },
    });
    expect(row.trailEncrypted).not.toBeNull();
    expect(Buffer.from(row.trailEncrypted!).toString("utf8")).not.toContain(
      "Weighing",
    );
    expect(row.metricSourceJson).toContain('"phase":"thinking"');
    expect(row.metricSourceJson).not.toContain("Weighing");
    expect(row.metricSourceJson).not.toContain("resting pulse");
  });

  it("is read back by the owner, structure on the message, text on the trail route", async () => {
    const userId = await seedUserWithSession("trail-owner");
    const { conversationId, messageId } = await seedReply(userId);

    const { GET } = await import("@/app/api/insights/chat/[id]/route");
    const detail = await (
      GET as unknown as (
        req: Request,
        ctx: { params: Promise<{ id: string }> },
      ) => Promise<Response>
    )(new Request(`http://localhost/api/insights/chat/${conversationId}`), {
      params: Promise.resolve({ id: conversationId }),
    });
    const body = (await detail.json()) as {
      data: {
        messages: Array<{ metricSource: Record<string, unknown> | null }>;
      };
    };
    const stored = body.data.messages[1].metricSource!;
    expect(stored.activity).toEqual([
      expect.objectContaining({ id: "a1", phase: "thinking" }),
    ]);
    expect(stored.stop).toEqual({ reason: "time", rounds: 5 });
    expect(JSON.stringify(body)).not.toContain("Weighing");

    const res = await getTrail(conversationId, messageId);
    expect(res.status).toBe(200);
    const trail = (await res.json()) as {
      data: { trail: { entries: unknown[] } | null };
    };
    expect(trail.data.trail).toEqual({
      entries: [{ id: "a1", title: TITLE, text: TEXT }],
    });
  });

  it("is 404 for another account, never 403", async () => {
    const ownerId = await seedUserWithSession("trail-owner");
    const { conversationId, messageId } = await seedReply(ownerId);
    await seedUserWithSession("trail-other");
    const res = await getTrail(conversationId, messageId);
    expect(res.status).toBe(404);
  });

  it("serves no text while the Coach's text may not be shown", async () => {
    const userId = await seedUserWithSession("trail-owner");
    const { conversationId, messageId } = await seedReply(userId);
    serve.available = false;
    const res = await getTrail(conversationId, messageId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { trail: unknown; ai: { available: boolean } };
    };
    expect(body.data.trail).toBeNull();
    expect(body.data.ai.available).toBe(false);
  });

  it("goes with the conversation when it is deleted", async () => {
    const userId = await seedUserWithSession("trail-owner");
    const { conversationId, messageId } = await seedReply(userId);
    const { deleteConversation } = await import("@/lib/ai/coach/persistence");
    await expect(deleteConversation(userId, conversationId)).resolves.toBe(
      true,
    );
    const left = await getPrismaClient().coachMessage.findUnique({
      where: { id: messageId },
    });
    expect(left).toBeNull();
  });
});
