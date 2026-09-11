/**
 * v1.5.0 — auth + rate-limit + happy-path coverage for the natural-
 * language medication extraction route.
 *
 * The provider client is stubbed so the test runs without the network
 * and without a real model in the loop. The relevant property under
 * test is the route plumbing: auth → rate-limit → budget → schema →
 * citation guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/feature-flags", () => ({
  requireAssistantSurface: vi.fn(async () => undefined),
  AssistantDisabledError: class extends Error {},
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-05-28"),
  reserveBudget: vi.fn(async () => ({
    allowed: true,
    reserved: 700,
    totalAfter: 700,
  })),
  reconcileSpend: vi.fn(async () => undefined),
  // The REAL cap resolver is used in the cap test below; the default mock
  // returns a distinctive figure so an accidental default-cap regression is
  // visible in the assertion rather than silently passing.
  resolveDailyCap: vi.fn(() => 1_234_567),
  resolveDailyCapFor: vi.fn(() => 1_234_567),
  resolveCostOwner: vi.fn(() => "user" as const),
}));

vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: vi.fn(async () => ({ type: "none" })),
  resolveProviderChain: vi.fn(async () => []),
}));

// v1.12.1 — free-text medication extraction egresses PHI to the operator's
// server-managed key, so it now passes through the consent gate. Mock it to a
// no-op here; the gate's own fail-closed behaviour is covered by
// `consent-guard.test.ts`.
vi.mock("@/lib/ai/consent-guard", () => ({
  assertConsentForChain: vi.fn(async () => undefined),
}));

vi.mock("@/lib/ai/provider-runner", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/ai/provider-runner")
  >("@/lib/ai/provider-runner");
  return {
    ...actual,
    runRawCompletionWithFallback: vi.fn(),
  };
});

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
  eventStorage: {
    getStore: () => undefined,
    run: (_s: unknown, f: () => unknown) => f(),
  },
}));

import { POST } from "../route";
import { requireAuth, HttpError } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  reserveBudget,
  reconcileSpend,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import {
  runRawCompletionWithFallback,
  AllProvidersFailedError,
} from "@/lib/ai/provider-runner";
import { assertConsentForChain } from "@/lib/ai/consent-guard";

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const AUTH_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 9,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(reserveBudget).mockResolvedValue({
    allowed: true,
    reserved: 700,
    totalAfter: 700,
    owner: "user",
    operatorAfter: 0,
    limit: null,
  });
  vi.mocked(resolveDailyCap).mockReturnValue(1_234_567);
  vi.mocked(resolveProviderChain).mockResolvedValue([
    {
      providerType: "openai",
      instance: {
        type: "openai",
        generateCompletion: vi.fn(),
      },
    } as never,
  ]);
});

describe("POST /api/medications/extract — auth", () => {
  it("requires authentication — apiHandler wrapper converts the throw to a 401", async () => {
    // The route mock replaces `apiHandler` with the identity function
    // so the test surface invokes the handler directly. That means
    // `requireAuth()` throws an HttpError straight to the caller —
    // the apiHandler wrapper in production catches it and emits the
    // 401 JSON envelope. Asserting the throw confirms the handler
    // gates the request before any provider work begins.
    vi.mocked(requireAuth).mockRejectedValueOnce(
      new HttpError(401, "Not authenticated"),
    );
    await expect(
      POST(postReq({ text: "Mounjaro 5mg weekly" }) as never),
    ).rejects.toThrow(/Not authenticated/);
  });
});

describe("POST /api/medications/extract — rate limit", () => {
  it("returns 429 when the per-user bucket is exhausted", async () => {
    vi.mocked(requireAuth).mockResolvedValue(AUTH_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(postReq({ text: "Mounjaro 5mg weekly" }) as never);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/Too many requests/i);
  });
});

describe("POST /api/medications/extract — happy path", () => {
  it("returns 200 with the citation-guarded extraction envelope", async () => {
    vi.mocked(requireAuth).mockResolvedValue(AUTH_OK as never);
    // Provider returns a clean JSON reply that maps onto the schema.
    vi.mocked(runRawCompletionWithFallback).mockResolvedValueOnce({
      result: {
        content: JSON.stringify({
          name: "Mounjaro",
          dose: "5",
          doseUnit: "mg",
          cadenceKind: "everyNWeeks",
          intervalWeeks: 1,
          weekdays: ["WE"],
          timesOfDay: ["08:00"],
        }),
        tokensUsed: 120,
        model: "gpt-4",
        providerType: "anthropic",
      },
      workingProvider: { providerType: "openai", instance: {} as never },
      fallbackHops: [],
    });

    const res = await POST(
      postReq({
        text: "Mounjaro 5mg weekly on Wednesday at 08:00",
        locale: "en",
      }) as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data).toMatchObject({
      name: "Mounjaro",
      dose: "5",
      doseUnit: "mg",
      cadenceKind: "everyNWeeks",
    });
    // The PHI free-text egress is gated on an active consent receipt for the
    // coach surface before the provider chain runs.
    expect(assertConsentForChain).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "coach" }),
    );
  });

  it("strips a hallucinated name that is absent from the user's text", async () => {
    vi.mocked(requireAuth).mockResolvedValue(AUTH_OK as never);
    vi.mocked(runRawCompletionWithFallback).mockResolvedValueOnce({
      result: {
        content: JSON.stringify({
          name: "Wegovy",
          dose: "5",
          doseUnit: "mg",
        }),
        tokensUsed: 60,
        model: "gpt-4",
        providerType: "anthropic",
      },
      workingProvider: { providerType: "openai", instance: {} as never },
      fallbackHops: [],
    });

    const res = await POST(
      postReq({ text: "5mg weekly on Wednesday" }) as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBeUndefined();
    expect(body.data.dose).toBe("5");
  });
});

describe("POST /api/medications/extract — daily budget", () => {
  function okCompletion(tokensUsed: number | null) {
    return {
      result: {
        content: JSON.stringify({ dose: "5", doseUnit: "mg" }),
        tokensUsed,
        model: "gpt-4",
        providerType: "anthropic",
      },
      workingProvider: { providerType: "openai", instance: {} as never },
      fallbackHops: [],
    };
  }

  it("caps against the COST OWNER — the resolved chain, not the operator ceiling", async () => {
    vi.mocked(requireAuth).mockResolvedValue(AUTH_OK as never);
    vi.mocked(runRawCompletionWithFallback).mockResolvedValueOnce(
      okCompletion(120) as never,
    );

    await POST(postReq({ text: "5mg weekly" }) as never);

    // The cap is derived from the chain that would actually pay for the call.
    // A user-key chain ("openai") therefore never rides the operator ceiling —
    // `budget.test.ts` pins that resolveDailyCap([{openai}]) === USER_PLAN_CAP.
    expect(resolveDailyCap).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ providerType: "openai" }),
      ]),
    );
    // ...and the reservation is made against exactly that cap, not a default.
    expect(reserveBudget).toHaveBeenCalledWith(
      "user-1",
      expect.any(Number),
      "2026-05-28",
      1_234_567,
      "user",
      "coach",
    );
  });

  it("returns 429 without calling the provider when the day's cap is spent", async () => {
    vi.mocked(requireAuth).mockResolvedValue(AUTH_OK as never);
    vi.mocked(reserveBudget).mockResolvedValueOnce({
      allowed: false,
      reserved: 700,
      totalAfter: 9_999_999,
      owner: "user",
      operatorAfter: 0,
      limit: "owner-cap",
    });

    const res = await POST(postReq({ text: "Mounjaro 5mg weekly" }) as never);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/budget/i);
    // The refusal happens BEFORE any upstream spend.
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("reconciles the reservation against the provider's reported count", async () => {
    vi.mocked(requireAuth).mockResolvedValue(AUTH_OK as never);
    vi.mocked(runRawCompletionWithFallback).mockResolvedValueOnce(
      okCompletion(120) as never,
    );

    await POST(postReq({ text: "5mg weekly" }) as never);

    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      700,
      120,
      "2026-05-28",
      0,
      { servedBy: "openai", reservedOwner: "user" },
    );
  });

  it("bills the reservation, not zero, when the provider reports no count", async () => {
    vi.mocked(requireAuth).mockResolvedValue(AUTH_OK as never);
    vi.mocked(runRawCompletionWithFallback).mockResolvedValueOnce(
      okCompletion(null) as never,
    );

    await POST(postReq({ text: "5mg weekly" }) as never);

    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      700,
      700,
      "2026-05-28",
      0,
      { servedBy: "openai", reservedOwner: "user" },
    );
  });

  it("refunds the whole reservation when the provider chain fails", async () => {
    vi.mocked(requireAuth).mockResolvedValue(AUTH_OK as never);
    vi.mocked(runRawCompletionWithFallback).mockRejectedValueOnce(
      new AllProvidersFailedError([]),
    );

    const res = await POST(postReq({ text: "5mg weekly" }) as never);

    expect(res.status).toBe(503);
    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      700,
      0,
      "2026-05-28",
      0,
      { servedBy: null, reservedOwner: "user" },
    );
  });
});

describe("POST /api/medications/extract — validation + provider errors", () => {
  it("returns 422 on a malformed body", async () => {
    vi.mocked(requireAuth).mockResolvedValue(AUTH_OK as never);
    const res = await POST(postReq({ text: "" }) as never);
    expect(res.status).toBe(422);
  });

  it("returns 503 when no provider is configured for the user", async () => {
    vi.mocked(requireAuth).mockResolvedValue(AUTH_OK as never);
    vi.mocked(resolveProviderChain).mockResolvedValueOnce([]);
    vi.mocked(resolveProvider).mockResolvedValueOnce({
      type: "none",
    } as never);

    const res = await POST(postReq({ text: "Mounjaro 5mg weekly" }) as never);
    expect(res.status).toBe(503);
  });

  it("returns 502 when the provider returns unparseable JSON", async () => {
    vi.mocked(requireAuth).mockResolvedValue(AUTH_OK as never);
    vi.mocked(runRawCompletionWithFallback).mockResolvedValueOnce({
      result: {
        content: "not json at all",
        tokensUsed: 10,
        model: "gpt-4",
        providerType: "anthropic",
      },
      workingProvider: { providerType: "openai", instance: {} as never },
      fallbackHops: [],
    });

    const res = await POST(postReq({ text: "Mounjaro 5mg weekly" }) as never);
    expect(res.status).toBe(502);
  });
});
