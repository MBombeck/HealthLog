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
  const actual =
    await importOriginal<typeof import("@/lib/logging/context")>();
  return {
    ...actual,
    annotate: vi.fn(),
  };
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
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { __resetAuditDedupMemoForTests } from "@/lib/audit-dedup";
import { DEFAULT_INSIGHTS_LAYOUT } from "@/lib/insights-layout";

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
    expect(body.data.version).toBe(1);
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
      version: 1,
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
      version: 1,
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
    const updateCall = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as unknown as {
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

describe("PUT /api/insights/layout — 422 multi-issue envelope", () => {
  it("surfaces TWO simultaneous validation errors under details.issues", async () => {
    const res = await callPut(makeReq({ version: 2, tiles: [] }));
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
        version: 1,
        tiles: [{ id: "not-a-real-tile", visible: true, order: 0 }],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string }> };
    };
    expect(
      body.details.issues.some((i) => i.path.startsWith("tiles")),
    ).toBe(true);
  });

  it("writes one audit-ledger row keyed insights.layout.validation-failed", async () => {
    const res = await callPut(makeReq({ version: 2, tiles: [] }));
    expect(res.status).toBe(422);

    await new Promise((r) => setTimeout(r, 5));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string; details: string };
    };
    expect(call.data.userId).toBe("user-1");
    expect(call.data.action).toBe("insights.layout.validation-failed");
    const details = JSON.parse(call.data.details) as {
      issues: Array<{ path: string; code: string }>;
    };
    expect(details.issues.length).toBe(2);
    for (const issue of details.issues) {
      // The persisted row strips `message` so a future Zod code that
      // echoes the offending value cannot leak into the audit
      // surface.
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
  });

  it("dedups the audit-ledger write across two sequential 422s for the same user", async () => {
    const res1 = await callPut(makeReq({ version: 2, tiles: [] }));
    expect(res1.status).toBe(422);
    const res2 = await callPut(makeReq({ version: 2, tiles: [] }));
    expect(res2.status).toBe(422);

    await new Promise((r) => setTimeout(r, 5));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);

    // The full multi-issue envelope still rides on every 422 — the
    // dedup only suppresses the breadcrumb write, never the response.
    const body2 = (await res2.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body2.details.issues.length).toBe(2);
  });

  it("surfaces received_keys + received_shape_excerpt + zod_issues in the wide-event meta", async () => {
    const payload = { version: 2, tiles: [], extraGarbage: "from-ios" };
    const res = await callPut(makeReq(payload));
    expect(res.status).toBe(422);

    const annotated = vi.mocked(annotate).mock.calls.find(
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

    const annotated = vi.mocked(annotate).mock.calls.find(
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

    const res = await callPut(makeReq({ version: 2, tiles: [] }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBe(2);
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
