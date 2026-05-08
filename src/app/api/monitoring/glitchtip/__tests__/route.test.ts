import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ prisma: {} }));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(h: T): T =>
    h,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/monitoring-settings", () => ({
  getGlitchtipSettings: vi.fn(),
}));

vi.mock("@/lib/monitoring/glitchtip", () => ({
  sendGlitchtipEvent: vi.fn(),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => ({ addWarning: vi.fn() })),
}));

import { POST } from "../route";
import { checkRateLimit } from "@/lib/rate-limit";
import { getGlitchtipSettings } from "@/lib/monitoring-settings";
import { sendGlitchtipEvent } from "@/lib/monitoring/glitchtip";

function jsonReq(body: unknown, contentType = "application/json"): NextRequest {
  return new NextRequest("http://localhost/api/monitoring/glitchtip", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 19,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(getGlitchtipSettings).mockResolvedValue({
    glitchtipEnabled: true,
    glitchtipDsn: "https://pub@glitchtip.example.com/1",
    glitchtipEnvironment: "production",
  });
  vi.mocked(sendGlitchtipEvent).mockResolvedValue({
    ok: true,
    method: "envelope",
    status: 200,
  });
});

describe("POST /api/monitoring/glitchtip", () => {
  it("returns 429 when rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);
    const res = await POST(jsonReq({ message: "x" }));
    expect(res.status).toBe(429);
    expect(sendGlitchtipEvent).not.toHaveBeenCalled();
  });

  it("short-circuits with skipped:true when GlitchTip is disabled", async () => {
    vi.mocked(getGlitchtipSettings).mockResolvedValue({
      glitchtipEnabled: false,
      glitchtipDsn: null,
      glitchtipEnvironment: null,
    });
    const res = await POST(jsonReq({ message: "boom" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { skipped: boolean } };
    expect(body.data.skipped).toBe(true);
    expect(sendGlitchtipEvent).not.toHaveBeenCalled();
  });

  it("short-circuits when DSN is empty even if globally enabled", async () => {
    vi.mocked(getGlitchtipSettings).mockResolvedValue({
      glitchtipEnabled: true,
      glitchtipDsn: null,
      glitchtipEnvironment: null,
    });
    const res = await POST(jsonReq({ message: "boom" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { skipped: boolean } };
    expect(body.data.skipped).toBe(true);
  });

  it("returns 422 when JSON parse fails", async () => {
    const res = await POST(jsonReq("{not-json", "application/json"));
    expect(res.status).toBe(422);
    expect(sendGlitchtipEvent).not.toHaveBeenCalled();
  });

  it("returns 422 when payload fails schema (missing message)", async () => {
    const res = await POST(jsonReq({ stack: "boom" }));
    expect(res.status).toBe(422);
  });

  it("returns 422 when message exceeds size cap (2000 chars)", async () => {
    // The Zod schema caps `message` at 2000 chars — bigger payloads must
    // be rejected before they ever leave the box.
    const huge = "x".repeat(2001);
    const res = await POST(jsonReq({ message: huge }));
    expect(res.status).toBe(422);
    expect(sendGlitchtipEvent).not.toHaveBeenCalled();
  });

  it("returns 422 when stack exceeds 20 000 chars", async () => {
    const res = await POST(
      jsonReq({ message: "boom", stack: "x".repeat(20001) }),
    );
    expect(res.status).toBe(422);
  });

  it("forwards a well-formed event with default level=error to the configured DSN", async () => {
    const res = await POST(
      jsonReq({
        message: "Boom!",
        stack: "Error: Boom!\n    at foo",
        type: "ReferenceError",
        url: "https://app.example.com/page",
        userAgent: "Mozilla/5.0",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { sent: boolean } };
    expect(body.data.sent).toBe(true);

    expect(sendGlitchtipEvent).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sendGlitchtipEvent).mock.calls[0]?.[0];
    expect(args?.dsn).toBe("https://pub@glitchtip.example.com/1");
    expect(args?.input).toMatchObject({
      environment: "production",
      message: "Boom!",
      level: "error",
      type: "ReferenceError",
      sourceTag: "healthlog-client",
    });
  });

  it("falls back to the literal 'production' env when settings.glitchtipEnvironment is null", async () => {
    vi.mocked(getGlitchtipSettings).mockResolvedValue({
      glitchtipEnabled: true,
      glitchtipDsn: "https://pub@glitchtip.example.com/1",
      glitchtipEnvironment: null,
    });
    await POST(jsonReq({ message: "boom" }));
    const args = vi.mocked(sendGlitchtipEvent).mock.calls[0]?.[0];
    expect(args?.input.environment).toBe("production");
  });

  it("returns 502 when the upstream delivery fails", async () => {
    vi.mocked(sendGlitchtipEvent).mockResolvedValue({
      ok: false,
      method: "envelope",
      status: 500,
      details: "internal",
    });
    const res = await POST(jsonReq({ message: "boom" }));
    expect(res.status).toBe(502);
  });

  it("rate-limits per IP — uses x-forwarded-for as the bucket key", async () => {
    const r = new NextRequest("http://localhost/api/monitoring/glitchtip", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.42",
      },
      body: JSON.stringify({ message: "boom" }),
    });
    await POST(r);
    const callArgs = vi.mocked(checkRateLimit).mock.calls[0];
    // First arg is the bucket key — must include the resolved client IP.
    expect(callArgs?.[0]).toContain("10.0.0.42");
    // 20 requests / 60 000 ms — guard the documented sliding window.
    expect(callArgs?.[1]).toBe(20);
    expect(callArgs?.[2]).toBe(60_000);
  });
});
