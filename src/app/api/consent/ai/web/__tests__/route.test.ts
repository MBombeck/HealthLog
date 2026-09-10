import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// The mint logic + its TOCTOU close are covered by web-grant.test.ts; the
// route test stubs it to focus on auth + rate-limit + intent + serialisation.
vi.mock("@/lib/consent/web-grant", () => ({
  ensureWebAiConsentReceipt: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkConsentRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { ensureWebAiConsentReceipt } from "@/lib/consent/web-grant";
import { checkConsentRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

const RL_OK = {
  allowed: true,
  limit: 20,
  remaining: 19,
  resetAt: Date.now() + 60_000,
};

/** The mount heal posts no body and no content-type. */
function mkHeal(): Request {
  return new Request("http://localhost/api/consent/ai/web", {
    method: "POST",
  });
}

/** The explicit grant control posts a JSON intent. */
function mkIntent(body: unknown): Request {
  return new Request("http://localhost/api/consent/ai/web", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auditLog).mockResolvedValue(undefined);
  vi.mocked(checkConsentRateLimit).mockResolvedValue(RL_OK);
});

describe("POST /api/consent/ai/web", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(mkHeal());
    expect(res.status).toBe(401);
    expect(ensureWebAiConsentReceipt).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-user consent bucket is exhausted", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkConsentRateLimit).mockResolvedValue({
      allowed: false,
      limit: 20,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(mkHeal());
    expect(res.status).toBe(429);
    // The throttle fires before the mint runs.
    expect(ensureWebAiConsentReceipt).not.toHaveBeenCalled();
  });

  it("mints a receipt and reports minted:true", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(ensureWebAiConsentReceipt).mockResolvedValue({
      minted: true,
      receipt: { id: "rcpt-web-1" } as never,
    });

    const res = await POST(mkHeal());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { minted: boolean; kind: string };
    };
    expect(body.data.minted).toBe(true);
    expect(body.data.kind).toBe("ai_full");
  });

  it("is a no-op when an active receipt already exists (minted:false)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(ensureWebAiConsentReceipt).mockResolvedValue({
      minted: false,
      reason: "already_active",
    });

    const res = await POST(mkHeal());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { minted: boolean } };
    expect(body.data.minted).toBe(false);
    // No audit row on the no-op path.
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("passes a bodyless call to the mint as a heal", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(ensureWebAiConsentReceipt).mockResolvedValue({
      minted: false,
      reason: "previously_revoked",
    });

    const res = await POST(mkHeal());
    expect(res.status).toBe(200);
    expect(ensureWebAiConsentReceipt).toHaveBeenCalledWith("user-1", "heal");
  });

  it("passes an explicit affirmative body to the mint as the consent act", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(ensureWebAiConsentReceipt).mockResolvedValue({
      minted: true,
      receipt: { id: "rcpt-web-2" } as never,
    });

    const res = await POST(mkIntent({ intent: "affirmative" }));
    expect(res.status).toBe(200);
    expect(ensureWebAiConsentReceipt).toHaveBeenCalledWith(
      "user-1",
      "affirmative",
    );
    // The audit row records that this was the user's own grant, not a heal.
    expect(auditLog).toHaveBeenCalledWith(
      "consent.ai.grant",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          source: "web",
          intent: "affirmative",
        }),
      }),
    );
  });

  it("rejects an unknown intent with 422 and never reaches the mint", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await POST(mkIntent({ intent: "resurrect" }));
    expect(res.status).toBe(422);
    expect(ensureWebAiConsentReceipt).not.toHaveBeenCalled();
  });
});
