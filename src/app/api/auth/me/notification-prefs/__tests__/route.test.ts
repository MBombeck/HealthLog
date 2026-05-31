import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  toJson: <T,>(v: T) => v,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: () => ({}),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function mkPatch(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/notification-prefs", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me/notification-prefs", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/notification-prefs"),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns the documented defaults for a fresh user (null row)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: null,
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/notification-prefs"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { medication: { clientManaged: boolean } };
    };
    expect(env.data).toEqual({
      medication: { clientManaged: false, deliveryDefault: "server" },
      mood: { reminderHour: 22 },
    });
  });

  it("returns the resolved prefs when the row holds a value", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { clientManaged: true } },
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/notification-prefs"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { medication: { clientManaged: boolean } };
    };
    expect(env.data).toEqual({
      medication: { clientManaged: true, deliveryDefault: "server" },
      mood: { reminderHour: 22 },
    });
  });

  it("returns defaults when the persisted shape has drifted", async () => {
    // Forward-compat: an admin hand-edit / future-rename should not
    // crash the GET.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { unknownCategory: { foo: "bar" } },
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/notification-prefs"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { medication: { clientManaged: boolean } };
    };
    expect(env.data).toEqual({
      medication: { clientManaged: false, deliveryDefault: "server" },
      mood: { reminderHour: 22 },
    });
  });
});

describe("PATCH /api/auth/me/notification-prefs", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ medication: { clientManaged: true } }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("flips medication.clientManaged on and writes the audit row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ medication: { clientManaged: true } }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { medication: { clientManaged: boolean } };
    };
    expect(env.data).toEqual({
      medication: { clientManaged: true, deliveryDefault: "server" },
      mood: { reminderHour: 22 },
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        notificationPrefs: {
          medication: { clientManaged: true, deliveryDefault: "server" },
          mood: { reminderHour: 22 },
        },
      },
    });

    expect(auditLog).toHaveBeenCalledWith(
      "user.notification-prefs.update",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          previous: {
            medication: { clientManaged: false, deliveryDefault: "server" },
            mood: { reminderHour: 22 },
          },
          next: {
            medication: { clientManaged: true, deliveryDefault: "server" },
            mood: { reminderHour: 22 },
          },
          changed: ["medication"],
        }),
      }),
    );
  });

  it("rejects malformed JSON with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const req = new Request(
      "http://localhost/api/auth/me/notification-prefs",
      {
        method: "PATCH",
        body: "{ not valid json",
        headers: { "Content-Type": "application/json" },
      },
    );

    const res = await (PATCH as (r: Request) => Promise<Response>)(req);
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean clientManaged with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ medication: { clientManaged: "yes" } }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("deep-merges over existing siblings without overwriting them", async () => {
    // Forward-compat: a row that already carries an unknown sibling
    // category (e.g. a future "mood" key persisted by a newer client)
    // must survive a PATCH that only touches `medication`. The route
    // parses with the current zod schema first, then deep-merges the
    // input over the parsed (defaulted) base. Today, "unknown sibling"
    // resolves back to defaults; the test pins that the medication
    // PATCH still lands and that future schema growth (adding new
    // siblings to the zod shape) will preserve them.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { clientManaged: false } },
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ medication: { clientManaged: true } }),
    );
    expect(res.status).toBe(200);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        notificationPrefs: {
          medication: { clientManaged: true, deliveryDefault: "server" },
          mood: { reminderHour: 22 },
        },
      },
    });
  });

  it("returns the merged shape unchanged on an empty PATCH body", async () => {
    // Idempotent — an empty body keeps the row as-is and still writes
    // the audit trail (mirrors the disable-coach posture).
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { clientManaged: true } },
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({}),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { medication: { clientManaged: boolean } };
    };
    expect(env.data).toEqual({
      medication: { clientManaged: true, deliveryDefault: "server" },
      mood: { reminderHour: 22 },
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        notificationPrefs: {
          medication: { clientManaged: true, deliveryDefault: "server" },
          mood: { reminderHour: 22 },
        },
      },
    });
  });

  it("v1.7.0 — persists a custom mood.reminderHour", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ mood: { reminderHour: 9 } }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { mood: { reminderHour: number } };
    };
    expect(env.data.mood).toEqual({ reminderHour: 9 });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        notificationPrefs: {
          medication: { clientManaged: false, deliveryDefault: "server" },
          mood: { reminderHour: 9 },
        },
      },
    });
  });

  it("v1.7.0 — rejects a mood.reminderHour outside 0..23 with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ mood: { reminderHour: 24 } }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-user rate-limit fires", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    });

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ medication: { clientManaged: true } }),
    );
    expect(res.status).toBe(429);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
