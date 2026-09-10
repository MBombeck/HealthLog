import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { SafeFetchError } from "@/lib/safe-fetch";
import { NightscoutApiError } from "@/lib/nightscout/client";

const { fetchSgvEntriesMock, rateLimitMock, bossSend, bossMock } = vi.hoisted(
  () => ({
    fetchSgvEntriesMock: vi.fn(),
    rateLimitMock: vi.fn(),
    bossSend: vi.fn(),
    bossMock: vi.fn(),
  }),
);

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { update: vi.fn() } },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({ addWarning: vi.fn() }),
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc:${s}` }));
vi.mock("@/lib/integrations/status", () => ({ markReconnected: vi.fn() }));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: bossMock }));
vi.mock("@/lib/nightscout/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/nightscout/client")>();
  return { ...actual, fetchSgvEntries: fetchSgvEntriesMock };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: rateLimitMock,
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/api-response", () => ({
  // The parse-refusal pair the routes now answer with: the same envelope
  // plus the per-field issue list.
  sanitiseZodIssues: (
    issues: { path: (string | number)[]; code: string; message: string }[],
  ) =>
    issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    })),
  apiValidationError: (
    error: string,
    issues: unknown[],
    status: number,
    options?: { errorCode?: string },
  ) => ({
    data: null,
    error,
    status,
    details: { issues },
    meta: options?.errorCode ? { errorCode: options.errorCode } : undefined,
  }),
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  apiError: (
    error: string,
    status: number,
    options?: { errorCode?: string },
  ) => ({
    data: null,
    error,
    status,
    meta: options?.errorCode ? { errorCode: options.errorCode } : undefined,
  }),
  safeJson: async (req: NextRequest) => {
    try {
      return { data: await req.json(), error: null };
    } catch {
      return { data: null, error: { status: 400 } };
    }
  },
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { markReconnected } from "@/lib/integrations/status";

const userUpdate = prisma.user.update as ReturnType<typeof vi.fn>;

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/nightscout/connect", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

type RouteResult = {
  data: unknown;
  error: string | null;
  status: number;
  meta?: { errorCode?: string };
};
const post = POST as unknown as (r: NextRequest) => Promise<RouteResult>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NIGHTSCOUT_PRIVATE_ORIGINS;
  rateLimitMock.mockResolvedValue({ allowed: true, remaining: 9, resetAt: 0 });
  fetchSgvEntriesMock.mockResolvedValue([{ id: "x", sgv: 100, date: 1 }]);
  bossSend.mockResolvedValue("job-1");
  bossMock.mockReturnValue({ send: bossSend });
});

describe("POST /api/nightscout/connect", () => {
  it("422s on a missing / malformed URL", async () => {
    const res = await post(req({ url: "not a url" }));
    expect(res.status).toBe(422);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("validates via a test fetch and stores encrypted creds on success", async () => {
    const res = await post(
      req({ url: "https://ns.example.com", token: "tok" }),
    );
    expect(res.status).toBe(200);
    expect(fetchSgvEntriesMock).toHaveBeenCalledTimes(1);
    const fetchArg = fetchSgvEntriesMock.mock.calls[0]![0];
    expect(fetchArg.count).toBe(1);
    expect(fetchArg.allowPrivateHost).toBe(false);

    const data = userUpdate.mock.calls[0]![0].data;
    expect(data.nightscoutUrlEncrypted).toBe("enc:https://ns.example.com");
    expect(data.nightscoutTokenEncrypted).toBe("enc:tok");
    expect(data.nightscoutAllowPrivateHost).toBe(false);
    expect(markReconnected).toHaveBeenCalledWith("u1", "nightscout");
  });

  it("stores a null token for a public, token-less instance", async () => {
    await post(req({ url: "https://ns.example.com" }));
    const data = userUpdate.mock.calls[0]![0].data;
    expect(data.nightscoutTokenEncrypted).toBeNull();
  });

  it("rejects an ordinary user's private-host boolean before the probe", async () => {
    const res = await post(
      req({
        url: "http://192.168.1.5:1337",
        token: "tok",
        allowPrivateHost: true,
      }),
    );

    expect(res.status).toBe(422);
    expect(res.meta?.errorCode).toBe("private_origin_not_approved");
    expect(fetchSgvEntriesMock).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("connects an exact operator-approved private origin without a user bypass", async () => {
    process.env.NIGHTSCOUT_PRIVATE_ORIGINS = "http://192.168.1.5:1337";

    const res = await post(
      req({
        url: "http://192.168.1.5:1337",
        token: "tok",
      }),
    );

    expect(res.status).toBe(200);
    expect(fetchSgvEntriesMock).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledTimes(1);
  });

  it("rejects an approved private host on a different port", async () => {
    process.env.NIGHTSCOUT_PRIVATE_ORIGINS = "http://192.168.1.5:1337";

    const res = await post(
      req({
        url: "http://192.168.1.5:8080",
        token: "tok",
        allowPrivateHost: true,
      }),
    );

    expect(res.status).toBe(422);
    expect(res.meta?.errorCode).toBe("private_origin_not_approved");
    expect(fetchSgvEntriesMock).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a private host when the opt-in is off (clear 422, no store)", async () => {
    fetchSgvEntriesMock.mockRejectedValue(
      new SafeFetchError("refused", "private_host"),
    );
    const res = await post(req({ url: "http://10.0.0.5", token: "tok" }));
    expect(res.status).toBe(422);
    expect(String(res.error)).toMatch(/private network/i);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("surfaces a wrong-token rejection as a clear 422", async () => {
    fetchSgvEntriesMock.mockRejectedValue(
      new NightscoutApiError("responded 401", 401),
    );
    const res = await post(req({ url: "https://ns.example.com", token: "x" }));
    expect(res.status).toBe(422);
    expect(String(res.error)).toMatch(/token/i);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("surfaces an unreachable instance as a clear 422", async () => {
    fetchSgvEntriesMock.mockRejectedValue(
      new SafeFetchError("timeout", "timeout"),
    );
    const res = await post(req({ url: "https://ns.example.com" }));
    expect(res.status).toBe(422);
    expect(String(res.error)).toMatch(/reach/i);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  // Input-time SSRF floor. Every case below leaves the default happy-path
  // `fetchSgvEntries` mock in place — it RESOLVES — so the only thing that
  // can produce a 422 is the check that runs before the probe. Asserting the
  // probe was never called is what separates this from the fetch-time guard:
  // a URL that never reaches the egress layer cannot have been refused by it.
  describe("refuses private / non-public hosts before the probe runs", () => {
    const cases: Array<[string, string]> = [
      ["loopback", "http://127.0.0.1:1337"],
      ["loopback by name", "http://localhost:1337"],
      ["link-local", "http://169.254.1.1"],
      ["cloud metadata endpoint", "http://169.254.169.254/latest/meta-data/"],
      ["RFC1918 class A", "http://10.0.0.5"],
      ["RFC1918 class C", "http://192.168.1.5"],
      ["CGNAT", "http://100.64.0.1"],
      ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]"],
      ["IPv6 loopback", "http://[::1]:1337"],
      ["IPv6 unique-local", "http://[fd00::1]"],
      ["octal IPv4 loopback", "http://0177.0.0.1"],
      ["hex IPv4 loopback", "http://0x7f000001"],
      ["decimal IPv4 loopback", "http://2130706433"],
      [".internal suffix", "http://cgm.internal"],
      [".local suffix", "http://cgm.local"],
    ];

    it.each(cases)("refuses %s", async (_label, url) => {
      const res = await post(req({ url, token: "tok" }));

      expect(res.status).toBe(422);
      expect(String(res.error)).toMatch(/private network/i);
      expect(fetchSgvEntriesMock).not.toHaveBeenCalled();
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it("lets an exact operator-approved self-hosted origin through to the probe", async () => {
      process.env.NIGHTSCOUT_PRIVATE_ORIGINS = "http://192.168.1.5:1337";

      const res = await post(
        req({
          url: "http://192.168.1.5:1337",
          token: "tok",
        }),
      );

      expect(res.status).toBe(200);
      expect(fetchSgvEntriesMock).toHaveBeenCalledTimes(1);
      expect(userUpdate).toHaveBeenCalledTimes(1);
    });

    it("lets an ordinary public instance through", async () => {
      const res = await post(req({ url: "https://ns.example.com" }));

      expect(res.status).toBe(200);
      expect(fetchSgvEntriesMock).toHaveBeenCalledTimes(1);
    });
  });

  it("rate-limits the connect surface", async () => {
    rateLimitMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: 0,
    });
    const res = await post(req({ url: "https://ns.example.com" }));
    expect(res.status).toBe(429);
    expect(fetchSgvEntriesMock).not.toHaveBeenCalled();
  });
});

/**
 * v1.32.28 — a Nightscout connection pulls its first glucose window straight
 * away instead of leaving the card empty until the next hourly tick.
 */
describe("POST /api/nightscout/connect — connect-time first sync", () => {
  it("enqueues exactly one targeted nightscout-sync job for the connecting user", async () => {
    const res = await post(
      req({ url: "https://ns.example.com", token: "tok" }),
    );

    expect(res.status).toBe(200);
    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend).toHaveBeenCalledWith("nightscout-sync", { userId: "u1" });
  });

  it("does not enqueue when the connection was rejected", async () => {
    const res = await post(req({ url: "not a url" }));

    expect(res.status).toBe(422);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("still connects when no boss instance is available", async () => {
    bossMock.mockReturnValue(null);

    const res = await post(
      req({ url: "https://ns.example.com", token: "tok" }),
    );

    expect(res.status).toBe(200);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("still connects when the enqueue itself rejects", async () => {
    bossSend.mockRejectedValue(new Error("queue unreachable"));

    const res = await post(
      req({ url: "https://ns.example.com", token: "tok" }),
    );

    expect(res.status).toBe(200);
  });
});
