/**
 * v1.35.0 — GET/PATCH /api/auth/me/health-score-config.
 *
 * Covers the read projection, the positive-selection-in /
 * deselection-out inversion, the write-time breadth refusal, the
 * monotonic recipe version, and the score-cache eviction. The
 * invalidation assertion is here because a missing one is invisible:
 * the write succeeds, the response is right, and the person keeps
 * seeing the old number for an hour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
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
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import type { ScorePillarId } from "@/lib/analytics/score/types";
import { buildOpenApiDocument } from "@/lib/openapi/registry";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

const ALL_PILLARS: ScorePillarId[] = [
  "BLOOD_PRESSURE",
  "GLYCAEMIA",
  "ACTIVITY",
  "SLEEP",
  "ADIPOSITY",
  "WELLBEING",
  "LIPIDS",
];

interface ResolvedBody {
  pillars: ScorePillarId[];
  excludedPillars: ScorePillarId[];
  hasSelection: boolean;
  version: number;
  changedAt: string | null;
  updatedAt?: string;
}

function mkPatch(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/health-score-config", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/** Mutable row, so a write is visible to the read that follows it. */
function primeUser(healthScoreConfigJson: unknown = null) {
  const row: { healthScoreConfigJson: unknown; updatedAt: Date } = {
    healthScoreConfigJson,
    updatedAt: new Date("2026-07-31T09:00:00.000Z"),
  };
  vi.mocked(prisma.user.findUnique).mockImplementation((() =>
    Promise.resolve({ ...row })) as never);
  vi.mocked(prisma.user.update).mockImplementation(((args: {
    data?: { healthScoreConfigJson?: unknown };
  }) => {
    if (args.data && "healthScoreConfigJson" in args.data) {
      row.healthScoreConfigJson = args.data.healthScoreConfigJson;
    }
    return Promise.resolve({ updatedAt: row.updatedAt });
  }) as never);
  return row;
}

function writtenConfig(): {
  excludedPillars: ScorePillarId[];
  version: number;
  changedAt: string;
} {
  const call = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as unknown as {
    data: {
      healthScoreConfigJson: {
        excludedPillars: ScorePillarId[];
        version: number;
        changedAt: string;
      };
    };
  };
  return call.data.healthScoreConfigJson;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me/health-score-config", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/health-score-config"),
    );
    expect(res.status).toBe(401);
  });

  it("reports every pillar counting, and no selection, for a fresh account", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/health-score-config"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: ResolvedBody };
    expect(env.data.pillars).toEqual(ALL_PILLARS);
    expect(env.data.hasSelection).toBe(false);
    expect(env.data.version).toBe(0);
    expect(env.data.updatedAt).toBeUndefined();
  });

  it("reports a stored selection as the pillars it leaves counting", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({
      excludedPillars: ["SLEEP", "LIPIDS"],
      version: 2,
      changedAt: "2026-07-30T08:00:00.000Z",
    });
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/health-score-config"),
    );
    const env = (await res.json()) as { data: ResolvedBody };
    expect(env.data.pillars).toEqual(
      ALL_PILLARS.filter((id) => id !== "SLEEP" && id !== "LIPIDS"),
    );
    expect(env.data.excludedPillars).toEqual(["SLEEP", "LIPIDS"]);
    expect(env.data.hasSelection).toBe(true);
    expect(env.data.version).toBe(2);
    expect(env.data.updatedAt).toBe("2026-07-31T09:00:00.000Z");
  });
});

describe("PATCH /api/auth/me/health-score-config", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_PILLARS }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("stores the complement of the selection and returns the selection", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    const selection: ScorePillarId[] = [
      "BLOOD_PRESSURE",
      "ACTIVITY",
      "SLEEP",
      "ADIPOSITY",
    ];

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: selection }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: ResolvedBody };
    expect(env.data.pillars).toEqual(selection);
    expect(env.data.hasSelection).toBe(true);

    const stored = writtenConfig();
    expect(stored.excludedPillars).toEqual(
      ALL_PILLARS.filter((id) => !selection.includes(id)),
    );
    expect(stored.version).toBe(1);
    expect(stored.changedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(auditLog).toHaveBeenCalledWith(
      "user.health_score_config.update",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("increments the recipe version on every accepted write", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser({
      excludedPillars: ["LIPIDS"],
      version: 7,
      changedAt: "2026-07-01T00:00:00.000Z",
    });

    await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_PILLARS }),
    );
    expect(writtenConfig().version).toBe(8);
  });

  it("keeps a kept-everything selection as an authored choice", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_PILLARS }),
    );
    const env = (await res.json()) as { data: ResolvedBody };
    expect(writtenConfig().excludedPillars).toEqual([]);
    expect(env.data.hasSelection).toBe(true);
  });

  it("evicts the score caches so the old number is not served on", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_PILLARS }),
    );
    expect(invalidateUserHealthScore).toHaveBeenCalledWith("user-1");
  });
});

/**
 * v1.38 — what the write still refuses, after the breadth floor became a
 * recommendation.
 *
 * Two of the three refusals this block used to pin are gone. The route
 * turned away `["ACTIVITY", "WELLBEING"]` with
 * `measured_physiological_domain_required` and the cardiometabolic
 * triple with `three_domains_required`, both on the ground that the
 * selection could not produce a score. It can now — the scorer computes
 * from whatever is readable and labels how broad the set was — and a
 * write that kept refusing what the read is willing to serve would be
 * the two layers disagreeing, which is the drift the shared rule exists
 * to prevent. So those two assertions are inverted to acceptances.
 *
 * The empty selection stays refused, and that case is why this is a
 * change of rule rather than a removal of one.
 */
describe("PATCH — the breadth rule", () => {
  it("accepts activity and wellbeing alone, and stores them", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ["ACTIVITY", "WELLBEING"] }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(invalidateUserHealthScore).toHaveBeenCalledWith("user-1");
  });

  it("accepts the cardiometabolic triple, which is three pillars in one area", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ["BLOOD_PRESSURE", "GLYCAEMIA", "LIPIDS"] }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("accepts a single pillar", async () => {
    // The narrowest selection that can still be scored, and the boundary
    // the one surviving refusal sits against.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ["ACTIVITY"] }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty selection rather than storing a score that cannot exist", async () => {
    // The counter-case. A write that accepted everything would have
    // stopped enforcing anything, and this is the one selection the
    // scorer genuinely cannot answer.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: [] }),
    );
    expect(res.status).toBe(422);
    const env = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string; reason?: string };
    };
    expect(env.meta?.errorCode).toBe("health_score_config.too_narrow");
    expect(env.meta?.reason).toBe("no_pillars_selected");
    expect(env.error).toContain("at least one area of health");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(invalidateUserHealthScore).not.toHaveBeenCalled();
  });

  it("accepts a three-area selection", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"] }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH — envelope and transport", () => {
  it("rejects an unknown pillar id with 422 and writes nothing", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ["BLOOD_PRESSURE", "MOON_PHASE", "SLEEP"] }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown body key with 422 (strict stays strict)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_PILLARS, weights: { SLEEP: 2 } }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses a userId in the body", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_PILLARS, userId: "user-2" }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const req = new Request(
      "http://localhost/api/auth/me/health-score-config",
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

  it("returns 429 when the per-user rate limit fires", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    });
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_PILLARS }),
    );
    expect(res.status).toBe(429);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("guards the write on the base token and 409s a stale one", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({
        pillars: ALL_PILLARS,
        baseUpdatedAt: "2026-07-24T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(409);
    const env = (await res.json()) as { meta?: { errorCode?: string } };
    expect(env.meta?.errorCode).toBe("health_score_config_conflict");
    expect(prisma.user.update).not.toHaveBeenCalled();
    // A write that never landed must not evict the caches either.
    expect(invalidateUserHealthScore).not.toHaveBeenCalled();
  });
});

/**
 * v1.35.1 — the route shipped in v1.35.0 with a settings surface in front
 * of it and no published contract at all: `grep -c health-score-config
 * docs/api/openapi.yaml` returned 0. This block is the second end.
 *
 * It does not compare the spec against a restatement of the spec. It drives
 * the REAL route to produce each response, reads the codes and keys off the
 * bytes it actually returns, and asserts the published contract names them.
 * A response the route can emit but the contract does not describe fails
 * here, which is the failure the release itself did not catch.
 */
describe("the published contract matches what the route serves", () => {
  const PATH = "/api/auth/me/health-score-config";

  function doc() {
    return buildOpenApiDocument() as {
      paths?: Record<
        string,
        Record<string, { responses?: Record<string, { description?: string }> }>
      >;
      components?: {
        schemas?: Record<
          string,
          { properties?: Record<string, unknown>; required?: string[] }
        >;
      };
    };
  }

  /** Every `meta.errorCode` the PATCH route can actually produce. */
  async function emittedErrorCodes(): Promise<Map<number, Set<string>>> {
    const byStatus = new Map<number, Set<string>>();
    const record = async (body: unknown, conflict = false) => {
      vi.clearAllMocks();
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      primeUser(null);
      vi.mocked(prisma.user.updateMany).mockResolvedValue({
        count: conflict ? 0 : 1,
      } as never);
      const res = await (PATCH as (r: Request) => Promise<Response>)(
        mkPatch(body),
      );
      const env = (await res.json()) as { meta?: { errorCode?: string } };
      if (env.meta?.errorCode) {
        const set = byStatus.get(res.status) ?? new Set<string>();
        set.add(env.meta.errorCode);
        byStatus.set(res.status, set);
      }
    };

    // Too narrow. One reason since v1.38, because one selection is: the
    // empty one.
    await record({ pillars: [] });
    // Body that fails validation.
    await record({ pillars: ["NOT_A_PILLAR"] });
    // Present-but-unparseable base token.
    await record({ pillars: ALL_PILLARS, baseUpdatedAt: null });
    // Stale base token.
    await record(
      { pillars: ALL_PILLARS, baseUpdatedAt: "2026-07-24T08:00:00.000Z" },
      true,
    );
    return byStatus;
  }

  it("registers both verbs", () => {
    const path = doc().paths?.[PATH];
    expect(
      path,
      `${PATH} is not registered in the OpenAPI document`,
    ).toBeDefined();
    expect(Object.keys(path ?? {}).sort()).toEqual(["get", "patch"]);
  });

  it("names every errorCode the route can emit, on the right status", async () => {
    const emitted = await emittedErrorCodes();
    const responses = doc().paths?.[PATH]?.patch?.responses ?? {};

    // Sanity: the driver really did produce the codes, so a contract that
    // named none of them could not pass by the loop never running.
    expect([...(emitted.get(422) ?? [])].sort()).toEqual([
      "health_score_config.invalid",
      "health_score_config.too_narrow",
      "invalid_base_updated_at",
    ]);
    expect([...(emitted.get(409) ?? [])]).toEqual([
      "health_score_config_conflict",
    ]);

    for (const [status, codes] of emitted) {
      const described = responses[String(status)]?.description ?? "";
      for (const code of codes) {
        expect(
          described,
          `${status} description does not mention \`${code}\``,
        ).toContain(code);
      }
    }
  });

  it("publishes exactly the fields a real response carries", async () => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ pillars: ALL_PILLARS }),
    );
    const env = (await res.json()) as { data: ResolvedBody };
    expect(res.status).toBe(200);

    const schema = doc().components?.schemas?.["HealthScoreConfigResponse"];
    expect(schema, "HealthScoreConfigResponse is not emitted").toBeDefined();

    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
      Object.keys(env.data).sort(),
    );
    // `updatedAt` is absent on a never-configured GET, so it must not be
    // required — a generated decoder would reject that read.
    expect(schema?.required ?? []).not.toContain("updatedAt");
  });

  it("leaves updatedAt off the read that genuinely has none", async () => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    primeUser(null);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request(`http://localhost${PATH}`),
    );
    const env = (await res.json()) as { data: ResolvedBody };
    const published = Object.keys(
      doc().components?.schemas?.["HealthScoreConfigResponse"]?.properties ??
        {},
    );

    expect(Object.keys(env.data)).not.toContain("updatedAt");
    for (const key of Object.keys(env.data)) expect(published).toContain(key);
  });
});
