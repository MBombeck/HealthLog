import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// --- Module-boundary mocks must come before importing the route. ---

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    withingsConnection: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/withings/sync", () => ({
  syncUserMeasurements: vi.fn(),
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

import { POST, GET, HEAD } from "../route";
import { prisma } from "@/lib/db";
import { syncUserMeasurements } from "@/lib/withings/sync";
import { checkRateLimit } from "@/lib/rate-limit";
import { getEvent } from "@/lib/logging/context";

const ORIGINAL_SECRET = process.env.WITHINGS_WEBHOOK_SECRET;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.WITHINGS_WEBHOOK_SECRET = "test-secret";
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 30,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(getEvent).mockReturnValue({
    setAuth: vi.fn(),
    addWarning: vi.fn(),
  } as never);
  vi.mocked(syncUserMeasurements).mockResolvedValue(undefined as never);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.WITHINGS_WEBHOOK_SECRET;
  else process.env.WITHINGS_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
  search = "",
): NextRequest {
  return new NextRequest(`http://localhost/api/withings/webhook${search}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function formRequest(
  formBody: Record<string, string>,
  headers: Record<string, string> = {},
): NextRequest {
  const usp = new URLSearchParams(formBody);
  return new NextRequest("http://localhost/api/withings/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: usp.toString(),
  });
}

describe("POST /api/withings/webhook", () => {
  it("returns 401 with no secret header and no query secret", async () => {
    const res = await POST(jsonRequest({ userid: "wu-1" }));
    expect(res.status).toBe(401);
    expect(syncUserMeasurements).not.toHaveBeenCalled();
    expect(prisma.withingsConnection.findFirst).not.toHaveBeenCalled();
  });

  it("returns 401 when the X-Withings-Webhook-Secret header is wrong", async () => {
    const res = await POST(
      jsonRequest({ userid: "wu-1" }, { "x-withings-webhook-secret": "WRONG" }),
    );
    expect(res.status).toBe(401);
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });

  it("returns 401 when WITHINGS_WEBHOOK_SECRET env var is unset, regardless of incoming header", async () => {
    delete process.env.WITHINGS_WEBHOOK_SECRET;
    const addWarning = vi.fn();
    vi.mocked(getEvent).mockReturnValue({
      setAuth: vi.fn(),
      addWarning,
    } as never);

    const res = await POST(
      jsonRequest(
        { userid: "wu-1" },
        { "x-withings-webhook-secret": "anything" },
      ),
    );
    expect(res.status).toBe(401);
    expect(addWarning).toHaveBeenCalledWith(
      "WITHINGS_WEBHOOK_SECRET not configured",
    );
  });

  it("happy path: valid header secret + JSON body triggers sync for the resolved user", async () => {
    vi.mocked(prisma.withingsConnection.findFirst).mockResolvedValueOnce({
      userId: "user-42",
      withingsUserId: "wu-1",
    } as never);

    const res = await POST(
      jsonRequest(
        { userid: "wu-1" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");

    expect(prisma.withingsConnection.findFirst).toHaveBeenCalledWith({
      where: { withingsUserId: "wu-1" },
    });
    expect(syncUserMeasurements).toHaveBeenCalledTimes(1);
    expect(syncUserMeasurements).toHaveBeenCalledWith("user-42");
  });

  it("legacy ?secret=… query path still authorises and emits a Wide Event warning", async () => {
    const addWarning = vi.fn();
    vi.mocked(getEvent).mockReturnValue({
      setAuth: vi.fn(),
      addWarning,
    } as never);
    vi.mocked(prisma.withingsConnection.findFirst).mockResolvedValueOnce({
      userId: "user-99",
      withingsUserId: "wu-2",
    } as never);

    const res = await POST(
      jsonRequest({ userid: "wu-2" }, {}, "?secret=test-secret"),
    );
    expect(res.status).toBe(200);
    expect(syncUserMeasurements).toHaveBeenCalledWith("user-99");
    expect(addWarning).toHaveBeenCalledWith(
      expect.stringMatching(/legacy URL query/i),
    );
  });

  it("accepts form-encoded payloads (Withings legacy delivery format)", async () => {
    vi.mocked(prisma.withingsConnection.findFirst).mockResolvedValueOnce({
      userId: "user-form",
      withingsUserId: "wu-form",
    } as never);

    const res = await POST(
      formRequest(
        { userid: "wu-form", appli: "1" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(syncUserMeasurements).toHaveBeenCalledWith("user-form");
  });

  it("returns 200 ignored when the body has no userid", async () => {
    const res = await POST(
      jsonRequest({}, { "x-withings-webhook-secret": "test-secret" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ignored");
    expect(prisma.withingsConnection.findFirst).not.toHaveBeenCalled();
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });

  it("returns 200 unknown_user when no WithingsConnection matches the wire userid", async () => {
    vi.mocked(prisma.withingsConnection.findFirst).mockResolvedValueOnce(null);
    const res = await POST(
      jsonRequest(
        { userid: "wu-ghost" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("unknown_user");
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });

  it("returns 429 and skips sync when rate-limited", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);
    const res = await POST(
      jsonRequest(
        { userid: "wu-1" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(429);
    expect(syncUserMeasurements).not.toHaveBeenCalled();
    expect(prisma.withingsConnection.findFirst).not.toHaveBeenCalled();
  });
});

describe("HEAD /api/withings/webhook (Withings URL verification)", () => {
  it("returns 200 with a valid header secret", async () => {
    const req = new NextRequest("http://localhost/api/withings/webhook", {
      method: "HEAD",
      headers: { "x-withings-webhook-secret": "test-secret" },
    });
    const res = await HEAD(req);
    expect(res.status).toBe(200);
  });

  it("returns 401 with no secret", async () => {
    const req = new NextRequest("http://localhost/api/withings/webhook", {
      method: "HEAD",
    });
    const res = await HEAD(req);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/withings/webhook", () => {
  it("returns 200 with a valid header secret and 401 without", async () => {
    const ok = await GET(
      new NextRequest("http://localhost/api/withings/webhook", {
        headers: { "x-withings-webhook-secret": "test-secret" },
      }),
    );
    expect(ok.status).toBe(200);

    const fail = await GET(
      new NextRequest("http://localhost/api/withings/webhook"),
    );
    expect(fail.status).toBe(401);
  });
});
