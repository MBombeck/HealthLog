/**
 * Provider-error mapping for /api/insights/generate.
 *
 * v1.4.6 T5 fixed the parse-error path (502 → 422 to keep Cloudflare's
 * HTML-error rewrite from breaking `await res.json()`). The provider-
 * error path still propagated upstream errors (e.g. `OpenAI request
 * failed (401)` for an invalid admin key) to the apiHandler's generic
 * 500 handler. v1.5 now mirrors the v1.4.5 ai/test categorisation:
 *
 *   - 401/403 from the provider → 422 with a readable message
 *   - 5xx from the provider → 503 (transient)
 *   - 429 from the provider → 429 (passthrough, not 5xx)
 *   - any other status → 422 (generic provider-connection failure)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be hoisted before importing the route.
vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1", locale: "en" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        insightsPrivacyMode: "aggregated",
        insightsCachedAt: null,
        insightsCachedText: null,
        locale: "en",
      })),
      update: vi.fn(async () => ({})),
    },
    auditLog: {
      // v1.4.16 A7: route now evicts stale per-status cache rows
      // (`insights.<scope>-status.<locale>`) on every successful
      // generation. The test prisma mock has to surface the call so
      // the cache-invalidation test can assert against it.
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/ai/provider", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/ai/provider")>(
      "@/lib/ai/provider",
    );
  return {
    ...actual,
    resolveProvider: vi.fn(),
    // v1.4.16 phase B5b: the route consults the multi-provider chain
    // first; the existing single-provider mocks return an empty chain
    // so the route falls through to `resolveProvider()` and the legacy
    // test fixtures keep behaving exactly as before.
    resolveProviderChain: vi.fn(async () => []),
  };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/insights/features", () => ({
  extractFeatures: vi.fn(async () => ({ stub: true })),
}));

vi.mock("@/lib/insights/prompt", () => ({
  buildUserPrompt: vi.fn(() => "user"),
}));

vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn(async () => "en"),
}));

import { POST, resolveInsightsRateLimit } from "../route";
import { resolveProvider } from "@/lib/ai/provider";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { clearLastWorkingProviderCache } from "@/lib/ai/provider-runner";

beforeEach(() => {
  vi.clearAllMocks();
  // The B5b fallback runner caches "last working provider" per user
  // across calls; tests that assert single-provider error mapping
  // need a fresh cache so the previous test's success doesn't reorder
  // the chain on the next request.
  clearLastWorkingProviderCache();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 3600_000,
  });
});

function makeWorkingProvider() {
  vi.mocked(resolveProvider).mockResolvedValue({
    type: "openai",
    generateCompletion: vi.fn(async () => ({
      content: JSON.stringify({
        changed: "ok",
        stable: "ok",
        drivers: "ok",
        nextSteps: "ok",
        confidence: "mittel",
        limitations: "ok",
      }),
      tokensUsed: 100,
      providerType: "openai",
      model: "gpt-4",
    })),
  } as unknown as Awaited<ReturnType<typeof resolveProvider>>);
}

interface ApiErrorEnvelope {
  data: null;
  error: string;
}

function jsonRequest(body: unknown = {}): Request {
  const text = JSON.stringify(body);
  return new Request("http://localhost/api/insights/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(text.length),
    },
    body: text,
  });
}

function makeProviderThatThrows(
  err: Error & { httpStatus?: number; bodyExcerpt?: string },
) {
  vi.mocked(resolveProvider).mockResolvedValue({
    type: "openai",
    generateCompletion: vi.fn(async () => {
      throw err;
    }),
    // The route only calls generateCompletion; pad the type for TS.
  } as unknown as Awaited<ReturnType<typeof resolveProvider>>);
}

describe("POST /api/insights/generate — provider error mapping", () => {
  it("maps a 401 from the provider to 422 with a readable message", async () => {
    const err = Object.assign(new Error("OpenAI request failed (401)"), {
      httpStatus: 401,
      bodyExcerpt: '{"error":{"code":"invalid_api_key"}}',
    });
    makeProviderThatThrows(err);

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/AI provider rejected/i);
    expect(body.error).toMatch(/API key/i);
  });

  it("maps a 403 from the provider to 422 with the same readable message", async () => {
    const err = Object.assign(new Error("OpenAI request failed (403)"), {
      httpStatus: 403,
    });
    makeProviderThatThrows(err);

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/AI provider rejected/i);
  });

  it("maps a 500 from the provider to 503 with a transient message", async () => {
    const err = Object.assign(new Error("OpenAI request failed (500)"), {
      httpStatus: 500,
    });
    makeProviderThatThrows(err);

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/temporarily unavailable/i);
  });

  it("maps a 503 from the provider to 503 with a transient message", async () => {
    const err = Object.assign(new Error("OpenAI request failed (503)"), {
      httpStatus: 503,
    });
    makeProviderThatThrows(err);

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(503);
  });

  it("maps a 429 from the provider to 429 (rate-limit passthrough)", async () => {
    const err = Object.assign(new Error("OpenAI request failed (429)"), {
      httpStatus: 429,
    });
    makeProviderThatThrows(err);

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(429);
  });

  it("maps an unknown error (no httpStatus) to 422 with a generic message", async () => {
    makeProviderThatThrows(new Error("network unreachable"));

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/provider/i);
  });
});

// v1.4.16 A7.1: rate limit raised from 2 → 10/h, env-configurable.
// the maintainer reported the previous 2/h was too aggressive when iterating on
// settings. The 10/h ceiling is the new default; the env override lets
// operators on a tight LLM budget dial it back without a rebuild.
describe("POST /api/insights/generate — rate limit (v1.4.16 A7.1)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.INSIGHTS_RATE_LIMIT_PER_HOUR;
  });

  it("defaults to 10 requests per hour and rejects the 11th with a clear message", async () => {
    makeWorkingProvider();
    // Simulate 10 successful checkRateLimit responses, then one denial.
    let callCount = 0;
    vi.mocked(checkRateLimit).mockImplementation(async (_key, limit) => {
      callCount += 1;
      // The route must pass `10` as the limit when the env var is unset.
      expect(limit).toBe(10);
      return {
        allowed: callCount <= 10,
        remaining: Math.max(0, 10 - callCount),
        resetAt: Date.now() + 3600_000,
      };
    });

    for (let i = 0; i < 10; i += 1) {
      const res = await POST(jsonRequest({ force: true }) as never);
      expect(res.status, `request ${i + 1} should succeed`).toBe(200);
    }
    const denied = await POST(jsonRequest({ force: true }) as never);
    expect(denied.status).toBe(429);
    const body = (await denied.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/Maximum 10 insight generations per hour/);
  });

  it("honours INSIGHTS_RATE_LIMIT_PER_HOUR env override", async () => {
    process.env.INSIGHTS_RATE_LIMIT_PER_HOUR = "3";
    expect(resolveInsightsRateLimit()).toBe(3);

    makeWorkingProvider();
    let callCount = 0;
    vi.mocked(checkRateLimit).mockImplementation(async (_key, limit) => {
      callCount += 1;
      expect(limit).toBe(3);
      return {
        allowed: callCount <= 3,
        remaining: Math.max(0, 3 - callCount),
        resetAt: Date.now() + 3600_000,
      };
    });

    for (let i = 0; i < 3; i += 1) {
      const res = await POST(jsonRequest({ force: true }) as never);
      expect(res.status).toBe(200);
    }
    const denied = await POST(jsonRequest({ force: true }) as never);
    expect(denied.status).toBe(429);
    const body = (await denied.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/Maximum 3 insight generations per hour/);
  });

  it("falls back to 10 when env var is non-numeric or sub-1", () => {
    process.env.INSIGHTS_RATE_LIMIT_PER_HOUR = "garbage";
    expect(resolveInsightsRateLimit()).toBe(10);
    process.env.INSIGHTS_RATE_LIMIT_PER_HOUR = "0";
    expect(resolveInsightsRateLimit()).toBe(10);
    process.env.INSIGHTS_RATE_LIMIT_PER_HOUR = "-5";
    expect(resolveInsightsRateLimit()).toBe(10);
    delete process.env.INSIGHTS_RATE_LIMIT_PER_HOUR;
    expect(resolveInsightsRateLimit()).toBe(10);
  });
});

// v1.4.16 A7.2: every fresh comprehensive insight evicts the per-
// scope status cache so the dashboard and the insights-page status
// cards never disagree. Without this, force-regeneration repaints
// `/api/insights/generate` while `/api/insights/<scope>-status` keeps
// returning yesterday's text until midnight Berlin time.
describe("POST /api/insights/generate — per-status cache eviction (A7.2)", () => {
  it("deletes per-status audit-log cache rows after a successful generation", async () => {
    makeWorkingProvider();

    const res = await POST(jsonRequest({ force: true }) as never);
    expect(res.status).toBe(200);

    expect(prisma.auditLog.deleteMany).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.auditLog.deleteMany).mock.calls[0][0];
    expect(args).toMatchObject({
      where: {
        userId: "u-1",
        action: { startsWith: "insights." },
        AND: [{ action: { contains: "-status." } }],
      },
    });
  });

  it("does NOT delete per-status cache when serving from the 24h DB cache", async () => {
    // Cached path: route returns early without touching the LLM or the
    // cache-eviction helper.
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify({ changed: "still fresh" }),
      locale: "en",
    } as never);

    const res = await POST(jsonRequest({}) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { cached: boolean } };
    expect(body.data.cached).toBe(true);
    expect(prisma.auditLog.deleteMany).not.toHaveBeenCalled();
  });
});
