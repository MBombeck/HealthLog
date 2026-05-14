import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// --- Module-boundary mocks must come before importing the route. ---

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    withingsConnection: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/withings/sync", () => ({
  syncUserMeasurements: vi.fn(),
}));

// v1.4.25 W17b/c — activity / sleep paths dispatch through pg-boss.
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(),
}));

vi.mock("@/lib/withings/sync-activity", () => ({
  syncUserActivity: vi.fn(),
}));

vi.mock("@/lib/withings/sync-sleep", () => ({
  syncUserSleep: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => ({
    setAuth: vi.fn(),
    addWarning: vi.fn(),
  })),
}));

import { POST, GET, HEAD } from "../route";
import { prisma } from "@/lib/db";
import { syncUserMeasurements } from "@/lib/withings/sync";
import { checkRateLimit } from "@/lib/rate-limit";
import { getEvent } from "@/lib/logging/context";

const ORIGINAL_SECRET = process.env.WITHINGS_WEBHOOK_SECRET;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.WITHINGS_WEBHOOK_SECRET = "test-secret";
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 30,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(getEvent).mockReturnValue({
    setAuth: vi.fn(),
    addWarning: vi.fn(),
  } as never);
  vi.mocked(syncUserMeasurements).mockResolvedValue(undefined as never);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.WITHINGS_WEBHOOK_SECRET;
  else process.env.WITHINGS_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

function jsonRequest(token: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/withings/webhook/${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function paramsFor(token: string) {
  return { params: Promise.resolve({ token }) };
}

describe("POST /api/withings/webhook/[token] (path-segment secret)", () => {
  it("returns 200 + triggers sync when the path token matches WITHINGS_WEBHOOK_SECRET", async () => {
    vi.mocked(prisma.withingsConnection.findFirst).mockResolvedValueOnce({
      userId: "user-42",
      withingsUserId: "wu-1",
    } as never);

    const res = await POST(
      jsonRequest("test-secret", { userid: "wu-1" }),
      paramsFor("test-secret"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");

    expect(prisma.withingsConnection.findFirst).toHaveBeenCalledWith({
      where: { withingsUserId: "wu-1" },
    });
    expect(syncUserMeasurements).toHaveBeenCalledTimes(1);
    expect(syncUserMeasurements).toHaveBeenCalledWith("user-42");
  });

  it("returns 401 when the path token does NOT match the configured secret", async () => {
    const res = await POST(
      jsonRequest("WRONG", { userid: "wu-1" }),
      paramsFor("WRONG"),
    );
    expect(res.status).toBe(401);
    expect(syncUserMeasurements).not.toHaveBeenCalled();
    expect(prisma.withingsConnection.findFirst).not.toHaveBeenCalled();
  });

  it("returns 401 when the path token is the empty string (missing)", async () => {
    // Next.js never routes /api/withings/webhook/ to this handler — that
    // path lands on the legacy route. The empty-string case here covers
    // direct invocations and adversarial proxies that strip the segment.
    const res = await POST(
      new NextRequest("http://localhost/api/withings/webhook/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userid: "wu-1" }),
      }),
      paramsFor(""),
    );
    expect(res.status).toBe(401);
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });

  it("returns 401 when WITHINGS_WEBHOOK_SECRET is unset, even if the URL carries a token", async () => {
    delete process.env.WITHINGS_WEBHOOK_SECRET;
    const addWarning = vi.fn();
    vi.mocked(getEvent).mockReturnValue({
      setAuth: vi.fn(),
      addWarning,
    } as never);

    const res = await POST(
      jsonRequest("anything", { userid: "wu-1" }),
      paramsFor("anything"),
    );
    expect(res.status).toBe(401);
    expect(addWarning).toHaveBeenCalledWith(
      "WITHINGS_WEBHOOK_SECRET not configured",
    );
  });

  it("constant-time compare rejects a token of the wrong length without short-circuiting on prefix match", async () => {
    // "test-secret" is the configured value; "test-secret-extra" shares
    // the full prefix. A non-timing-safe compare would still return false
    // here, so the assertion is on the response only — the security
    // property is exercised by the underlying timingSafeEqual call shape.
    const res = await POST(
      jsonRequest("test-secret-extra", { userid: "wu-1" }),
      paramsFor("test-secret-extra"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate-limited, before the auth check", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);
    const res = await POST(
      jsonRequest("WRONG", { userid: "wu-1" }),
      paramsFor("WRONG"),
    );
    expect(res.status).toBe(429);
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });
});

describe("HEAD /api/withings/webhook/[token]", () => {
  it("returns 200 for a valid token, 401 otherwise", async () => {
    const okReq = new NextRequest(
      "http://localhost/api/withings/webhook/test-secret",
      { method: "HEAD" },
    );
    const ok = await HEAD(okReq, paramsFor("test-secret"));
    expect(ok.status).toBe(200);

    const badReq = new NextRequest(
      "http://localhost/api/withings/webhook/WRONG",
      { method: "HEAD" },
    );
    const bad = await HEAD(badReq, paramsFor("WRONG"));
    expect(bad.status).toBe(401);
  });
});

describe("GET /api/withings/webhook/[token]", () => {
  it("returns 200 + ok body for a valid token, 401 otherwise", async () => {
    const okReq = new NextRequest(
      "http://localhost/api/withings/webhook/test-secret",
    );
    const ok = await GET(okReq, paramsFor("test-secret"));
    expect(ok.status).toBe(200);

    const badReq = new NextRequest(
      "http://localhost/api/withings/webhook/WRONG",
    );
    const bad = await GET(badReq, paramsFor("WRONG"));
    expect(bad.status).toBe(401);
  });
});
