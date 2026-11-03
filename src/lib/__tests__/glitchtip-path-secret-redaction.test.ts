/**
 * The GlitchTip forwarder must redact path-segment secrets in `url`.
 *
 * `reportToGlitchtip` strips the query string, which covers `?secret=…` and
 * `?code=…&state=…`. It does NOT cover a secret carried as a path SEGMENT —
 * `/api/withings/webhook/<secret>`, `/api/whoop/webhook/<secret>` — and those
 * are exactly the shapes `PATH_SECRET_PATHS` exists for. Every other sink (the
 * stdout wide event, the admin app-logs render) already redacts them; GlitchTip
 * was the one gap, and it is the worst one, because the value lands durably in
 * an external incident UI.
 *
 * The fix is in place. This pins it: the assertion is on the wiring, not on
 * `redactSecrets` itself, because the defect was a missing call, not a broken
 * redactor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/monitoring-settings", () => ({
  getGlitchtipSettings: vi.fn(async () => ({
    glitchtipEnabled: true,
    glitchtipDsn: "https://key@glitchtip.example/1",
    glitchtipEnvironment: "test",
  })),
}));

const sendGlitchtipEvent = vi.fn<(payload: unknown) => Promise<void>>(
  async () => {},
);
vi.mock("@/lib/monitoring/glitchtip", () => ({
  sendGlitchtipEvent: (payload: unknown) => sendGlitchtipEvent(payload),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { NextRequest } from "next/server";
import { apiHandler } from "../api-handler";

const WEBHOOK_SECRET = "s3cr3t-webhook-path-segment-value";

beforeEach(() => {
  sendGlitchtipEvent.mockClear();
});

function throwingHandler(): (request: NextRequest) => Promise<Response> {
  return apiHandler(async () => {
    throw new Error("boom");
  }) as unknown as (request: NextRequest) => Promise<Response>;
}

async function forwardedPayload(url: string) {
  const GET = throwingHandler();
  await GET(new NextRequest(url, { method: "GET" }));
  // The forwarder is fire-and-forget inside the handler's catch; let its
  // dynamic imports and the send settle before asserting.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sendGlitchtipEvent).toHaveBeenCalledTimes(1);
  const call = sendGlitchtipEvent.mock.calls[0]?.[0] as {
    input: { url: string };
  };
  return call.input;
}

describe("GlitchTip forwarder — path-segment secret redaction", () => {
  it("does not forward a Withings webhook path secret verbatim", async () => {
    const input = await forwardedPayload(
      `http://localhost/api/withings/webhook/${WEBHOOK_SECRET}`,
    );
    expect(input.url).not.toContain(WEBHOOK_SECRET);
  });

  it("does not forward a WHOOP webhook path secret verbatim", async () => {
    const input = await forwardedPayload(
      `http://localhost/api/whoop/webhook/${WEBHOOK_SECRET}`,
    );
    expect(input.url).not.toContain(WEBHOOK_SECRET);
  });

  it("does not forward a clinician share token verbatim", async () => {
    const shareToken = "hls_abcdef0123456789abcdef0123456789";
    const input = await forwardedPayload(`http://localhost/c/${shareToken}`);
    expect(input.url).not.toContain(shareToken);
  });

  it("still strips the query string", async () => {
    const input = await forwardedPayload(
      "http://localhost/api/auth/oidc/callback?code=abc123&state=xyz789",
    );
    expect(input.url).not.toContain("abc123");
    expect(input.url).not.toContain("xyz789");
  });

  it("leaves an ordinary path readable", async () => {
    const input = await forwardedPayload("http://localhost/api/measurements");
    expect(input.url).toContain("/api/measurements");
  });
});
