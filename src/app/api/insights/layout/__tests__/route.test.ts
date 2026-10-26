/**
 * v1.5.5 — `/api/insights/layout` route.
 *
 * Mirrors the dashboard-widgets test deck so the two surfaces share
 * the same contract guarantees: multi-issue 422 envelopes, redacted
 * wide-event payload diagnostics, audit-row dedup, GET returns the
 * default layout for users who have not saved one, PUT round-trips
 * through the resolver, DELETE returns the canonical default.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
  toJson: (v: unknown) => v,
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return {
    ...actual,
    annotate: vi.fn(),
  };
});

// The real `auditLog`, observed: it decides whether a refusal is filed.
vi.mock("@/lib/auth/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/audit")>();
  return { ...actual, auditLog: vi.fn(actual.auditLog) };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PUT, DELETE } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { __resetAuditDedupMemoForTests } from "@/lib/audit-dedup";
import { DEFAULT_INSIGHTS_LAYOUT } from "@/lib/insights-layout";
import { SUB_PAGE_SLUGS } from "@/lib/insights/sub-page-metric";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    displayName: null,
  },
};

const callGet = GET as unknown as () => Promise<Response>;
const callPut = PUT as unknown as (req: NextRequest) => Promise<Response>;
const callDelete = DELETE as unknown as () => Promise<Response>;

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/insights/layout", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetAllCachesForTests();
  __resetAuditDedupMemoForTests();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("GET /api/insights/layout", () => {
  it("returns the default layout when the user has no saved row", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      insightsLayoutJson: null,
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: typeof DEFAULT_INSIGHTS_LAYOUT;
    };
    expect(body.data.version).toBe(2);
    expect(body.data.tiles.length).toBe(DEFAULT_INSIGHTS_LAYOUT.tiles.length);
    expect(body.data.tiles[0]?.id).toBe(DEFAULT_INSIGHTS_LAYOUT.tiles[0]?.id);
  });

  it("does not lazy-write a row on GET", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      insightsLayoutJson: null,
    } as never);

    await callGet();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("returns the saved layout when one exists, merged through the resolver", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      insightsLayoutJson: {
        version: 1,
        tiles: [
          { id: "overview", visible: false, order: 0 },
          { id: "blood-pressure", visible: true, order: 1 },
        ],
      },
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: typeof DEFAULT_INSIGHTS_LAYOUT;
    };
    // Saved tiles surface in saved order; the resolver appends every
    // missing tile invisibly so a new release introducing a tile id
    // doesn't break a returning user's GET.
    expect(body.data.tiles[0]).toEqual({
      id: "overview",
      visible: false,
      order: 0,
    });
    expect(body.data.tiles[1]).toEqual({
      id: "blood-pressure",
      visible: true,
      order: 1,
    });
    expect(body.data.tiles.length).toBe(DEFAULT_INSIGHTS_LAYOUT.tiles.length);
  });

  it("normalises a legacy German tile id stored by a ≤ v1.7.x client to its canonical English id on read", async () => {
    // A layout persisted before the v1.8.0 rename (or by an iOS client
    // still speaking the German ids). The resolver must surface the
    // canonical English id so the GET contract is current-build clean
    // without forcing a re-PUT.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      insightsLayoutJson: {
        version: 1,
        tiles: [
          { id: "overview", visible: true, order: 0 },
          { id: "blutdruck", visible: true, order: 1 },
          { id: "stimmung", visible: false, order: 2 },
        ],
      },
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { tiles: Array<{ id: string; visible: boolean; order: number }> };
    };
    const ids = body.data.tiles.map((t) => t.id);
    // Legacy ids collapse to their English replacement…
    expect(ids).toContain("blood-pressure");
    expect(ids).toContain("mood");
    // …and the German originals never leak back out.
    expect(ids).not.toContain("blutdruck");
    expect(ids).not.toContain("stimmung");
  });
});

describe("PUT /api/insights/layout — happy path", () => {
  it("persists a normalised layout and returns it verbatim", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const payload = {
      version: 2,
      tiles: [
        { id: "overview", visible: true, order: 0 },
        { id: "blood-pressure", visible: true, order: 1 },
        { id: "pulse", visible: false, order: 2 },
      ],
    };
    const res = await callPut(makeReq(payload));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { tiles: Array<{ id: string; visible: boolean; order: number }> };
    };
    expect(body.data.tiles[0]?.id).toBe("overview");
    expect(body.data.tiles[0]?.order).toBe(0);
    expect(body.data.tiles[2]?.id).toBe("pulse");
    expect(body.data.tiles[2]?.visible).toBe(false);

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateCall = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as {
      where: { id: string };
      data: { insightsLayoutJson: unknown };
    };
    expect(updateCall.where.id).toBe("user-1");
    expect(updateCall.data.insightsLayoutJson).toBeTruthy();
  });

  it("accepts a body carrying legacy German tile ids and persists the canonical English ones", async () => {
    // Non-breaking iOS contract: a client still sending the pre-v1.8.0
    // German ids must NOT 422. The route validates the legacy ids and
    // `serializeInsightsLayout` normalises them to English before the
    // row persists, so the stored blob is always canonical.
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const payload = {
      version: 2,
      tiles: [
        { id: "overview", visible: true, order: 0 },
        { id: "blutdruck", visible: true, order: 1 },
        { id: "medikamente", visible: true, order: 2 },
      ],
    };
    const res = await callPut(makeReq(payload));
    // No 422 — the legacy ids pass validation.
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { tiles: Array<{ id: string }> };
    };
    const returnedIds = body.data.tiles.map((t) => t.id);
    expect(returnedIds).toContain("blood-pressure");
    expect(returnedIds).toContain("medications");
    expect(returnedIds).not.toContain("blutdruck");
    expect(returnedIds).not.toContain("medikamente");

    // The persisted blob is canonical too.
    const updateCall = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { insightsLayoutJson: { tiles: Array<{ id: string }> } };
    };
    const persistedIds = updateCall.data.insightsLayoutJson.tiles.map(
      (t) => t.id,
    );
    expect(persistedIds).toContain("blood-pressure");
    expect(persistedIds).toContain("medications");
    expect(persistedIds).not.toContain("blutdruck");
    expect(persistedIds).not.toContain("medikamente");
  });
});

describe("PUT /api/insights/layout — accepts version 1 (iOS contract)", () => {
  // v1.15.11 — the live iOS client still PUTs `version: 1`. The schema
  // accepts both 1 and 2; the serializer always normalises to the canonical
  // v2 blob, so a v1 body persists a resolved v2 layout rather than 422ing.
  it("accepts a PUT with version 1 and no sections, persisting a resolved v2 layout", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        tiles: [
          { id: "overview", visible: true, order: 0 },
          { id: "blood-pressure", visible: true, order: 1 },
        ],
      }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        version: number;
        sections: Array<{ id: string; visible: boolean }>;
        tiles: Array<{ id: string }>;
      };
    };
    // Stored + returned blob is canonical v2 regardless of the input version.
    expect(body.data.version).toBe(2);
    // Sections were absent on input → filled from defaults, all visible.
    expect(body.data.sections.length).toBeGreaterThan(0);
    for (const s of body.data.sections) expect(s.visible).toBe(true);
    expect(body.data.tiles.map((t) => t.id)).toContain("overview");

    // The persisted column is the canonical v2 blob too.
    const updateCall = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { insightsLayoutJson: { version: number; sections: unknown[] } };
    };
    expect(updateCall.data.insightsLayoutJson.version).toBe(2);
    expect(Array.isArray(updateCall.data.insightsLayoutJson.sections)).toBe(
      true,
    );
  });
});

describe("PUT /api/insights/layout — full metric-slug universe", () => {
  // v1.8.7.1 — the layout tile-id enum derives from `SUB_PAGE_SLUGS`, so
  // the long-tail HealthKit + body-composition + mobility + audio slugs
  // the routed tab strip already exposes are now valid layout ids. iOS
  // can persist a layout covering the full metric set rather than 422ing
  // on the ~25 slugs the fixed allow-list did not know about.
  const NEWLY_ACCEPTED_SLUGS = [
    "blood-glucose",
    "skin-temperature",
    "respiratory-rate",
    "flights-climbed",
    "walking-speed",
    "vascular-age",
    "headphone-audio",
    "muscle-mass",
    "daylight",
  ] as const;

  it("accepts a layout that includes every previously-rejected sub-page slug", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const tiles = NEWLY_ACCEPTED_SLUGS.map((id, order) => ({
      id,
      visible: order % 2 === 0,
      order,
    }));
    const res = await callPut(makeReq({ version: 2, tiles }));
    // No 422 — these are all canonical sub-page slugs now.
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { tiles: Array<{ id: string; visible: boolean }> };
    };
    const returnedIds = body.data.tiles.map((t) => t.id);
    for (const slug of NEWLY_ACCEPTED_SLUGS) {
      expect(returnedIds).toContain(slug);
    }
  });

  it("accepts a layout covering the ENTIRE slug universe in one PUT", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const tiles = ["overview", ...SUB_PAGE_SLUGS].map((id, order) => ({
      id,
      visible: true,
      order,
    }));
    const res = await callPut(makeReq({ version: 2, tiles }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { tiles: Array<{ id: string }> };
    };
    const returnedIds = new Set(body.data.tiles.map((t) => t.id));
    // Every slug the web tab strip enumerates round-trips through the PUT.
    for (const slug of SUB_PAGE_SLUGS) {
      expect(returnedIds.has(slug)).toBe(true);
    }
    expect(returnedIds.has("overview")).toBe(true);
  });

  it("round-trips the new slugs back through GET after a save", async () => {
    const savedTiles = NEWLY_ACCEPTED_SLUGS.map((id, order) => ({
      id,
      visible: true,
      order: order + 1,
    }));
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      insightsLayoutJson: {
        version: 1,
        tiles: [{ id: "overview", visible: true, order: 0 }, ...savedTiles],
      },
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { tiles: Array<{ id: string }> };
    };
    const ids = body.data.tiles.map((t) => t.id);
    for (const slug of NEWLY_ACCEPTED_SLUGS) {
      expect(ids).toContain(slug);
    }
  });

  it("still rejects a genuinely-unknown id even with the wider set", async () => {
    const res = await callPut(
      makeReq({
        version: 2,
        tiles: [
          { id: "blood-glucose", visible: true, order: 0 },
          { id: "not-a-metric-at-all", visible: true, order: 1 },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string }> };
    };
    expect(body.details.issues.some((i) => i.path.startsWith("tiles"))).toBe(
      true,
    );
  });
});

describe("PUT /api/insights/layout — 422 multi-issue envelope", () => {
  it("surfaces TWO simultaneous validation errors under details.issues", async () => {
    const res = await callPut(makeReq({ version: 99, tiles: [] }));
    expect(res.status).toBe(422);

    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBe(2);
    const paths = body.details.issues.map((i) => i.path).sort();
    expect(paths).toEqual(["tiles", "version"]);

    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("rejects an unknown tile id", async () => {
    const res = await callPut(
      makeReq({
        version: 2,
        tiles: [{ id: "not-a-real-tile", visible: true, order: 0 }],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string }> };
    };
    expect(body.details.issues.some((i) => i.path.startsWith("tiles"))).toBe(
      true,
    );
  });

  it("hands the insights.layout.validation-failed refusal to auditLog, which files no row for the owner", async () => {
    const res = await callPut(makeReq({ version: 99, tiles: [] }));
    expect(res.status).toBe(422);

    await new Promise((r) => setTimeout(r, 5));

    expect(auditLog).toHaveBeenCalledTimes(1);
    const [action, opts] = vi.mocked(auditLog).mock.calls[0]!;
    expect(action).toBe("insights.layout.validation-failed");
    expect(opts?.userId).toBe("user-1");
    // An owner's own refused request is not an audit event.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    const details = opts?.details as {
      issues: Array<{ path: string; code: string }>;
    };
    expect(details.issues.length).toBe(2);
    for (const issue of details.issues) {
      // The filed issues strip `message` so a future Zod code that
      // echoes the offending value cannot leak into the audit
      // surface.
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
  });

  it("dedups the audit call across two sequential 422s for the same user", async () => {
    const res1 = await callPut(makeReq({ version: 99, tiles: [] }));
    expect(res1.status).toBe(422);
    const res2 = await callPut(makeReq({ version: 99, tiles: [] }));
    expect(res2.status).toBe(422);

    await new Promise((r) => setTimeout(r, 5));

    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();

    // The full multi-issue envelope still rides on every 422 — the
    // dedup only suppresses the breadcrumb write, never the response.
    const body2 = (await res2.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body2.details.issues.length).toBe(2);
  });

  it("surfaces received_keys + received_shape_excerpt + zod_issues in the wide-event meta", async () => {
    const payload = { version: 99, tiles: [], extraGarbage: "from-ios" };
    const res = await callPut(makeReq(payload));
    expect(res.status).toBe(422);

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "insights.layout.validation-failed",
      );
    expect(annotated, "validation-failed annotate call").toBeTruthy();
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;

    expect(meta.received_keys).toEqual(
      expect.arrayContaining(["version", "tiles", "extraGarbage"]),
    );

    expect(typeof meta.received_shape_excerpt).toBe("string");
    expect((meta.received_shape_excerpt as string).length).toBeLessThanOrEqual(
      256,
    );

    const issues = meta.zod_issues as Array<{ path: string; code: string }>;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("redacts sensitive keys before writing the wide-event received_shape_excerpt", async () => {
    const payload = {
      version: 2,
      tiles: [],
      apnsToken: "ff".repeat(32),
      authorization: "Bearer leaked",
      payload: { apiKey: "sk_live_xxx" },
    };
    const res = await callPut(makeReq(payload));
    expect(res.status).toBe(422);

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "insights.layout.validation-failed",
      );
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;
    const excerpt = meta.received_shape_excerpt as string;

    expect(excerpt).not.toContain("ff".repeat(32));
    expect(excerpt).not.toContain("Bearer leaked");
    expect(excerpt).not.toContain("sk_live_xxx");
    expect(excerpt).toContain("[redacted]");
    expect(meta.received_keys).toEqual(
      expect.arrayContaining([
        "version",
        "tiles",
        "apnsToken",
        "authorization",
        "payload",
      ]),
    );
  });

  it("does not block the 422 response when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );

    const res = await callPut(makeReq({ version: 99, tiles: [] }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBe(2);
  });
});

describe("PUT /api/insights/layout — v2 sections", () => {
  it("persists a sections array alongside tiles", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const payload = {
      version: 2,
      sections: [
        { id: "vitals", visible: true, order: 0 },
        { id: "daily-briefing", visible: false, order: 1 },
        { id: "wellness-scores", visible: true, order: 2 },
      ],
      tiles: [{ id: "overview", visible: true, order: 0 }],
    };
    const res = await callPut(makeReq(payload));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        sections: Array<{ id: string; visible: boolean; order: number }>;
      };
    };
    // Saved sections surface in saved order, dense 0-based.
    expect(body.data.sections[0]).toEqual({
      id: "vitals",
      visible: true,
      order: 0,
    });
    expect(body.data.sections[1]).toEqual({
      id: "daily-briefing",
      visible: false,
      order: 1,
    });
    // PUT persists exactly the sent sections (serialize, not resolve);
    // the read path merges any missing defaults back in.
    expect(body.data.sections.map((s) => s.id)).toEqual([
      "vitals",
      "daily-briefing",
      "wellness-scores",
    ]);
  });

  it("succeeds when the body omits sections (backward-compat iOS client)", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 2,
        tiles: [{ id: "overview", visible: true, order: 0 }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { sections: Array<{ id: string; visible: boolean }> };
    };
    // Defaults fill in, all visible.
    expect(body.data.sections.length).toBeGreaterThan(0);
    for (const s of body.data.sections) expect(s.visible).toBe(true);
  });

  it("succeeds when the body omits tiles (section-only PUT)", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 2,
        sections: [{ id: "vitals", visible: true, order: 0 }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        sections: Array<{ id: string }>;
        tiles: Array<{ id: string }>;
      };
    };
    // tiles fall back to the canonical default set.
    expect(body.data.tiles.length).toBe(DEFAULT_INSIGHTS_LAYOUT.tiles.length);
    expect(body.data.sections.some((s) => s.id === "vitals")).toBe(true);
  });

  it("rejects an unknown section id", async () => {
    const res = await callPut(
      makeReq({
        version: 2,
        sections: [{ id: "not-a-section", visible: true, order: 0 }],
        tiles: [{ id: "overview", visible: true, order: 0 }],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string }> };
    };
    expect(body.details.issues.some((i) => i.path.startsWith("sections"))).toBe(
      true,
    );
  });
});

describe("DELETE /api/insights/layout", () => {
  it("clears the saved row and returns the default layout", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callDelete();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: typeof DEFAULT_INSIGHTS_LAYOUT;
    };
    expect(body.data.tiles.length).toBe(DEFAULT_INSIGHTS_LAYOUT.tiles.length);

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as {
      data: { insightsLayoutJson: unknown };
    };
    // The Prisma JsonNull sentinel writes NULL into the column.
    expect(call.data.insightsLayoutJson).toBeDefined();
  });
});

/**
 * v1.32.21 — optimistic concurrency (issue #581 family). A PUT carrying
 * the `baseUpdatedAt` it was based on writes CONDITIONALLY on the stored row
 * still carrying that token, so an interleaved edit-mode Save and Settings
 * pill-order Save can't clobber one another. A tokenless PUT keeps the prior
 * unconditional write — the iOS-compat arm.
 */
describe("PUT /api/insights/layout — optimistic concurrency", () => {
  function body(baseUpdatedAt?: string) {
    return {
      version: 2,
      tiles: [{ id: "overview", visible: true, order: 0 }],
      ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
    };
  }

  it("guards the write on the base token and returns the advanced token", async () => {
    const base = new Date("2026-07-24T10:00:00.000Z");
    const advanced = new Date("2026-07-24T10:05:00.000Z");
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);
    // The merge-read `previous` (no row) then the post-write token read.
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({ insightsLayoutJson: null } as never)
      .mockResolvedValueOnce({ updatedAt: advanced } as never);

    const res = await callPut(makeReq(body(base.toISOString())));
    expect(res.status).toBe(200);

    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const whereArg = vi.mocked(prisma.user.updateMany).mock.calls[0]?.[0]
      ?.where as { id: string; updatedAt: Date };
    expect(whereArg.id).toBe("user-1");
    expect((whereArg.updatedAt as Date).toISOString()).toBe(base.toISOString());
    expect(prisma.user.update).not.toHaveBeenCalled();

    const bodyJson = (await res.json()) as { data: { updatedAt: string } };
    expect(bodyJson.data.updatedAt).toBe(advanced.toISOString());
  });

  it("interleaved writers: the stale-base second writer gets 409 and clobbers nothing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      insightsLayoutJson: null,
    } as never);
    // Writer B committed first; writer A's guarded write matches zero rows.
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await callPut(makeReq(body("2026-07-24T09:00:00.000Z")));
    expect(res.status).toBe(409);

    const bodyJson = (await res.json()) as {
      data: null;
      error: string;
      meta?: { errorCode?: string };
    };
    expect(bodyJson.data).toBeNull();
    expect(bodyJson.meta?.errorCode).toBe("insights_layout_conflict");

    // Guarded write matched no row; no unconditional fallback → nothing written.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("422s a malformed base token without touching the row", async () => {
    const res = await callPut(makeReq(body("not-a-date")));
    expect(res.status).toBe(422);
    const bodyJson = (await res.json()) as { meta?: { errorCode?: string } };
    expect(bodyJson.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("keeps the unconditional write when the client omits the token (iOS compat)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      insightsLayoutJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      updatedAt: new Date("2026-07-24T11:00:00.000Z"),
    } as never);

    const res = await callPut(makeReq(body()));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    const bodyJson = (await res.json()) as { data: { updatedAt: string } };
    expect(bodyJson.data.updatedAt).toBe("2026-07-24T11:00:00.000Z");
  });
});
