import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  toJson: <T>(v: T) => v,
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
    limit: 60,
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
  user: { id: "user-1", username: "testuser", role: "USER" as const },
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
      medication: {
        clientManaged: false,
        deliveryDefault: "server",
        lowStockRunwayDays: 7,
        reorderLeadDays: 10,
      },
      mood: { reminderHour: 22 },
      cycle: { clientManaged: false },
      coach: {
        nudgesEnabled: true,
        nudgeMedication: true,
        nudgeVitals: true,
        nudgeRoutine: true,
        nudgeFrequency: "weekly",
        ambientSuggestions: true,
        nudgeAiComposed: false,
      },
      measurementReminder: {
        clientManaged: false,
      },
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
      medication: {
        clientManaged: true,
        deliveryDefault: "server",
        lowStockRunwayDays: 7,
        reorderLeadDays: 10,
      },
      mood: { reminderHour: 22 },
      cycle: { clientManaged: false },
      coach: {
        nudgesEnabled: true,
        nudgeMedication: true,
        nudgeVitals: true,
        nudgeRoutine: true,
        nudgeFrequency: "weekly",
        ambientSuggestions: true,
        nudgeAiComposed: false,
      },
      measurementReminder: {
        clientManaged: false,
      },
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
      medication: {
        clientManaged: false,
        deliveryDefault: "server",
        lowStockRunwayDays: 7,
        reorderLeadDays: 10,
      },
      mood: { reminderHour: 22 },
      cycle: { clientManaged: false },
      coach: {
        nudgesEnabled: true,
        nudgeMedication: true,
        nudgeVitals: true,
        nudgeRoutine: true,
        nudgeFrequency: "weekly",
        ambientSuggestions: true,
        nudgeAiComposed: false,
      },
      measurementReminder: {
        clientManaged: false,
      },
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
      medication: {
        clientManaged: true,
        deliveryDefault: "server",
        lowStockRunwayDays: 7,
        reorderLeadDays: 10,
      },
      mood: { reminderHour: 22 },
      cycle: { clientManaged: false },
      coach: {
        nudgesEnabled: true,
        nudgeMedication: true,
        nudgeVitals: true,
        nudgeRoutine: true,
        nudgeFrequency: "weekly",
        ambientSuggestions: true,
        nudgeAiComposed: false,
      },
      measurementReminder: {
        clientManaged: false,
      },
      // v1.32.22 (M1) — the write echoes the fresh optimistic-concurrency token.
      updatedAt: expect.any(String),
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { updatedAt: true },
      data: {
        notificationPrefs: {
          medication: {
            clientManaged: true,
            deliveryDefault: "server",
            lowStockRunwayDays: 7,
            reorderLeadDays: 10,
          },
          mood: { reminderHour: 22 },
          cycle: { clientManaged: false },
          coach: {
            nudgesEnabled: true,
            nudgeMedication: true,
            nudgeVitals: true,
            nudgeRoutine: true,
            nudgeFrequency: "weekly",
            ambientSuggestions: true,
            nudgeAiComposed: false,
          },
          measurementReminder: {
            clientManaged: false,
          },
        },
      },
    });

    expect(auditLog).toHaveBeenCalledWith(
      "user.notification-prefs.update",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          previous: {
            medication: {
              clientManaged: false,
              deliveryDefault: "server",
              lowStockRunwayDays: 7,
              reorderLeadDays: 10,
            },
            mood: { reminderHour: 22 },
            cycle: { clientManaged: false },
            coach: {
              nudgesEnabled: true,
              nudgeMedication: true,
              nudgeVitals: true,
              nudgeRoutine: true,
              nudgeFrequency: "weekly",
              ambientSuggestions: true,
              nudgeAiComposed: false,
            },
            measurementReminder: {
              clientManaged: false,
            },
          },
          next: {
            medication: {
              clientManaged: true,
              deliveryDefault: "server",
              lowStockRunwayDays: 7,
              reorderLeadDays: 10,
            },
            mood: { reminderHour: 22 },
            cycle: { clientManaged: false },
            coach: {
              nudgesEnabled: true,
              nudgeMedication: true,
              nudgeVitals: true,
              nudgeRoutine: true,
              nudgeFrequency: "weekly",
              ambientSuggestions: true,
              nudgeAiComposed: false,
            },
            measurementReminder: {
              clientManaged: false,
            },
          },
          changed: ["medication"],
        }),
      }),
    );
  });

  // 400, not the 422 this used to pin. A body that will not parse is a
  // client-side serialisation fault, and `safeJson` plus roughly two hundred
  // and twenty other routes have always answered 400 for it; the dotted token
  // moved to `meta.errorCode`, which is where a machine code belongs.
  it("rejects malformed JSON with 400", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const req = new Request("http://localhost/api/auth/me/notification-prefs", {
      method: "PATCH",
      body: "{ not valid json",
      headers: { "Content-Type": "application/json" },
    });

    const res = await (PATCH as (r: Request) => Promise<Response>)(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Invalid JSON body",
      meta: { errorCode: "notification-prefs.body.invalid_json" },
    });
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
      select: { updatedAt: true },
      data: {
        notificationPrefs: {
          medication: {
            clientManaged: true,
            deliveryDefault: "server",
            lowStockRunwayDays: 7,
            reorderLeadDays: 10,
          },
          mood: { reminderHour: 22 },
          cycle: { clientManaged: false },
          coach: {
            nudgesEnabled: true,
            nudgeMedication: true,
            nudgeVitals: true,
            nudgeRoutine: true,
            nudgeFrequency: "weekly",
            ambientSuggestions: true,
            nudgeAiComposed: false,
          },
          measurementReminder: {
            clientManaged: false,
          },
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

    const res = await (PATCH as (r: Request) => Promise<Response>)(mkPatch({}));
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { medication: { clientManaged: boolean } };
    };
    expect(env.data).toEqual({
      medication: {
        clientManaged: true,
        deliveryDefault: "server",
        lowStockRunwayDays: 7,
        reorderLeadDays: 10,
      },
      mood: { reminderHour: 22 },
      cycle: { clientManaged: false },
      coach: {
        nudgesEnabled: true,
        nudgeMedication: true,
        nudgeVitals: true,
        nudgeRoutine: true,
        nudgeFrequency: "weekly",
        ambientSuggestions: true,
        nudgeAiComposed: false,
      },
      measurementReminder: {
        clientManaged: false,
      },
      // v1.32.22 (M1) — the write echoes the fresh optimistic-concurrency token.
      updatedAt: expect.any(String),
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { updatedAt: true },
      data: {
        notificationPrefs: {
          medication: {
            clientManaged: true,
            deliveryDefault: "server",
            lowStockRunwayDays: 7,
            reorderLeadDays: 10,
          },
          mood: { reminderHour: 22 },
          cycle: { clientManaged: false },
          coach: {
            nudgesEnabled: true,
            nudgeMedication: true,
            nudgeVitals: true,
            nudgeRoutine: true,
            nudgeFrequency: "weekly",
            ambientSuggestions: true,
            nudgeAiComposed: false,
          },
          measurementReminder: {
            clientManaged: false,
          },
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
      select: { updatedAt: true },
      data: {
        notificationPrefs: {
          medication: {
            clientManaged: false,
            deliveryDefault: "server",
            lowStockRunwayDays: 7,
            reorderLeadDays: 10,
          },
          mood: { reminderHour: 9 },
          cycle: { clientManaged: false },
          coach: {
            nudgesEnabled: true,
            nudgeMedication: true,
            nudgeVitals: true,
            nudgeRoutine: true,
            nudgeFrequency: "weekly",
            ambientSuggestions: true,
            nudgeAiComposed: false,
          },
          measurementReminder: {
            clientManaged: false,
          },
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

  it("v1.16.11 — round-trips a custom lowStockRunwayDays", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ medication: { lowStockRunwayDays: 14 } }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { medication: { lowStockRunwayDays: number | null } };
    };
    expect(env.data.medication.lowStockRunwayDays).toBe(14);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { updatedAt: true },
      data: {
        notificationPrefs: expect.objectContaining({
          medication: {
            clientManaged: false,
            deliveryDefault: "server",
            lowStockRunwayDays: 14,
            reorderLeadDays: 10,
          },
        }),
      },
    });
  });

  it("v1.16.11 — persists the explicit null (alert off)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { lowStockRunwayDays: 14 } },
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ medication: { lowStockRunwayDays: null } }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { medication: { lowStockRunwayDays: number | null } };
    };
    expect(env.data.medication.lowStockRunwayDays).toBe(null);
  });

  it("v1.16.11 — rejects a lowStockRunwayDays outside 1..60 with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    for (const value of [0, 61]) {
      const res = await (PATCH as (r: Request) => Promise<Response>)(
        mkPatch({ medication: { lowStockRunwayDays: value } }),
      );
      expect(res.status).toBe(422);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-user rate-limit fires", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      limit: 60,
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

/**
 * v1.32.22 (M1) — optimistic concurrency (issue #581 family). A PATCH carrying
 * the `baseUpdatedAt` it was based on writes CONDITIONALLY on the stored row
 * still carrying that token. The headline case: a concurrent web PATCH of a
 * DIFFERENT category can no longer silently revert the iOS `clientManaged`
 * flag (the double-reminder class). A tokenless PATCH keeps the prior
 * unconditional write — the iOS-compat arm.
 */
describe("PATCH /api/auth/me/notification-prefs — optimistic concurrency", () => {
  function mkTokenedPatch(body: unknown, baseUpdatedAt?: string): Request {
    return mkPatch(
      baseUpdatedAt !== undefined
        ? { ...(body as object), baseUpdatedAt }
        : body,
    );
  }

  it("guards on the base token and echoes the advanced token", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique)
      // merge read
      .mockResolvedValueOnce({ notificationPrefs: null } as never)
      // post-write fresh-token read
      .mockResolvedValueOnce({
        updatedAt: new Date("2026-07-24T10:05:00.000Z"),
      } as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkTokenedPatch(
        { medication: { clientManaged: true } },
        "2026-07-24T10:00:00.000Z",
      ),
    );
    expect(res.status).toBe(200);

    // Conditional write, no unconditional fallback.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const whereArg = vi.mocked(prisma.user.updateMany).mock.calls[0]?.[0]
      ?.where as { id: string; updatedAt: Date };
    expect(whereArg.id).toBe("user-1");
    expect((whereArg.updatedAt as Date).toISOString()).toBe(
      "2026-07-24T10:00:00.000Z",
    );
    expect(prisma.user.update).not.toHaveBeenCalled();

    const env = (await res.json()) as { data: { updatedAt: string } };
    expect(env.data.updatedAt).toBe("2026-07-24T10:05:00.000Z");
  });

  it("regression: a stale-token web write does NOT revert the iOS clientManaged flag", async () => {
    // iOS set medication.clientManaged = true (row now carries it). A web card
    // PATCH based on a pre-iOS read of a DIFFERENT category arrives with a stale
    // token: it must 409 and write NOTHING, so clientManaged survives.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { clientManaged: true } },
    } as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkTokenedPatch({ mood: { reminderHour: 9 } }, "2026-07-24T08:00:00.000Z"),
    );
    expect(res.status).toBe(409);
    const env = (await res.json()) as {
      data: null;
      meta?: { errorCode?: string };
    };
    expect(env.data).toBeNull();
    expect(env.meta?.errorCode).toBe("notification_prefs_conflict");

    // The guarded write matched no row; nothing was written, so the persisted
    // clientManaged flag is untouched.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("compat: the SAME second write TOKENLESS still lands (old clients keep last-write-wins)", async () => {
    // Deliberate: a tokenless client keeps the pre-guard race. This pins that
    // the clobber for old clients is a documented choice, not an accident.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { clientManaged: true } },
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      updatedAt: new Date("2026-07-24T11:00:00.000Z"),
    } as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ mood: { reminderHour: 9 } }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("422s a malformed base token without touching the row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkTokenedPatch({ medication: { clientManaged: true } }, "not-a-date"),
    );
    expect(res.status).toBe(422);
    const env = (await res.json()) as { meta?: { errorCode?: string } };
    expect(env.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
