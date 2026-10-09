/**
 * The webhook test button against a Discord webhook URL, through the real
 * sender with only the network mocked.
 *
 * The mocked target answers the way Discord does: 400 with code 50006
 * ("Cannot send an empty message") for a body without `content` or `embeds`,
 * 204 otherwise. The generic body used to carry neither, so the test button
 * and every reminder failed against a Discord URL the settings card names.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    notificationChannel: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));

const safeFetchMock = vi.fn();
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  SafeFetchError: class SafeFetchError extends Error {
    kind: string;
    constructor(message: string, kind: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: vi.fn(),
  recordPushAttemptForPayload: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST as postTest } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const DISCORD_URL =
  "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

/** Answers the way Discord's execute-webhook endpoint does. */
function discordAnswer(_url: string, init: { body: string }): Response {
  const body = JSON.parse(init.body) as Record<string, unknown>;
  const content = typeof body.content === "string" ? body.content : "";
  if (content.trim().length === 0 && body.embeds === undefined) {
    return new Response(
      JSON.stringify({ message: "Cannot send an empty message", code: 50006 }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (content.length > 2000) {
    return new Response(
      JSON.stringify({ message: "Invalid Form Body", code: 50035 }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response(null, { status: 204 });
}

const POST = postTest as (request: Request) => Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
    user: { id: "user-1", username: "testuser", role: "USER" },
  } as never);
  vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue({
    config: `encrypted:${JSON.stringify({ url: DISCORD_URL })}`,
  } as never);
  safeFetchMock.mockImplementation(
    async (url: string, init: { body: string }) => discordAnswer(url, init),
  );
});

describe("POST /api/settings/webhook/test — a Discord webhook URL", () => {
  it("delivers: the generic body carries the content Discord requires", async () => {
    const response = await POST(
      new Request("http://localhost/api/settings/webhook/test", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ sent: true });

    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = safeFetchMock.mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(url).toBe(DISCORD_URL);
    const sent = JSON.parse(init.body);
    expect(sent.content).toBe(
      "HealthLog Test\nHealthLog: Connection successful! Webhook notifications are active.",
    );
    expect(sent.allowed_mentions).toEqual({ parse: [] });
  });

  it("passes Discord's own error through when the target still refuses", async () => {
    safeFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "Unknown Webhook", code: 10015 }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await POST(
      new Request("http://localhost/api/settings/webhook/test", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.meta.upstreamStatus).toBe(404);
    expect(json.meta.upstreamBody).toContain("Unknown Webhook");
  });
});
