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
  enforceBudget: vi.fn(async () => undefined),
  recordSpend: vi.fn(async () => undefined),
}));

vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: vi.fn(async () => ({ type: "none" })),
  resolveProviderChain: vi.fn(async () => []),
}));

vi.mock("@/lib/ai/provider-runner", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/ai/provider-runner")>(
      "@/lib/ai/provider-runner",
    );
  return {
    ...actual,
    runRawCompletionWithFallback: vi.fn(),
  };
});

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
  eventStorage: { getStore: () => undefined, run: (_s: unknown, f: () => unknown) => f() },
}));

import { POST } from "../route";
import { requireAuth, HttpError } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { enforceBudget } from "@/lib/ai/coach/budget";
import {
  resolveProvider,
  resolveProviderChain,
} from "@/lib/ai/provider";
import { runRawCompletionWithFallback } from "@/lib/ai/provider-runner";

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
    remaining: 9,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(enforceBudget).mockResolvedValue(undefined);
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
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(
      postReq({ text: "Mounjaro 5mg weekly" }) as never,
    );
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

    const res = await POST(
      postReq({ text: "Mounjaro 5mg weekly" }) as never,
    );
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

    const res = await POST(
      postReq({ text: "Mounjaro 5mg weekly" }) as never,
    );
    expect(res.status).toBe(502);
  });
});
