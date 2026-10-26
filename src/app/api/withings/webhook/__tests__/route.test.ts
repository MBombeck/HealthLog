import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// --- Module-boundary mocks must come before importing the route. ---

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    withingsConnection: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/withings/sync", () => ({
  syncUserMeasurements: vi.fn(),
}));

// v1.4.25 — activity / sleep paths dispatch through pg-boss.
// Mock the boss-instance accessor to return a fake boss for the
// appli=16 / 44 tests and `null` otherwise.
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(),
}));

vi.mock("@/lib/withings/sync-activity", () => ({
  syncUserActivity: vi.fn(),
}));

vi.mock("@/lib/withings/sync-sleep", () => ({
  syncUserSleep: vi.fn(),
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
import { syncUserActivity } from "@/lib/withings/sync-activity";
import { syncUserSleep } from "@/lib/withings/sync-sleep";
import { checkRateLimit } from "@/lib/rate-limit";
import { getEvent } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";

const ORIGINAL_SECRET = process.env.WITHINGS_WEBHOOK_SECRET;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.withingsConnection.findMany).mockResolvedValue([]);
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
  vi.mocked(getGlobalBoss).mockReturnValue({
    send: vi.fn().mockResolvedValue("ecg-job"),
  } as never);
  vi.mocked(syncUserActivity).mockResolvedValue(0 as never);
  vi.mocked(syncUserSleep).mockResolvedValue(0 as never);
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
    expect(prisma.withingsConnection.findMany).not.toHaveBeenCalled();
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
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValueOnce([
      {
        userId: "user-42",
        withingsUserId: "wu-1",
      },
    ] as never);

    const res = await POST(
      jsonRequest(
        { userid: "wu-1" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");

    expect(prisma.withingsConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { withingsUserId: "wu-1", user: { deletionRequestedAt: null } },
      }),
    );
    expect(syncUserMeasurements).toHaveBeenCalledTimes(1);
    expect(syncUserMeasurements).toHaveBeenCalledWith("user-42");
  });

  it("an account two records hold routes to the record that linked it first, ordered by the query", async () => {
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValueOnce([
      { userId: "first-holder" },
      { userId: "second-holder" },
    ] as never);

    const res = await POST(
      jsonRequest(
        { userid: "wu-1" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(prisma.withingsConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
    expect(syncUserMeasurements).toHaveBeenCalledTimes(1);
    expect(syncUserMeasurements).toHaveBeenCalledWith("first-holder");
  });

  it("legacy ?secret=… query path still authorises and emits a Wide Event warning with the migration URL (Fix-K sec-M2)", async () => {
    const addWarning = vi.fn();
    vi.mocked(getEvent).mockReturnValue({
      setAuth: vi.fn(),
      addWarning,
    } as never);
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValueOnce([
      {
        userId: "user-99",
        withingsUserId: "wu-2",
      },
    ] as never);

    const res = await POST(
      jsonRequest({ userid: "wu-2" }, {}, "?secret=test-secret"),
    );
    expect(res.status).toBe(200);
    expect(syncUserMeasurements).toHaveBeenCalledWith("user-99");
    expect(addWarning).toHaveBeenCalledWith(
      expect.stringMatching(/legacy URL query/i),
    );
    // Fix-K sec-M2: warning text now spells out the migration URL so
    // anyone watching the access log knows what to re-subscribe to.
    expect(addWarning).toHaveBeenCalledWith(
      expect.stringContaining("/api/withings/webhook/[token]"),
    );
  });

  it("accepts form-encoded payloads (Withings legacy delivery format)", async () => {
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValueOnce([
      {
        userId: "user-form",
        withingsUserId: "wu-form",
      },
    ] as never);

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
    expect(prisma.withingsConnection.findMany).not.toHaveBeenCalled();
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });

  it("returns 200 unknown_user when no WithingsConnection matches the wire userid", async () => {
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValueOnce([]);
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
    expect(prisma.withingsConnection.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/withings/webhook — appli dispatch (W17b/c)", () => {
  it("appli=16 enqueues onto withings-activity-sync (not the measure path)", async () => {
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValueOnce([
      {
        userId: "user-act",
        withingsUserId: "wu-act",
      },
    ] as never);
    const send = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);

    const res = await POST(
      formRequest(
        { userid: "wu-act", appli: "16" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("withings-activity-sync");
    expect(send.mock.calls[0][1]).toMatchObject({ userId: "user-act" });
    // Critical: appli=16 must NOT trigger the measure path.
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });

  it("appli=44 enqueues onto withings-sleep-sync (not the measure path)", async () => {
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValueOnce([
      {
        userId: "user-sleep",
        withingsUserId: "wu-sleep",
      },
    ] as never);
    const send = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);

    const res = await POST(
      formRequest(
        { userid: "wu-sleep", appli: "44" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("withings-sleep-sync");
    expect(send.mock.calls[0][1]).toMatchObject({ userId: "user-sleep" });
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });

  it("appli=16 falls back to inline activity sync when pg-boss is unavailable", async () => {
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValueOnce([
      {
        userId: "user-act-inline",
        withingsUserId: "wu-act-inline",
      },
    ] as never);
    vi.mocked(getGlobalBoss).mockReturnValue(null);

    const res = await POST(
      formRequest(
        { userid: "wu-act-inline", appli: "16" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(syncUserActivity).toHaveBeenCalledWith("user-act-inline");
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });

  it("appli=44 falls back to inline sleep sync when pg-boss is unavailable", async () => {
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValueOnce([
      {
        userId: "user-sleep-inline",
        withingsUserId: "wu-sleep-inline",
      },
    ] as never);
    vi.mocked(getGlobalBoss).mockReturnValue(null);

    const res = await POST(
      formRequest(
        { userid: "wu-sleep-inline", appli: "44" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(syncUserSleep).toHaveBeenCalledWith("user-sleep-inline");
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });

  it("appli=4 (BP) keeps the legacy measure path", async () => {
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValueOnce([
      {
        userId: "user-bp",
        withingsUserId: "wu-bp",
      },
    ] as never);

    const res = await POST(
      formRequest(
        { userid: "wu-bp", appli: "4" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(syncUserMeasurements).toHaveBeenCalledWith("user-bp");
    expect(syncUserActivity).not.toHaveBeenCalled();
    expect(syncUserSleep).not.toHaveBeenCalled();
  });

  it("a missing appli falls back to the measure path (legacy Withings subscriptions)", async () => {
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValueOnce([
      {
        userId: "user-legacy",
        withingsUserId: "wu-legacy",
      },
    ] as never);

    const res = await POST(
      formRequest(
        { userid: "wu-legacy" },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    expect(syncUserMeasurements).toHaveBeenCalledWith("user-legacy");
  });
  it("returns retryable non-2xx when the ECG event cannot be durably enqueued", async () => {
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValue([
      {
        userId: "user-ecg",
        withingsUserId: "wu-ecg",
      },
    ] as never);
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);

    const res = await POST(
      formRequest(
        {
          userid: "wu-ecg",
          appli: "1",
          startdate: "1715000000",
          enddate: "1715000060",
        },
        { "x-withings-webhook-secret": "test-secret" },
      ),
    );

    expect(res.status).toBe(503);
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });

  it("uses one logical ECG job identity for a provider replay", async () => {
    vi.mocked(prisma.withingsConnection.findMany).mockResolvedValue([
      {
        userId: "user-ecg",
        withingsUserId: "wu-ecg",
      },
    ] as never);
    const send = vi
      .fn()
      .mockResolvedValueOnce("job-1")
      .mockResolvedValueOnce(null);
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);
    const delivery = {
      userid: "wu-ecg",
      appli: "1",
      startdate: "1715000000",
      enddate: "1715000060",
    };

    const first = await POST(
      formRequest(delivery, {
        "x-withings-webhook-secret": "test-secret",
      }),
    );
    const replay = await POST(
      formRequest(delivery, {
        "x-withings-webhook-secret": "test-secret",
      }),
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBe("withings-ecg-sync");
    expect(send.mock.calls[1][0]).toBe("withings-ecg-sync");
    expect(send.mock.calls[0][1]).toMatchObject({
      userId: "user-ecg",
      startdate: 1715000000,
      enddate: 1715000060,
    });
    expect(send.mock.calls[0][2]).toMatchObject({
      singletonKey: expect.any(String),
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    });
    expect(send.mock.calls[0][2].singletonKey).toBe(
      send.mock.calls[1][2].singletonKey,
    );
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

describe("legacy verification verbs are rate-limited before the secret comparison", () => {
  // Same reasoning as the path-segment sibling: a verb that answers 200 for
  // the right secret and 401 for a wrong one is a guessing oracle unless the
  // limiter runs first. A VALID secret over the limit must still be refused.
  function overTheLimit(): void {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);
  }

  it("HEAD returns 429 for a valid secret when over the limit", async () => {
    overTheLimit();
    const res = await HEAD(
      new NextRequest("http://localhost/api/withings/webhook", {
        method: "HEAD",
        headers: { "x-withings-webhook-secret": "test-secret" },
      }),
    );
    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it("GET returns 429 for a valid secret when over the limit", async () => {
    overTheLimit();
    const res = await GET(
      new NextRequest("http://localhost/api/withings/webhook", {
        headers: { "x-withings-webhook-secret": "test-secret" },
      }),
    );
    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it("the legacy ?secret= form is limited on the same bucket as the POST", async () => {
    overTheLimit();
    const res = await GET(
      new NextRequest("http://localhost/api/withings/webhook?secret=WRONG"),
    );
    expect(res.status).toBe(429);

    const buckets = vi
      .mocked(checkRateLimit)
      .mock.calls.map((call) => String(call[0]));
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatch(/^withings-webhook:/);
  });
});
