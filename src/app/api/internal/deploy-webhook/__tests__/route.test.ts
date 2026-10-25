import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// --- Module-boundary mocks must come before importing the route. ---

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
}));

// v1.4.27 — the deploy-webhook route now wraps every admin alert
// in `dispatchLocalisedNotification`, which delegates to the base
// dispatcher. Mock the localised helper so the route-level tests stay
// hermetic and we can assert recipient-specific calls directly.
vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn().mockResolvedValue(undefined),
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

import { POST, GET } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import { checkRateLimit } from "@/lib/rate-limit";
import { getEvent } from "@/lib/logging/context";

const ORIGINAL_SECRET = process.env.DEPLOY_WEBHOOK_SECRET;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DEPLOY_WEBHOOK_SECRET = "test-secret";
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(getEvent).mockReturnValue({
    setAuth: vi.fn(),
    addWarning: vi.fn(),
  } as never);
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.DEPLOY_WEBHOOK_SECRET;
  else process.env.DEPLOY_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/internal/deploy-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/deploy-webhook", () => {
  it("returns 401 with no secret header", async () => {
    const res = await POST(jsonRequest({ status: "success" }));
    expect(res.status).toBe(401);
    expect(auditLog).not.toHaveBeenCalled();
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("returns 401 with a wrong secret", async () => {
    const res = await POST(
      jsonRequest(
        { status: "success" },
        { "x-deploy-webhook-secret": "WRONG" },
      ),
    );
    expect(res.status).toBe(401);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("returns 401 when DEPLOY_WEBHOOK_SECRET env var is unset, regardless of header", async () => {
    delete process.env.DEPLOY_WEBHOOK_SECRET;
    const addWarning = vi.fn();
    vi.mocked(getEvent).mockReturnValue({
      setAuth: vi.fn(),
      addWarning,
    } as never);

    const res = await POST(
      jsonRequest(
        { status: "success" },
        { "x-deploy-webhook-secret": "anything" },
      ),
    );
    expect(res.status).toBe(401);
    expect(addWarning).toHaveBeenCalledWith(
      "DEPLOY_WEBHOOK_SECRET not configured",
    );
  });

  it("happy path: success payload writes system.deploy.success audit row, no admin alert", async () => {
    const res = await POST(
      jsonRequest(
        {
          status: "success",
          application_name: "HealthLog",
          application_uuid: "pg8wggwogo8c4gc4ks0kk4ss",
          deployment_uuid: "dep-123",
        },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; outcome: string };
    expect(body).toEqual({ status: "ok", outcome: "success" });

    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      "system.deploy.success",
      expect.objectContaining({
        details: expect.objectContaining({
          applicationName: "HealthLog",
          applicationUuid: "pg8wggwogo8c4gc4ks0kk4ss",
          deploymentUuid: "dep-123",
          error: null,
          raw: expect.objectContaining({ status: "success" }),
        }),
      }),
    );
    expect(dispatchLocalisedNotification).not.toHaveBeenCalled();
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("failure payload writes system.deploy.failure audit row AND fans a localised SYSTEM_ALERT to every admin", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: "admin-1" },
      { id: "admin-2" },
    ] as never);

    const res = await POST(
      jsonRequest(
        {
          status: "failed",
          application_name: "HealthLog",
          application_uuid: "pg8wggwogo8c4gc4ks0kk4ss",
          deployment_uuid: "dep-456",
          error: "container exited 137",
        },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe("failure");

    expect(auditLog).toHaveBeenCalledWith(
      "system.deploy.failure",
      expect.objectContaining({
        details: expect.objectContaining({
          error: "container exited 137",
        }),
      }),
    );

    // v1.4.27 — the route now wraps every admin alert in
    // `dispatchLocalisedNotification`, which composes the title and
    // body from translation keys against the admin's locale before
    // delegating to the base dispatcher. The test asserts the per-admin
    // call carries the right translation keys and params; the actual
    // string composition is covered in admin-locale.test.ts.
    expect(dispatchLocalisedNotification).toHaveBeenCalledTimes(2);
    expect(dispatchLocalisedNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        titleKey: "notifications.admin.deployFailedTitle",
        messageKey: "notifications.admin.deployFailedBody",
        params: expect.objectContaining({
          application: "HealthLog",
          error: "container exited 137",
          deployment: "dep-456",
        }),
        metadata: expect.objectContaining({
          source: "deploy-webhook",
          deploymentUuid: "dep-456",
        }),
      }),
    );
    expect(dispatchLocalisedNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "admin-2" }),
    );
  });

  it("treats unknown statuses (e.g. 'queued') as system.deploy.unknown without alerting", async () => {
    const res = await POST(
      jsonRequest(
        { status: "queued", application_name: "HealthLog" },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe("unknown");
    expect(auditLog).toHaveBeenCalledWith(
      "system.deploy.unknown",
      expect.any(Object),
    );
    expect(dispatchLocalisedNotification).not.toHaveBeenCalled();
  });

  it("emits a Wide Event warning when a deploy fails but no admin user exists", async () => {
    const addWarning = vi.fn();
    vi.mocked(getEvent).mockReturnValue({
      setAuth: vi.fn(),
      addWarning,
    } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([] as never);

    await POST(
      jsonRequest(
        { status: "failed", application_name: "HealthLog" },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );

    expect(addWarning).toHaveBeenCalledWith(
      expect.stringMatching(/no admin user/i),
    );
    expect(dispatchLocalisedNotification).not.toHaveBeenCalled();
  });

  it("returns 429 and skips audit + alert when rate-limited", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);

    const res = await POST(
      jsonRequest(
        { status: "success" },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(429);
    expect(auditLog).not.toHaveBeenCalled();
    expect(dispatchLocalisedNotification).not.toHaveBeenCalled();
  });

  it("tolerates malformed (non-string) status fields by treating them as unknown", async () => {
    const res = await POST(
      jsonRequest({ status: 42 }, { "x-deploy-webhook-secret": "test-secret" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe("unknown");
    expect(dispatchLocalisedNotification).not.toHaveBeenCalled();
  });

  it("preserves the full Coolify payload in the audit-log raw field for forward compat", async () => {
    const fullPayload = {
      status: "success",
      application_name: "HealthLog",
      application_uuid: "pg8wggwogo8c4gc4ks0kk4ss",
      deployment_uuid: "dep-789",
      future_field: { commit_sha: "abc123", environment: "production" },
    };

    await POST(
      jsonRequest(fullPayload, { "x-deploy-webhook-secret": "test-secret" }),
    );

    expect(auditLog).toHaveBeenCalledWith(
      "system.deploy.success",
      expect.objectContaining({
        details: expect.objectContaining({
          raw: expect.objectContaining({
            future_field: { commit_sha: "abc123", environment: "production" },
          }),
        }),
      }),
    );
  });
});

describe("GET /api/internal/deploy-webhook (reachability check)", () => {
  it("returns 200 with valid secret header", async () => {
    const req = new NextRequest(
      "http://localhost/api/internal/deploy-webhook",
      {
        method: "GET",
        headers: { "x-deploy-webhook-secret": "test-secret" },
      },
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it("returns 401 without a secret", async () => {
    const req = new NextRequest(
      "http://localhost/api/internal/deploy-webhook",
      {
        method: "GET",
      },
    );
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  // The reachability GET compares the same shared secret the POST does and
  // answers 200 against 401. Unlimited, that is a free oracle for guessing it.
  // A VALID secret over the limit must still be refused — that proves the
  // limiter runs before the comparison, not merely beside it.
  it("returns 429 for a valid secret when over the limit, on the POST bucket", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);

    const res = await GET(
      new NextRequest("http://localhost/api/internal/deploy-webhook", {
        method: "GET",
        headers: { "x-deploy-webhook-secret": "test-secret" },
      }),
    );

    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(checkRateLimit).mock.calls[0][0])).toMatch(
      /^deploy-webhook:/,
    );
  });
});

describe("POST /api/internal/deploy-webhook (timestamp replay protection)", () => {
  const ORIGINAL_REQUIRE = process.env.DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP;

  afterEach(() => {
    if (ORIGINAL_REQUIRE === undefined) {
      delete process.env.DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP;
    } else {
      process.env.DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP = ORIGINAL_REQUIRE;
    }
  });

  function timestamped(ts: string): NextRequest {
    return jsonRequest(
      { status: "success" },
      {
        "x-deploy-webhook-secret": "test-secret",
        "x-deploy-webhook-timestamp": ts,
      },
    );
  }

  it("accepts a fresh unix-seconds timestamp", async () => {
    const res = await POST(timestamped(String(Math.floor(Date.now() / 1000))));
    expect(res.status).toBe(200);
  });

  it("accepts a fresh ISO-8601 timestamp", async () => {
    const res = await POST(timestamped(new Date().toISOString()));
    expect(res.status).toBe(200);
  });

  it("rejects a timestamp older than the 5-minute window", async () => {
    const stale = Math.floor((Date.now() - 6 * 60 * 1000) / 1000);
    const res = await POST(timestamped(String(stale)));
    expect(res.status).toBe(401);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("rejects a timestamp too far in the future (clock-skew bound)", async () => {
    const future = Math.floor((Date.now() + 6 * 60 * 1000) / 1000);
    const res = await POST(timestamped(String(future)));
    expect(res.status).toBe(401);
  });

  it("rejects an unparseable timestamp value", async () => {
    const res = await POST(timestamped("not-a-timestamp"));
    expect(res.status).toBe(401);
  });

  it("accepts a request without the header in tolerant default mode", async () => {
    delete process.env.DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP;
    const res = await POST(
      jsonRequest(
        { status: "success" },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a request without the header when DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP=true", async () => {
    process.env.DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP = "true";
    const res = await POST(
      jsonRequest(
        { status: "success" },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(401);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("still rejects a stale timestamp before any audit-log write", async () => {
    const stale = Math.floor((Date.now() - 10 * 60 * 1000) / 1000);
    const res = await POST(timestamped(String(stale)));
    expect(res.status).toBe(401);
    expect(auditLog).not.toHaveBeenCalled();
    expect(dispatchLocalisedNotification).not.toHaveBeenCalled();
  });
});

/**
 * The secret header cannot stop a replay: a captured request carries the
 * secret, and the timestamp beside it was covered by nothing. A signed
 * request carries no secret and binds its timestamp to its body.
 */
describe("POST /api/internal/deploy-webhook (signed requests)", () => {
  const ORIGINAL_REQUIRE = process.env.DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP;
  afterEach(() => {
    if (ORIGINAL_REQUIRE === undefined) {
      delete process.env.DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP;
    } else {
      process.env.DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP = ORIGINAL_REQUIRE;
    }
  });

  async function signed(
    body: string,
    opts: { ts?: string; sign?: string; secret?: string } = {},
  ): Promise<NextRequest> {
    const { createHmac } = await import("node:crypto");
    const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
    const mac = createHmac("sha256", opts.secret ?? "test-secret")
      .update(`${ts}.${opts.sign ?? body}`)
      .digest("hex");
    return new NextRequest("https://app.example/api/internal/deploy-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-deploy-webhook-timestamp": ts,
        "x-deploy-webhook-signature": `sha256=${mac}`,
      },
      body,
    });
  }

  it("accepts a signed request without the secret header", async () => {
    const res = await POST(await signed('{"status":"success"}'));
    expect(res.status).toBe(200);
    expect(auditLog).toHaveBeenCalledOnce();
  });

  it("refuses a signature over another body, an old timestamp, or another key", async () => {
    for (const req of [
      await signed('{"status":"failed"}', { sign: '{"status":"success"}' }),
      await signed('{"status":"success"}', {
        ts: String(Math.floor(Date.now() / 1000) - 600),
      }),
      await signed('{"status":"success"}', { secret: "other-secret" }),
    ]) {
      expect((await POST(req)).status).toBe(401);
    }
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("in strict mode accepts only a signed request, not the bare secret with a fresh timestamp", async () => {
    process.env.DEPLOY_WEBHOOK_REQUIRE_TIMESTAMP = "true";
    const unsigned = jsonRequest(
      { status: "success" },
      {
        "x-deploy-webhook-secret": "test-secret",
        "x-deploy-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      },
    );
    expect((await POST(unsigned)).status).toBe(401);
    expect((await POST(await signed('{"status":"success"}'))).status).toBe(200);
  });
});
