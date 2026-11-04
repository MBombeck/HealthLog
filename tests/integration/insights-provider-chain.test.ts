/**
 * Integration test for v1.4.16 phase B5b — multi-provider redundancy.
 *
 * Scenario: a user has an OpenAI key configured AND the operator has
 * an admin-OpenAI key configured. The OpenAI primary is deliberately
 * broken (its base URL points to an absent localhost port → fetch
 * throws ECONNREFUSED). The chain runner must cascade past the broken
 * primary to the working secondary (admin-OpenAI, mocked to return a
 * valid insight payload) and the route must surface a successful
 * response with `chainProviderType: "admin-openai"` recorded in the
 * audit log.
 *
 * Counter-scenario: when both providers are broken, the response is a
 * 503 with the expected error envelope.
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

// safeFetch's requirePublicHost path runs through undici's own `fetch`
// (version-locked with its dispatcher) rather than the global. Delegate it to
// the global `fetch` spy these tests install so the provider HTTP is mocked.
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (input: unknown, init?: unknown) =>
      (globalThis.fetch as unknown as (i: unknown, n?: unknown) => unknown)(
        input,
        init,
      ),
  };
});

// Stub feature extraction + prompt-building so the test stays focused
// on the chain semantics rather than the prompt's real content. Both
// modules are re-exported from inside the route via @/lib/insights so
// the standard module mock works.
vi.mock("@/lib/insights/features", () => ({
  extractFeatures: vi.fn(async () => ({ stub: true })),
  // v1.19.0 — the generate route reads the bounded briefing window constant;
  // the mock must export it or the route throws on access.
  BRIEFING_FEATURE_WINDOW_DAYS: 400,
}));
vi.mock("@/lib/insights/prompt", () => ({
  getInsightsSystemPrompt: vi.fn(() => "system"),
  buildUserPrompt: vi.fn(() => "user"),
}));
vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn(async () => "en"),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 3600_000,
  })),
  // The shared write ceiling every authenticated POST is charged against.
  checkRecordWriteRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 299,
    resetAt: Date.now() + 60_000,
  })),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  // Wipe the in-process last-working cache so test order doesn't
  // leak the fallback decision from one case into the next.
  const { clearLastWorkingProviderCache } =
    await import("@/lib/ai/provider-runner");
  clearLastWorkingProviderCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const VALID_LEGACY_INSIGHT = JSON.stringify({
  insightType: "general",
  summary: "ok",
  classification: "gut",
  findings: [],
  correlations: [],
  recommendations: [],
  dataQuality: { coverage: "fair", gaps: [], confidence: "mittel" },
  disclaimer: "consult your doctor",
});

async function seedUserWithKey(): Promise<{ userId: string }> {
  const prisma = getPrismaClient();
  const { encrypt } = await import("@/lib/crypto");
  const user = await prisma.user.create({
    data: {
      username: "chain-user",
      email: "chain@example.test",
      role: "USER",
      // Two user-level keys so the chain has two real candidates
      // (`openai` then `anthropic`) WITHOUT touching `app_settings`.
      // The testcontainer's migration history pre-dates several
      // `app_settings` columns added through schema-only edits
      // (default_locale, umami, ntfy_global, etc.), so triggering the
      // admin-openai resolution path (which reads every column) blows
      // up. Constrain the chain to user-level providers and we don't
      // need to seed app_settings at all.
      aiOpenaiKeyEncrypted: encrypt("sk-user-key"),
      aiAnthropicKeyEncrypted: encrypt("sk-ant-secondary"),
      aiProviderChain: [
        { providerType: "openai", priority: 1, enabled: true },
        { providerType: "anthropic", priority: 2, enabled: true },
      ] as never,
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);

  return { userId: user.id };
}

function jsonRequest(): Request {
  return new Request("http://localhost/api/insights/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ force: true }),
  });
}

interface SuccessEnvelope {
  data: { insights: unknown; cached: boolean };
}
interface ErrorEnvelope {
  data: null;
  error: string;
}

/**
 * Helpers for the route-off-fetch-by-URL pattern. The OpenAIClient
 * posts to `<base>/chat/completions`; the AnthropicClient posts to
 * `<base>/messages`. Both target distinct hosts in production, so the
 * URL prefix is enough to disambiguate which provider made the call
 * regardless of header shape.
 */
function isOpenAICall(input: RequestInfo | URL): boolean {
  const url =
    input instanceof URL
      ? input.href
      : typeof input === "string"
        ? input
        : input.url;
  return url.includes("/chat/completions");
}

function isAnthropicCall(input: RequestInfo | URL): boolean {
  const url =
    input instanceof URL
      ? input.href
      : typeof input === "string"
        ? input
        : input.url;
  return url.includes("/messages");
}

function anthropicSuccess(): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: VALID_LEGACY_INSIGHT }],
      usage: { input_tokens: 10, output_tokens: 32 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("POST /api/insights/generate — chain fallback", () => {
  it("falls back from broken OpenAI primary to Anthropic secondary when the primary fails", async () => {
    await seedUserWithKey();

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        if (isOpenAICall(input)) {
          return new Response(
            JSON.stringify({ error: { code: "invalid_api_key" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        if (isAnthropicCall(input)) {
          return anthropicSuccess();
        }
        throw new Error(`unexpected URL: ${String(input)}`);
      });

    const { POST } = await import("@/app/api/insights/generate/route");
    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope;
    expect(body.data.cached).toBe(false);

    // Both calls fired (primary 401, secondary success).
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Audit log carries the working provider type + hop count.
    const prisma = getPrismaClient();
    const audit = await prisma.auditLog.findFirst({
      where: { action: "insights.generate" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    const details = JSON.parse(audit!.details!);
    expect(details.chainProviderType).toBe("anthropic");
    expect(details.fallbackHopCount).toBe(1);
  });

  it("returns 503 when every chain entry fails hard", async () => {
    await seedUserWithKey();

    // Every fetch fails with 503 (upstream brown-out).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream down", { status: 503 }),
    );

    const { POST } = await import("@/app/api/insights/generate/route");
    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error).toMatch(/temporarily unavailable/i);
  });

  it("caches the working provider so the next call skips the broken primary", async () => {
    await seedUserWithKey();

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        if (isOpenAICall(input)) {
          return new Response("nope", { status: 401 });
        }
        if (isAnthropicCall(input)) {
          return anthropicSuccess();
        }
        throw new Error(`unexpected URL: ${String(input)}`);
      });

    const { POST } = await import("@/app/api/insights/generate/route");

    // First call: OpenAI fails 401, Anthropic succeeds (2 fetches).
    const res1 = await POST(jsonRequest() as never);
    expect(res1.status).toBe(200);
    const callsAfterFirst = fetchSpy.mock.calls.length;
    expect(callsAfterFirst).toBe(2);

    // Force a fresh generation (bypass the 24h DB cache).
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { username: "chain-user" },
      data: { insightsCachedAt: null, insightsCachedTextEncrypted: null },
    });

    // Second call: cache should reorder so Anthropic is the first
    // attempt — only ONE more fetch call (no wasted OpenAI 401).
    const res2 = await POST(jsonRequest() as never);
    expect(res2.status).toBe(200);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst + 1);

    // Audit log carries fallback_hop_count: 0 on the second call.
    const audits = await prisma.auditLog.findMany({
      where: { action: "insights.generate" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(2);
    const second = JSON.parse(audits[1].details!);
    expect(second.fallbackHopCount).toBe(0);
    expect(second.chainProviderType).toBe("anthropic");
  });
});
