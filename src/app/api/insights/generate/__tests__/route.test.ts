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

// v1.4.31 — `requireAssistantSurface()` is gated near the top of
// the handler. The test mocks the apiHandler wrapper itself out, so
// flag reads need a deterministic mock at the module boundary.
vi.mock("@/lib/feature-flags", () => ({
  requireAssistantSurface: vi.fn(async () => undefined),
  AssistantDisabledError: class extends Error {},
}));

const selfContextText = vi.hoisted(() => vi.fn<() => Promise<string | null>>());

vi.mock("@/lib/db", () => ({
  prisma: {
    // The briefing path now reserves against the day's token ledger before
    // egress and reconciles after (`reserveBudget` / `reconcileSpend`), both
    // over raw SQL. A zero prior total keeps every generation under the cap,
    // so these suites keep testing what they were written to test.
    $queryRaw: vi.fn(async () => [{ total_tokens: 0, operator_tokens: 0 }]),
    $executeRaw: vi.fn(async () => 0),
    user: {
      findUnique: vi.fn(async () => ({
        insightsPrivacyMode: "aggregated",
        insightsCachedAt: null,
        insightsCachedText: null,
        locale: "en",
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: {
      // v1.4.16 A7: route now evicts stale per-status cache rows
      // (`insights.<scope>-status.<locale>`) on every successful
      // generation. The test prisma mock has to surface the call so
      // the cache-invalidation test can assert against it.
      deleteMany: vi.fn(async () => ({ count: 0 })),
      // v1.25 — the GET read path consults the briefing-failure marker
      // (`readBriefingFailure`) and the failure paths append one
      // (`recordBriefingFailure`). Default to no marker.
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    // v1.12.1 — the server-managed consent gate reads the latest active
    // receipt before egress. These fixtures resolve to an admin-openai
    // chain, so the gate runs; return an active receipt so the generation
    // path under test proceeds. The gate's own behaviour is covered in
    // `consent-guard.test.ts`.
    consentReceipt: {
      findFirst: vi.fn(async () => ({ id: "receipt-1" })),
    },
  },
}));

vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextTextForUser: selfContextText,
  buildAboutMeInsightBlock: vi.fn(() => ""),
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

// The read-only GET probes the provider chain (no completion) and
// enqueues an out-of-band warm on a stale / missing cache.
vi.mock("@/lib/insights/status-provider", () => ({
  hasUsableStatusProvider: vi.fn(async () => true),
}));

vi.mock("@/lib/jobs/insight-pregenerate-shared", () => ({
  enqueueForceWarm: vi.fn(async () => undefined),
}));

// The POST follows a successful generation with a hash-gated refill of the
// per-status / generic-metric cards. Mocked at the module boundary — the
// enqueue pipeline itself is covered by the comprehensive-generate tests.
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  enqueueStatusRefillForUser: vi.fn(async () => 7),
  // v1.28.25 — the route shares the lib's comparison-snapshot builder
  // (its private near-copy was deleted). Null = comparison toggle off,
  // matching the pre-existing fixtures (no dashboardWidgetsJson set).
  buildComparisonSnapshotForUser: vi.fn(async () => null),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  // The briefing illness/cycle context resolves module gates through
  // `memoizePerRequest`, which reads the active wide-event via `getEvent`.
  // Returning no event makes the per-request cache fall through to the
  // factory, exercising the real gate path without a request scope.
  getEvent: vi.fn(() => undefined),
}));

// The briefing's illness/cycle context (v1.18.11 P5) is module-gated and
// server-authoritative with its own gate tests; these cases exercise the
// provider/cache path, so stub it to no context to keep the route isolated
// from the cycle/illness DB queries.
vi.mock("@/lib/insights/illness-cycle-briefing", () => ({
  buildBriefingIllnessCycleContext: vi.fn(async () => null),
  buildBriefingIllnessCyclePrompt: vi.fn(() => ""),
}));

vi.mock("@/lib/insights/features", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/insights/features")
  >("@/lib/insights/features");
  return {
    ...actual,
    extractFeatures: vi.fn(async () => ({ stub: true })),
  };
});

vi.mock("@/lib/ai/prompts/insight-system-prompt", () => ({
  buildUserPrompt: vi.fn(() => "user"),
}));

vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn(async () => "en"),
}));

import { GET, POST, resolveInsightsRateLimit } from "../route";
import { enqueueStatusRefillForUser } from "@/lib/insights/comprehensive-generate";
import { resolveProvider } from "@/lib/ai/provider";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { hasUsableStatusProvider } from "@/lib/insights/status-provider";
import { enqueueForceWarm } from "@/lib/jobs/insight-pregenerate-shared";
import { clearLastWorkingProviderCache } from "@/lib/ai/provider-runner";
import {
  extractFeatures,
  FeaturesPayloadTooLargeError,
} from "@/lib/insights/features";
import { annotate } from "@/lib/logging/context";

beforeEach(() => {
  vi.clearAllMocks();
  // The B5b fallback runner caches "last working provider" per user
  // across calls; tests that assert single-provider error mapping
  // need a fresh cache so the previous test's success doesn't reorder
  // the chain on the next request.
  clearLastWorkingProviderCache();
  // `clearAllMocks` does not undo a `mockImplementation`, so the ledger stub is
  // re-seeded per test — otherwise the over-cap case below leaks into the rest.
  vi.mocked(prisma.$queryRaw).mockImplementation((async () => [
    { total_tokens: 0, operator_tokens: 0 },
  ]) as never);
  selfContextText.mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
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

describe("POST /api/insights/generate — daily token ceiling", () => {
  it("refuses over-cap with 429 before any provider egress", async () => {
    // The reservation reports a prior total already at the ceiling. The hourly
    // rate limit bounds how OFTEN this route runs; the ledger bounds what it
    // costs. Before this wiring the route had only the former, so ten
    // full-price briefings an hour was the real ceiling.
    // Targeted at the ledger's upsert only — other raw reads on this path
    // (the plateau / derived-signal probes) must keep their own shape.
    vi.mocked(prisma.$queryRaw).mockImplementation((async (
      strings: TemplateStringsArray,
    ) =>
      String(strings[0]).includes("coach_usage")
        ? [{ total_tokens: 10_000_000, operator_tokens: 10_000_000 }]
        : [{ total_tokens: 0, operator_tokens: 0 }]) as never);
    makeWorkingProvider();

    const res = await POST(jsonRequest({ force: true }) as never);
    expect(res.status).toBe(429);
    const body = (await res.json()) as ApiErrorEnvelope;
    expect(body.error).toContain("Daily AI token budget");
    // Not a provider failure: no cache row written, so the last good briefing
    // stays intact and the card does not blank.
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(enqueueStatusRefillForUser).not.toHaveBeenCalled();
  });
});

describe("POST /api/insights/generate — provider error mapping", () => {
  it("rejects a body over the 16 KB cap with 413 before parsing", async () => {
    const res = await POST(
      jsonRequest({ force: true, pad: "x".repeat(16 * 1024) }) as never,
    );
    expect(res.status).toBe(413);
  });

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
// The maintainer reported the previous 2/h was too aggressive when iterating on
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
        limit: 10,
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
        limit: 3,
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

// v1.16.8 — a fresh comprehensive insight no longer nukes the per-scope
// status cache (the old A7.2 sweep). The cards track their own data via
// the ingest invalidator + per-card content-hash gates; the route's job
// is to store the snapshot fingerprint so the off-request regeneration
// paths can detect "nothing changed" and skip the provider.
describe("POST /api/insights/generate — cache write (v1.16.8)", () => {
  it("does NOT delete per-status audit-log cache rows after a successful generation", async () => {
    makeWorkingProvider();

    const res = await POST(jsonRequest({ force: true }) as never);
    expect(res.status).toBe(200);

    expect(prisma.auditLog.deleteMany).not.toHaveBeenCalled();
  });

  it("stores the snapshot fingerprint alongside the cached text", async () => {
    makeWorkingProvider();

    const res = await POST(jsonRequest({ force: true }) as never);
    expect(res.status).toBe(200);

    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.user.updateMany).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(args.data.insightsCachedText).toEqual(expect.any(String));
    // SHA-256 hex digest of the compacted feature snapshot.
    expect(args.data.insightsSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    // The cache row records the language it was written in, so a reader
    // in another language is never served this text.
    expect(args.data.insightsCachedLocale).toBe("en");
  });

  it("refuses a stale cache write when AI profile inclusion changes during generation", async () => {
    makeWorkingProvider();
    selfContextText
      .mockResolvedValueOnce("Chronic conditions: Asthma")
      .mockResolvedValueOnce(null);

    const res = await POST(jsonRequest({ force: true }) as never);

    expect(res.status).toBe(409);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(enqueueStatusRefillForUser).not.toHaveBeenCalled();
  });

  it("commits successfully even when an unrelated User update (e.g. a provider credential refresh) lands mid-generation", async () => {
    // resolveProviderChain()'s token-maintenance write (and any other User
    // update outside the prompt-scope columns) bumps `updatedAt` but must
    // never collide with this guard — the where-clause below no longer
    // references it at all.
    makeWorkingProvider();
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: null,
      insightsCachedText: null,
      insightsExcludeMetrics: ["sleep"],
      locale: "en",
      dateOfBirth: null,
      gender: "FEMALE",
      heightCm: 170,
      displayName: "Sam",
    } as never);
    // The real DB returns count: 1 here too, since the exact-field
    // predicate never touches `updatedAt` — a concurrent OAuth
    // token-refresh write to the row cannot make it miss.
    vi.mocked(prisma.user.updateMany).mockResolvedValueOnce({ count: 1 });

    const res = await POST(jsonRequest({ force: true }) as never);

    expect(res.status).toBe(200);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const where = vi.mocked(prisma.user.updateMany).mock.calls[0][0]
      .where as Record<string, unknown>;
    expect(where).not.toHaveProperty("updatedAt");
    expect(where).toMatchObject({
      insightsPrivacyMode: "aggregated",
      insightsExcludeMetrics: { equals: ["sleep"] },
      locale: "en",
      dateOfBirth: null,
      gender: "FEMALE",
      heightCm: 170,
      displayName: "Sam",
    });
    expect(enqueueStatusRefillForUser).toHaveBeenCalled();
  });

  it("refuses a stale cache write when an exact prompt-scope field (privacy mode / exclude list / locale / profile) changed mid-generation", async () => {
    makeWorkingProvider();
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: null,
      insightsCachedText: null,
      insightsExcludeMetrics: [],
      locale: "en",
    } as never);
    // Simulates a genuine concurrent settings change (e.g. the exclude
    // list edited) between the read above and the commit: the guarded
    // write's exact-field predicate now matches zero rows.
    vi.mocked(prisma.user.updateMany).mockResolvedValueOnce({ count: 0 });

    const res = await POST(jsonRequest({ force: true }) as never);

    expect(res.status).toBe(409);
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          insightsPrivacyMode: "aggregated",
          insightsExcludeMetrics: { equals: [] },
          locale: "en",
        }),
      }),
    );
    expect(enqueueStatusRefillForUser).not.toHaveBeenCalled();
  });

  it("does NOT touch the cache when serving from the 24h DB cache", async () => {
    // Cached path: route returns early without touching the LLM or the
    // cache write. v1.28.30 — the short-circuit requires the cached
    // payload to CARRY a briefing (a briefingless cache is stale for a
    // briefing-expecting caller), so the fixture carries one.
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify({
        changed: "still fresh",
        dailyBriefing: { paragraph: "ok", keyFindings: [] },
      }),
      locale: "en",
    } as never);

    const res = await POST(jsonRequest({}) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { cached: boolean } };
    expect(body.data.cached).toBe(true);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.deleteMany).not.toHaveBeenCalled();
  });

  it("enqueues the hash-gated card refill after a successful generation", async () => {
    makeWorkingProvider();

    const res = await POST(jsonRequest({ force: true }) as never);
    expect(res.status).toBe(200);

    // The manual regenerate takes the cards along: one refill enqueue for
    // the caller's resolved locale, annotated for the wide-event pipeline.
    expect(enqueueStatusRefillForUser).toHaveBeenCalledTimes(1);
    expect(enqueueStatusRefillForUser).toHaveBeenCalledWith("u-1", "en");
    const refillAnnotate = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "insights.generate.cards_refill",
      );
    expect(refillAnnotate, "cards_refill annotate event").toBeTruthy();
  });

  it("does NOT enqueue the card refill when serving from the 24h DB cache", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify({
        changed: "still fresh",
        dailyBriefing: { paragraph: "ok", keyFindings: [] },
      }),
      locale: "en",
    } as never);

    const res = await POST(jsonRequest({}) as never);
    expect(res.status).toBe(200);
    expect(enqueueStatusRefillForUser).not.toHaveBeenCalled();
  });

  it("does NOT enqueue the card refill when the provider fails", async () => {
    makeProviderThatThrows(
      Object.assign(new Error("OpenAI request failed (500)"), {
        httpStatus: 500,
      }),
    );

    const res = await POST(jsonRequest({ force: true }) as never);
    expect(res.status).toBe(503);
    expect(enqueueStatusRefillForUser).not.toHaveBeenCalled();
  });
});

// v1.28.30 — the "no briefing today" chain: a failed nightly warm left a
// fresh-but-briefingless cache inside the 24 h window, and the POST's
// unconditional short-circuit served it to every regenerate attempt
// (`cached: true` three times in prod, zero generations, a full day
// without a briefing). The short-circuit now only holds when the cached
// payload carries a briefing OR the account has no usable provider.
describe("POST /api/insights/generate — briefingless fresh cache (v1.28.30)", () => {
  function mockBriefinglessFreshCache() {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({
        changed: "fresh but no briefing",
        dailyBriefing: null,
      }),
      insightsExcludeMetrics: [],
      locale: "en",
    } as never);
  }

  it("POST without force + fresh cache WITH briefing → served cached", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsPrivacyMode: "aggregated",
      insightsCachedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      insightsCachedText: JSON.stringify({
        dailyBriefing: { paragraph: "today", keyFindings: [] },
      }),
      locale: "en",
    } as never);

    const res = await POST(jsonRequest({}) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { cached: boolean } };
    expect(body.data.cached).toBe(true);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("POST without force + fresh cache WITHOUT briefing + provider → regenerates", async () => {
    makeWorkingProvider();
    mockBriefinglessFreshCache();

    const res = await POST(jsonRequest({}) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { cached: boolean } };
    // The stale-for-briefing cache was bypassed: a real generation ran and
    // wrote a fresh cache row.
    expect(body.data.cached).toBe(false);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
  });

  it("POST without force + fresh cache WITHOUT briefing + NO provider → serves cached (regeneration is futile)", async () => {
    vi.mocked(hasUsableStatusProvider).mockResolvedValueOnce(false);
    mockBriefinglessFreshCache();

    const res = await POST(jsonRequest({}) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { cached: boolean } };
    expect(body.data.cached).toBe(true);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("degrades to the cached payload instead of 429 when the briefingless fall-through is rate-limited", async () => {
    makeWorkingProvider();
    mockBriefinglessFreshCache();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 3600_000,
    });

    const res = await POST(jsonRequest({}) as never);
    // A POST-as-read caller never used to see a 429 on a fresh cache;
    // exhausting the quota falls back to the old cached-serve behaviour.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { cached: boolean } };
    expect(body.data.cached).toBe(true);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("explicit force keeps the honest 429 when rate-limited", async () => {
    makeWorkingProvider();
    mockBriefinglessFreshCache();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 3600_000,
    });

    const res = await POST(jsonRequest({ force: true }) as never);
    expect(res.status).toBe(429);
  });
});

// v1.4.36 QA H1 — when both the raw-mode extraction AND the aggregated
// retry cross the 5 MB ceiling, the route used to throw uncaught → 500.
// It now wraps the retry, downgrades further via the exclude filter,
// and on a third failure returns 422 with an annotate event for ops.
describe("POST /api/insights/generate — payload-size hard downgrade (H1)", () => {
  it("returns 422 with an annotate event when every fallback shape is oversized", async () => {
    makeWorkingProvider();
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      // Raw mode so the route's first extractFeatures call is the
      // wide shape; the retry asks for the aggregated shape.
      insightsPrivacyMode: "raw",
      insightsCachedAt: null,
      insightsCachedText: null,
      insightsExcludeMetrics: [],
      locale: "en",
    } as never);

    // Each call mimics features.ts blowing past the ceiling. Three
    // shots: raw, aggregated retry, hard-downgrade aggregated.
    vi.mocked(extractFeatures).mockReset();
    vi.mocked(extractFeatures)
      .mockRejectedValueOnce(
        new FeaturesPayloadTooLargeError(6_000_000, 5_242_880),
      )
      .mockRejectedValueOnce(
        new FeaturesPayloadTooLargeError(5_500_000, 5_242_880),
      )
      .mockRejectedValueOnce(
        new FeaturesPayloadTooLargeError(5_300_000, 5_242_880),
      );

    const res = await POST(jsonRequest({ force: true }) as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/payload size/i);

    // The annotate event fires with insights_payload_too_large so ops
    // can spot the regression in the wide-event pipeline.
    const calls = vi.mocked(annotate).mock.calls;
    const annotated = calls.find(
      (call) =>
        (call[0] as { meta?: Record<string, unknown> })?.meta
          ?.insights_payload_too_large === true,
    );
    expect(
      annotated,
      "annotate event with insights_payload_too_large",
    ).toBeTruthy();
  });
});

describe("GET /api/insights/generate — read-only advisor read", () => {
  it("serves the cached briefing without ever calling the provider", async () => {
    const cached = { dailyBriefing: { paragraph: "ok", keyFindings: [] } };
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(cached),
      locale: "en",
    } as never);

    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/generate"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { insights: unknown; cached: boolean; revalidating: boolean };
    };
    expect(body.data.cached).toBe(true);
    expect(body.data.insights).toEqual(cached);
    // No completion is ever run on the read path.
    expect(resolveProvider).not.toHaveBeenCalled();
    // A fresh cache (just now) does not trigger a warm — and the payload
    // says so, so the client never starts a convergence poll.
    expect(enqueueForceWarm).not.toHaveBeenCalled();
    expect(body.data.revalidating).toBe(false);
  });

  it("enqueues an out-of-band warm when the cache is stale and a provider exists", async () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsCachedAt: stale,
      insightsCachedText: JSON.stringify({ dailyBriefing: null }),
      locale: "en",
    } as never);

    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/generate"),
    );
    expect(res.status).toBe(200);
    expect(enqueueForceWarm).toHaveBeenCalledWith({
      userId: "u-1",
      locale: "en",
    });
    expect(resolveProvider).not.toHaveBeenCalled();
    // The stale serve is honest: `revalidating: true` rides on the
    // payload so the client polls (bounded) until the warm lands.
    const body = (await res.json()) as { data: { revalidating: boolean } };
    expect(body.data.revalidating).toBe(true);
  });

  // `resolveServerLocale` is mocked to "en" in this suite, so the reader is
  // an English session throughout; the cache tag is what varies.
  it("does NOT serve a fresh cache tagged with another language; warms in the reader's", async () => {
    const cached = { dailyBriefing: { paragraph: "Deutsch", keyFindings: [] } };
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(cached),
      insightsCachedLocale: "de",
      locale: "en",
    } as never);

    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/generate"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { insights: unknown; cached: boolean; revalidating: boolean };
    };
    expect(body.data.cached).toBe(false);
    expect(body.data.insights).toBeNull();
    expect(body.data.revalidating).toBe(true);
    expect(enqueueForceWarm).toHaveBeenCalledWith({
      userId: "u-1",
      locale: "en",
    });
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it("serves a fresh cache whose tag matches the reader's language", async () => {
    const cached = { dailyBriefing: { paragraph: "English", keyFindings: [] } };
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(cached),
      insightsCachedLocale: "en",
      locale: "en",
    } as never);

    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/generate"),
    );
    const body = (await res.json()) as {
      data: { insights: unknown; cached: boolean; revalidating: boolean };
    };
    expect(body.data.cached).toBe(true);
    expect(body.data.insights).toEqual(cached);
    expect(body.data.revalidating).toBe(false);
    expect(enqueueForceWarm).not.toHaveBeenCalled();
  });

  it("returns an empty payload (no warm) on a cold cache without a provider", async () => {
    vi.mocked(hasUsableStatusProvider).mockResolvedValueOnce(false);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsCachedAt: null,
      insightsCachedText: null,
      locale: "en",
    } as never);

    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/generate"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { insights: unknown; cached: boolean; revalidating: boolean };
    };
    expect(body.data.cached).toBe(false);
    expect(body.data.insights).toBeNull();
    expect(enqueueForceWarm).not.toHaveBeenCalled();
    // No warm enqueued → no convergence poll for the client to run.
    expect(body.data.revalidating).toBe(false);
  });

  // v1.18.9 (#4) — the read path reports provider availability so the
  // insights surfaces can pair a stale cached briefing's honest age with
  // a connect-provider hint. The cache is served regardless of provider
  // state, so `hasProvider: false` is the only honest "can never refresh"
  // signal the client has.
  it("reports hasProvider: false alongside a served stale briefing", async () => {
    vi.mocked(hasUsableStatusProvider).mockResolvedValueOnce(false);
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const cached = { dailyBriefing: { paragraph: "old", keyFindings: [] } };
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsCachedAt: stale,
      insightsCachedText: JSON.stringify(cached),
      locale: "en",
    } as never);

    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/generate"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { cached: boolean; hasProvider: boolean; revalidating: boolean };
    };
    // The stale briefing is still delivered (no provider needed to read).
    expect(body.data.cached).toBe(true);
    // But it can never refresh — no warm enqueued, hasProvider flagged.
    expect(body.data.hasProvider).toBe(false);
    expect(enqueueForceWarm).not.toHaveBeenCalled();
    expect(body.data.revalidating).toBe(false);
  });

  // v1.28.30 — a briefing the grounding gate withheld used to be visible
  // only on the transient POST response; every later read showed a generic
  // "no briefing yet". The marker written after the cache write now
  // surfaces the omission on the read path, WITHOUT reading as a failure.
  it("surfaces briefingOmittedReason from a briefing-ungrounded marker (not as a failure)", async () => {
    const cachedAt = new Date(Date.now() - 60 * 60 * 1000);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsCachedAt: cachedAt,
      insightsCachedText: JSON.stringify({ dailyBriefing: null }),
      locale: "en",
    } as never);
    // Marker newer than the last successful generation (written right
    // after the cache write on the strip path).
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValueOnce({
      createdAt: new Date(cachedAt.getTime() + 1000),
      details: JSON.stringify({ reason: "briefing-ungrounded" }),
    } as never);

    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/generate"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        briefingOmittedReason: string | null;
        generationFailed: boolean;
        generationFailureClass: string | null;
      };
    };
    expect(body.data.briefingOmittedReason).toBe("ungrounded");
    // The generation SUCCEEDED (the briefing was withheld) — the card must
    // render "withheld", not "couldn't generate".
    expect(body.data.generationFailed).toBe(false);
    expect(body.data.generationFailureClass).toBeNull();
  });

  it("still reports generationFailed for a genuine failure marker", async () => {
    const cachedAt = new Date(Date.now() - 60 * 60 * 1000);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsCachedAt: cachedAt,
      insightsCachedText: JSON.stringify({
        dailyBriefing: { paragraph: "held", keyFindings: [] },
      }),
      locale: "en",
    } as never);
    vi.mocked(prisma.auditLog.findFirst).mockResolvedValueOnce({
      createdAt: new Date(cachedAt.getTime() + 1000),
      details: JSON.stringify({ reason: "provider-error", httpStatus: 503 }),
    } as never);

    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/generate"),
    );
    const body = (await res.json()) as {
      data: { briefingOmittedReason: string | null; generationFailed: boolean };
    };
    expect(body.data.generationFailed).toBe(true);
    expect(body.data.briefingOmittedReason).toBeNull();
  });

  it("reports hasProvider: true on a normal cached read", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify({
        dailyBriefing: { paragraph: "ok", keyFindings: [] },
      }),
      locale: "en",
    } as never);

    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/generate"),
    );
    const body = (await res.json()) as { data: { hasProvider: boolean } };
    expect(body.data.hasProvider).toBe(true);
  });
});
