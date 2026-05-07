import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be hoisted before importing the route.
vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u-1" }, session: { id: "s-1" } })),
}));

vi.mock("@/lib/ai/provider", () => ({
  resolveProvider: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { POST } from "../route";
import { resolveProvider } from "@/lib/ai/provider";

beforeEach(() => {
  vi.resetAllMocks();
});

interface ApiErrorEnvelope {
  data: null;
  error: string;
}

// V3 audit: /api/ai/test was returning provider err.message + bodyExcerpt
// directly to the client, leaking provider URLs / partial keys / internal
// headers. Server now logs full details via annotate() and responds with
// a categorised, generic message.
describe("POST /api/ai/test — provider error leak guard", () => {
  function makeProviderThatThrows(
    err: Error & { httpStatus?: number; bodyExcerpt?: string },
  ) {
    vi.mocked(resolveProvider).mockResolvedValue({
      type: "openai",
      generateCompletion: vi.fn(async () => {
        throw err;
      }),
    } as never);
  }

  it("does not echo provider err.message back to the client (HIGH coverage gap)", async () => {
    const err = Object.assign(
      new Error("OpenAI 401 from https://api.openai.com/v1 sk-leaked-key"),
      { httpStatus: 401 as const, bodyExcerpt: '{"error":"invalid api key sk-secret"}' },
    );
    makeProviderThatThrows(err);

    const response = await POST();
    const body = (await response.json()) as ApiErrorEnvelope;

    expect(response.status).toBe(502);
    expect(body.error ?? "").not.toMatch(/sk-/);
    expect(body.error ?? "").not.toMatch(/api\.openai\.com/);
    expect(body.error ?? "").not.toMatch(/invalid api key/i);
    expect(body.error).toBe("Provider rejected the credentials");
  });

  it("returns the 429-categorised message when the provider rate-limits", async () => {
    makeProviderThatThrows(
      Object.assign(new Error("429 from openai"), { httpStatus: 429 as const }),
    );
    const response = await POST();
    expect(response.status).toBe(502);
    expect(((await response.json()) as ApiErrorEnvelope).error).toBe(
      "Provider rate-limited the request",
    );
  });

  it("returns the 5xx-categorised message when the provider has a server error", async () => {
    makeProviderThatThrows(
      Object.assign(new Error("503 upstream"), { httpStatus: 503 as const }),
    );
    const response = await POST();
    expect(((await response.json()) as ApiErrorEnvelope).error).toBe(
      "Provider returned a server error",
    );
  });

  it("returns the unknown-error fallback otherwise", async () => {
    makeProviderThatThrows(new Error("ECONNRESET"));
    const response = await POST();
    expect(((await response.json()) as ApiErrorEnvelope).error).toBe(
      "Provider connection failed",
    );
  });
});
