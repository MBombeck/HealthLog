import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// The mint logic + its TOCTOU close are covered by web-grant.test.ts; the
// route test stubs it to focus on auth + rate-limit + the explicit
// confirmation + serialisation.
vi.mock("@/lib/consent/web-grant", () => ({
  grantWebAiConsent: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkConsentRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { grantWebAiConsent } from "@/lib/consent/web-grant";
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

/** What the pre-v1.43.2 mount heal sent: no body, no content-type. */
function mkHeal(): Request {
  return new Request("http://localhost/api/consent/ai/web", {
    method: "POST",
  });
}

/** A JSON body, as the agree control (or anything else) sends one. */
function mkJson(body: unknown): Request {
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
    expect(grantWebAiConsent).not.toHaveBeenCalled();
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
    expect(grantWebAiConsent).not.toHaveBeenCalled();
  });

  it("mints a receipt on the explicit confirmation and reports minted:true", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(grantWebAiConsent).mockResolvedValue({
      minted: true,
      receipt: { id: "rcpt-web-1" } as never,
    });

    const res = await POST(mkJson({ confirm: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { minted: boolean; kind: string };
    };
    expect(body.data.minted).toBe(true);
    expect(body.data.kind).toBe("ai_full");
    expect(grantWebAiConsent).toHaveBeenCalledWith("user-1");
    expect(auditLog).toHaveBeenCalledWith(
      "consent.ai.grant",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({ source: "web", confirmed: true }),
      }),
    );
  });

  it("is a no-op when an active receipt already exists (minted:false)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(grantWebAiConsent).mockResolvedValue({
      minted: false,
      reason: "already_active",
    });

    const res = await POST(mkJson({ confirm: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { minted: boolean } };
    expect(body.data.minted).toBe(false);
    // No audit row on the no-op path.
    expect(auditLog).not.toHaveBeenCalled();
  });

  // Every shape that is not the person's own confirmation: the bodyless
  // mount heal the settings page sent until v1.43.2, an empty object, the
  // retired `{ intent }` bodies, and an explicit `false`.
  it.each([
    ["no body (the old mount heal)", () => mkHeal()],
    ["an empty object", () => mkJson({})],
    ['the retired intent "heal"', () => mkJson({ intent: "heal" })],
    [
      'the retired intent "affirmative"',
      () => mkJson({ intent: "affirmative" }),
    ],
    ["confirm: false", () => mkJson({ confirm: false })],
  ])("refuses %s with 400 and never reaches the mint", async (_label, mk) => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await POST(mk());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("consent.ai.confirmRequired");
    expect(grantWebAiConsent).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("rejects a malformed confirmation with 422 and never reaches the mint", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await POST(mkJson({ confirm: "yes" }));
    expect(res.status).toBe(422);
    expect(grantWebAiConsent).not.toHaveBeenCalled();
  });
});
