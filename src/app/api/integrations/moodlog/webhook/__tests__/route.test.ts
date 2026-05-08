import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Module-boundary mocks must come before importing the route. ---

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    moodEntry: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/moodlog-secret", () => ({
  readMoodLogSecret: vi.fn(),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => ({ setAuth: vi.fn(), addWarning: vi.fn() })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { readMoodLogSecret } from "@/lib/moodlog-secret";

const VALID_PAYLOAD = {
  event: "mood.created" as const,
  timestamp: "2026-05-08T12:00:00.000Z",
  entry: {
    date: "2026-05-08",
    time: "2026-05-08T12:00:00.000Z",
    mood: "GUT" as const,
    score: 4,
    tags: ["walk", "sun"],
    loggedVia: "WEB" as const,
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 30,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    moodLogGlobal: true,
  } as never);
  vi.mocked(prisma.user.findMany).mockResolvedValue([
    { id: "user-1", moodLogWebhookSecret: "encrypted-blob-1" },
  ] as never);
  vi.mocked(readMoodLogSecret).mockReturnValue("plaintext-secret");
  vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.moodEntry.deleteMany).mockResolvedValue({
    count: 0,
  } as never);
});

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/integrations/moodlog/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/integrations/moodlog/webhook", () => {
  it("returns 401 when X-Webhook-Secret header is missing", async () => {
    const res = await POST(jsonRequest(VALID_PAYLOAD));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/missing/i);
    expect(prisma.moodEntry.upsert).not.toHaveBeenCalled();
  });

  it("returns 401 when no enabled user matches the supplied secret", async () => {
    // The single candidate decrypts to a different plaintext.
    vi.mocked(readMoodLogSecret).mockReturnValue("different-plaintext");

    const res = await POST(
      jsonRequest(VALID_PAYLOAD, { "x-webhook-secret": "plaintext-secret" }),
    );
    expect(res.status).toBe(401);
    expect(readMoodLogSecret).toHaveBeenCalledWith("encrypted-blob-1");
    expect(prisma.moodEntry.upsert).not.toHaveBeenCalled();
  });

  it("decrypts each candidate via readMoodLogSecret and matches timing-safely", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: "user-A", moodLogWebhookSecret: "blob-A" },
      { id: "user-B", moodLogWebhookSecret: "blob-B" },
    ] as never);

    // First candidate decrypts to a wrong value, second decrypts to the
    // submitted secret. The route must walk the list and pick user-B.
    vi.mocked(readMoodLogSecret)
      .mockReturnValueOnce("nope")
      .mockReturnValueOnce("plaintext-secret");

    const res = await POST(
      jsonRequest(VALID_PAYLOAD, { "x-webhook-secret": "plaintext-secret" }),
    );

    expect(res.status).toBe(200);
    expect(readMoodLogSecret).toHaveBeenNthCalledWith(1, "blob-A");
    expect(readMoodLogSecret).toHaveBeenNthCalledWith(2, "blob-B");
    const upsertArgs = vi.mocked(prisma.moodEntry.upsert).mock.calls[0][0];
    // The route must use the matched user's id, not the first candidate's.
    expect(
      (upsertArgs.where as { userId_date_moodLoggedAt: { userId: string } })
        .userId_date_moodLoggedAt.userId,
    ).toBe("user-B");
  });

  it("happy path: valid secret + mood.created upserts a mood entry tagged MOODLOG", async () => {
    const res = await POST(
      jsonRequest(VALID_PAYLOAD, { "x-webhook-secret": "plaintext-secret" }),
    );
    expect(res.status).toBe(200);

    expect(prisma.moodEntry.upsert).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.moodEntry.upsert).mock.calls[0][0];
    expect(args).toMatchObject({
      where: {
        userId_date_moodLoggedAt: {
          userId: "user-1",
          date: "2026-05-08",
          moodLoggedAt: new Date("2026-05-08T12:00:00.000Z"),
        },
      },
      update: {
        mood: "GUT",
        score: 4,
        tags: JSON.stringify(["walk", "sun"]),
        source: "MOODLOG",
      },
      create: {
        userId: "user-1",
        date: "2026-05-08",
        mood: "GUT",
        score: 4,
        tags: JSON.stringify(["walk", "sun"]),
        source: "MOODLOG",
        moodLoggedAt: new Date("2026-05-08T12:00:00.000Z"),
      },
    });
  });

  it("idempotency: a duplicate mood.updated event hits upsert with the same composite key, so the DB no-ops", async () => {
    const updated = { ...VALID_PAYLOAD, event: "mood.updated" as const };

    const r1 = await POST(
      jsonRequest(updated, { "x-webhook-secret": "plaintext-secret" }),
    );
    const r2 = await POST(
      jsonRequest(updated, { "x-webhook-secret": "plaintext-secret" }),
    );

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(prisma.moodEntry.upsert).toHaveBeenCalledTimes(2);
    const wheres = vi.mocked(prisma.moodEntry.upsert).mock.calls.map(
      (c) =>
        (
          c[0].where as {
            userId_date_moodLoggedAt: {
              userId: string;
              date: string;
              moodLoggedAt: Date;
            };
          }
        ).userId_date_moodLoggedAt,
    );
    // Both calls target the same composite key — Postgres ON CONFLICT
    // makes the second upsert a no-op write.
    expect(wheres[0]).toEqual(wheres[1]);
  });

  it("mood.deleted removes any matching entry rather than upserting", async () => {
    const deletedPayload = {
      ...VALID_PAYLOAD,
      event: "mood.deleted" as const,
    };
    const res = await POST(
      jsonRequest(deletedPayload, {
        "x-webhook-secret": "plaintext-secret",
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.moodEntry.upsert).not.toHaveBeenCalled();
    expect(prisma.moodEntry.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        date: "2026-05-08",
        moodLoggedAt: new Date("2026-05-08T12:00:00.000Z"),
      },
    });
  });

  it("webhook.test ping short-circuits to 200 with no DB writes", async () => {
    const res = await POST(
      jsonRequest(
        { event: "webhook.test" },
        { "x-webhook-secret": "plaintext-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(prisma.moodEntry.upsert).not.toHaveBeenCalled();
    expect(prisma.moodEntry.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects payloads that don't match the schema with 400", async () => {
    const bad = {
      event: "mood.created",
      timestamp: "2026-05-08T12:00:00.000Z",
      // entry missing required fields
      entry: { date: "not-a-date", time: "x", mood: "BAD", score: 0 },
    };
    const res = await POST(
      jsonRequest(bad, { "x-webhook-secret": "plaintext-secret" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid payload/i);
    expect(prisma.moodEntry.upsert).not.toHaveBeenCalled();
  });

  it("returns 403 when the global moodLog toggle is disabled", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      moodLogGlobal: false,
    } as never);
    const res = await POST(
      jsonRequest(VALID_PAYLOAD, { "x-webhook-secret": "plaintext-secret" }),
    );
    expect(res.status).toBe(403);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limit is exceeded — no secret lookup performed", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);
    const res = await POST(
      jsonRequest(VALID_PAYLOAD, { "x-webhook-secret": "plaintext-secret" }),
    );
    expect(res.status).toBe(429);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
