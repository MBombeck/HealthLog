import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be hoisted before importing the route.
vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/ai/provider", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/ai/provider")>(
      "@/lib/ai/provider",
    );
  return {
    ...actual,
    resolveProviderForTest: vi.fn(),
  };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { POST } from "../route";
import { resolveProviderForTest } from "@/lib/ai/provider";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveProviderForTest).mockReset();
});

interface ApiErrorEnvelope {
  data: null;
  error: string;
}

interface ApiSuccessEnvelope<T> {
  data: T;
  error: null;
}

function emptyRequest(): Request {
  return new Request("http://localhost/api/ai/test", {
    method: "POST",
    headers: { "content-length": "0" },
  });
}

function jsonRequest(body: unknown): Request {
  const text = JSON.stringify(body);
  return new Request("http://localhost/api/ai/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(text.length),
    },
    body: text,
  });
}

// V3 audit: /api/ai/test was returning provider err.message + bodyExcerpt
// directly to the client, leaking provider URLs / partial keys / internal
// headers. Server now logs full details via annotate() and responds with
// a categorised, generic message.
describe("POST /api/ai/test — provider error leak guard", () => {
  function makeProviderThatThrows(
    err: Error & { httpStatus?: number; bodyExcerpt?: string },
  ) {
    vi.mocked(resolveProviderForTest).mockResolvedValue({
      type: "openai",
      generateCompletion: vi.fn(async () => {
        throw err;
      }),
    } as never);
  }

  it("does not echo provider err.message back to the client (HIGH coverage gap)", async () => {
    const err = Object.assign(
      new Error("OpenAI 401 from https://api.openai.com/v1 sk-leaked-key"),
      {
        httpStatus: 401 as const,
        bodyExcerpt: '{"error":"invalid api key sk-secret"}',
      },
    );
    makeProviderThatThrows(err);

    const response = await POST(emptyRequest() as never);
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
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(502);
    expect(((await response.json()) as ApiErrorEnvelope).error).toBe(
      "Provider rate-limited the request",
    );
  });

  it("returns the 5xx-categorised message when the provider has a server error", async () => {
    makeProviderThatThrows(
      Object.assign(new Error("503 upstream"), { httpStatus: 503 as const }),
    );
    const response = await POST(emptyRequest() as never);
    expect(((await response.json()) as ApiErrorEnvelope).error).toBe(
      "Provider returned a server error",
    );
  });

  it("returns the unknown-error fallback otherwise", async () => {
    makeProviderThatThrows(new Error("ECONNRESET"));
    const response = await POST(emptyRequest() as never);
    expect(((await response.json()) as ApiErrorEnvelope).error).toBe(
      "Provider connection failed",
    );
  });
});

// v1.4 fix: the dropdown in /settings was not honoured — the test always
// ran against the SAVED provider (Marc reported "wirft was Komisches raus").
// The route now accepts a JSON override body and forwards the user's
// unsaved selection to resolveProviderForTest().
describe("POST /api/ai/test — dropdown-aware override", () => {
  function makeProviderThatSucceeds(model: string) {
    vi.mocked(resolveProviderForTest).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async () => ({
        content: '{"ok":true}',
        providerType: "anthropic",
        model,
        tokensUsed: 5,
      })),
    } as never);
  }

  it("forwards a dropdown override to resolveProviderForTest", async () => {
    makeProviderThatSucceeds("claude-3-5-sonnet-latest");
    const response = await POST(
      jsonRequest({
        provider: "ANTHROPIC",
        model: "claude-3-5-sonnet-latest",
      }) as never,
    );
    expect(response.status).toBe(200);
    expect(resolveProviderForTest).toHaveBeenCalledWith("u-1", {
      provider: "ANTHROPIC",
      model: "claude-3-5-sonnet-latest",
    });
    const body = (await response.json()) as ApiSuccessEnvelope<{
      providerType: string;
      model: string;
    }>;
    expect(body.data.providerType).toBe("anthropic");
    expect(body.data.model).toBe("claude-3-5-sonnet-latest");
  });

  it("rejects unknown provider values with 422", async () => {
    const response = await POST(
      jsonRequest({ provider: "MALICIOUS" }) as never,
    );
    expect(response.status).toBe(422);
    expect(resolveProviderForTest).not.toHaveBeenCalled();
  });

  it("uses the persisted config when the body is empty", async () => {
    makeProviderThatSucceeds("claude-3-5-sonnet-latest");
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(200);
    expect(resolveProviderForTest).toHaveBeenCalledWith("u-1", {});
  });

  it("surfaces config errors as the same status as the resolver throws", async () => {
    const { AITestConfigError } = await import("@/lib/ai/provider");
    vi.mocked(resolveProviderForTest).mockRejectedValueOnce(
      new AITestConfigError(422, "Anthropic API key not configured"),
    );
    const response = await POST(
      jsonRequest({ provider: "ANTHROPIC" }) as never,
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error).toBe("Anthropic API key not configured");
  });
});
