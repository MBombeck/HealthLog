/**
 * v1.18.0 — PATCH/GET /api/auth/me/modules.
 *
 * Covers the read projection, the field-by-field merge, core-module
 * refusal (strict schema), the cycle/coach delegation reflected in the
 * resolved map, and the standard auth / rate-limit / 422 envelope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    cycleProfile: {
      findUnique: vi.fn(),
    },
  },
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

// Operator master flag = on by default; coach delegation keys off it.
// Partial mock — api-handler imports `AssistantDisabledError` from here.
vi.mock("@/lib/feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/feature-flags")>();
  return {
    ...actual,
    getAssistantFlags: vi.fn().mockResolvedValue({ coach: true }),
  };
});

vi.mock("@/lib/cache/invalidate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/cache/invalidate")>();
  return { ...actual, invalidateUserHealthScore: vi.fn() };
});

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
import { getAssistantFlags } from "@/lib/feature-flags";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

type ModuleMap = Record<string, boolean>;

function mkPatch(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/modules", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Default DB shape: fresh user, no module prefs, no cycle row. The
 * `findUnique` mock reads from a mutable holder so a PATCH `update`
 * (which writes `modulePreferencesJson`) is reflected by the post-update
 * `resolveModuleMap` re-read — mirroring real DB round-trip semantics.
 */
function primeUser(
  over: {
    gender?: string | null;
    disableCoach?: boolean;
    modulePreferencesJson?: unknown;
    cycleTrackingEnabled?: boolean | null;
  } = {},
) {
  const row: {
    gender: string | null;
    disableCoach: boolean;
    modulePreferencesJson: unknown;
  } = {
    gender: over.gender ?? null,
    disableCoach: over.disableCoach ?? false,
    modulePreferencesJson: over.modulePreferencesJson ?? null,
  };
  vi.mocked(prisma.user.findUnique).mockImplementation((() =>
    Promise.resolve({ ...row })) as never);
  vi.mocked(prisma.user.update).mockImplementation(((args: {
    data?: { modulePreferencesJson?: unknown };
  }) => {
    const data = args.data;
    if (data && "modulePreferencesJson" in data) {
      row.modulePreferencesJson = data.modulePreferencesJson;
    }
    return Promise.resolve({});
  }) as never);
  vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(
    over.cycleTrackingEnabled === undefined
      ? null
      : ({ cycleTrackingEnabled: over.cycleTrackingEnabled } as never),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAssistantFlags).mockResolvedValue({ coach: true } as never);
});

describe("GET /api/auth/me/modules", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/modules"),
    );
    expect(res.status).toBe(401);
  });

  it("returns every toggleable module on for a fresh user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser();
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/modules"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { modules: ModuleMap } };
    expect(env.data.modules.mood).toBe(true);
    expect(env.data.modules.sleep).toBe(true);
    expect(env.data.modules.insights).toBe(true);
    // cycle gender-derived (null gender ⇒ off); coach delegated (on).
    expect(env.data.modules.cycle).toBe(false);
    expect(env.data.modules.coach).toBe(true);
  });

  it("reflects a disabled module from the persisted allowlist", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({ modulePreferencesJson: { glucose: false } });
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/modules"),
    );
    const env = (await res.json()) as { data: { modules: ModuleMap } };
    expect(env.data.modules.glucose).toBe(false);
    expect(env.data.modules.mood).toBe(true);
  });

  it("reflects coach delegation (operator master flag off)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(getAssistantFlags).mockResolvedValue({ coach: false } as never);
    primeUser();
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/modules"),
    );
    const env = (await res.json()) as { data: { modules: ModuleMap } };
    expect(env.data.modules.coach).toBe(false);
  });
});

describe("PATCH /api/auth/me/modules", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ mood: false }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("disables a module and persists the merged allowlist", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({ modulePreferencesJson: null });

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ mood: false }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { modules: ModuleMap } };
    expect(env.data.modules.mood).toBe(false);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { updatedAt: true },
      data: { modulePreferencesJson: { mood: false } },
    });
    expect(auditLog).toHaveBeenCalledWith(
      "user.modules.update",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({ changed: ["mood"] }),
      }),
    );
  });

  it("merges over the existing allowlist field-by-field (siblings intact)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // user previously disabled glucose; now disabling sleep too.
    primeUser({ modulePreferencesJson: { glucose: false } });

    await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ sleep: false }),
    );

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { updatedAt: true },
      data: { modulePreferencesJson: { glucose: false, sleep: false } },
    });
  });

  it("can re-enable a previously disabled module", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({ modulePreferencesJson: { glucose: false } });

    await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ glucose: true }),
    );

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { updatedAt: true },
      data: { modulePreferencesJson: { glucose: true } },
    });
  });

  it("REFUSES to disable a core module (strict schema 422)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser();

    // v1.18.1 (D3) — medications graduated to a toggleable module, so only
    // weight / blood pressure / pulse stay refused as core domains.
    for (const core of ["weight", "bloodPressure", "pulse"]) {
      const res = await (PATCH as (r: Request) => Promise<Response>)(
        mkPatch({ [core]: false }),
      );
      expect(res.status).toBe(422);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown module key with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser();
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ notAModule: false }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean value with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser();
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ mood: "false" }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // 400, not the 422 this used to pin. A body that will not parse is a
  // client-side serialisation fault, and `safeJson` plus roughly two hundred
  // and twenty other routes have always answered 400 for it; the dotted token
  // moved to `meta.errorCode`, which is where a machine code belongs.
  it("rejects malformed JSON with 400", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const req = new Request("http://localhost/api/auth/me/modules", {
      method: "PATCH",
      body: "{ not valid json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await (PATCH as (r: Request) => Promise<Response>)(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Invalid JSON body",
      meta: { errorCode: "modules.body.invalid_json" },
    });
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
      mkPatch({ mood: false }),
    );
    expect(res.status).toBe(429);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("drops a previously-corrupted stored blob to clean booleans on merge", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // junk in the stored row must not leak into the persisted merge.
    primeUser({ modulePreferencesJson: { mood: "yes", sleep: false } });

    await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ labs: false }),
    );

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { updatedAt: true },
      data: { modulePreferencesJson: { sleep: false, labs: false } },
    });
  });
});

/**
 * v1.35.0 — four of the score's pillars come and go with a module
 * toggle, so a toggle changes what the composite is made of. The score
 * caches hold the old composition and are served for up to an hour, so
 * the person who just turned a module off keeps seeing a number
 * computed from it. Nothing about that is visible in a test that does
 * not assert the eviction, which is why it went unnoticed for so long.
 */
describe("PATCH /api/auth/me/modules — the score caches", () => {
  it("evicts the score caches after a module toggle lands", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({ modulePreferencesJson: null });

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ sleep: false }),
    );
    expect(res.status).toBe(200);
    expect(invalidateUserHealthScore).toHaveBeenCalledWith("user-1");
  });

  it("does not evict them when the write never landed", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({ modulePreferencesJson: null });
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ sleep: false, baseUpdatedAt: "2026-07-24T08:00:00.000Z" }),
    );
    expect(res.status).toBe(409);
    expect(invalidateUserHealthScore).not.toHaveBeenCalled();
  });
});

/**
 * v1.32.22 (M3) — optimistic concurrency. The base token is stripped BEFORE
 * the `.strict()` schema parse, so it never trips strict validation; a stale
 * token 409s and writes nothing; a tokenless PATCH keeps the unconditional
 * write.
 */
describe("PATCH /api/auth/me/modules — optimistic concurrency", () => {
  it("guards on the base token and skips the unconditional write", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({ modulePreferencesJson: null });
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ mood: false, baseUpdatedAt: "2026-07-24T10:00:00.000Z" }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const whereArg = vi.mocked(prisma.user.updateMany).mock.calls[0]?.[0]
      ?.where as { id: string; updatedAt: Date };
    expect(whereArg.id).toBe("user-1");
    expect((whereArg.updatedAt as Date).toISOString()).toBe(
      "2026-07-24T10:00:00.000Z",
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("interleaved writers: the stale-base second writer gets 409 and clobbers nothing", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({ modulePreferencesJson: null });
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ mood: false, baseUpdatedAt: "2026-07-24T08:00:00.000Z" }),
    );
    expect(res.status).toBe(409);
    const env = (await res.json()) as { meta?: { errorCode?: string } };
    expect(env.meta?.errorCode).toBe("modules_conflict");
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("keeps the unconditional write when the token is omitted (compat)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({ modulePreferencesJson: null });

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ mood: false }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("strips the token pre-parse: a token ALONE does not trip the strict schema", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({ modulePreferencesJson: null });
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ mood: false, baseUpdatedAt: "2026-07-24T10:00:00.000Z" }),
    );
    // 200, not 422 — `baseUpdatedAt` was removed before the strict parse.
    expect(res.status).toBe(200);
  });

  it("still 422s an unknown key even alongside a valid token (strict stays strict)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({ modulePreferencesJson: null });

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ notAModule: false, baseUpdatedAt: "2026-07-24T10:00:00.000Z" }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("422s a malformed base token without touching the row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({ modulePreferencesJson: null });

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ mood: false, baseUpdatedAt: "not-a-date" }),
    );
    expect(res.status).toBe(422);
    const env = (await res.json()) as { meta?: { errorCode?: string } };
    expect(env.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
