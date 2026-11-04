/**
 * v1.4.43 — multi-issue 422 envelope on PUT /api/measurements/[id].
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/after-measurement-mutation", () => ({
  afterMeasurementMutation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { PUT } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { getSession } from "@/lib/auth/session";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements/m1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ROUTE_CTX = { params: Promise.resolve({ id: "m1" }) };

const EXISTING = {
  id: "m1",
  userId: "user-1",
  type: "WEIGHT",
  source: "MANUAL",
  value: 80,
  measuredAt: new Date("2026-06-01T08:00:00Z"),
  notes: null,
  notesEncrypted: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  // v1.37.0 — the breadcrumb goes through `auditLog()` now (the only writer
  // that stamps the actor). `resetAllMocks` clears the factory's resolved
  // value and the route chains `.catch()` on the call, so it has to resolve
  // again here or every 422 path throws.
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  // resetAllMocks clears the factory implementation; the route chains
  // `.catch()` on this fire-and-forget call, so it must resolve again.
  vi.mocked(invalidateStatusInsightsForTypes).mockResolvedValue(
    undefined as never,
  );
  vi.mocked(prisma.measurement.findFirst).mockResolvedValue(EXISTING as never);
  vi.mocked(prisma.measurement.update).mockImplementation((async (args: {
    data: Record<string, unknown>;
  }) => ({
    ...EXISTING,
    ...args.data,
  })) as never);
});

describe("PUT /api/measurements/[id] — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // `value` not a number + `measuredAt` not a valid ISO.
    const res = await PUT(
      putReq({ value: "junk", measuredAt: "not-iso" }),
      ROUTE_CTX,
    );
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
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    // `value` not a number + `measuredAt` not iso + `notes` too long.
    const res = await PUT(
      putReq({
        value: "string",
        measuredAt: "not-iso",
        notes: "a".repeat(201),
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; code: string }> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes a measurements.update.validation-failed audit row", async () => {
    const res = await PUT(
      putReq({ value: "junk", measuredAt: "junk" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(auditLog).toHaveBeenCalledTimes(1);
    const [action, opts] = vi.mocked(auditLog).mock.calls[0] as [
      string,
      { userId: string },
    ];
    expect(action).toBe("measurements.update.validation-failed");
    expect(opts.userId).toBe("user-1");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(auditLog).mockRejectedValueOnce(new Error("db down"));
    const res = await PUT(
      putReq({ value: "junk", measuredAt: "junk" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });
});

describe("PUT /api/measurements/[id] — value guards (di-001)", () => {
  it("422s an edit outside the row type's plausibility band", async () => {
    // Existing row is WEIGHT (band 1..500 kg) — 9999 must not pass just
    // because the edit body carries no type.
    const res = await PUT(putReq({ value: 9999 }), ROUTE_CTX);
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: { issues: Array<{ path: string; message: string }> };
    };
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues).toHaveLength(1);
    expect(body.details.issues[0].path).toContain("value");
    expect(prisma.measurement.update).not.toHaveBeenCalled();
  });

  it("accepts a negative value on a signed type", async () => {
    // ANS_CHARGE runs -100..100; the former generic min(0) rejected every
    // legitimate negative edit.
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue({
      ...EXISTING,
      type: "ANS_CHARGE",
      value: 12,
    } as never);
    const res = await PUT(putReq({ value: -40 }), ROUTE_CTX);
    expect(res.status).toBe(200);
    const call = vi.mocked(prisma.measurement.update).mock.calls[0]?.[0] as {
      data: { value?: number };
    };
    expect(call.data.value).toBe(-40);
  });

  it("409s a value edit on a server-owned source with a stable errorCode", async () => {
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue({
      ...EXISTING,
      source: "WITHINGS",
    } as never);
    const res = await PUT(putReq({ value: 81 }), ROUTE_CTX);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      data: null;
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("measurement.update.server_owned_source");
    expect(prisma.measurement.update).not.toHaveBeenCalled();
  });

  it("still allows a timestamp-only edit on a server-owned source", async () => {
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue({
      ...EXISTING,
      source: "WITHINGS",
    } as never);
    const res = await PUT(
      putReq({ measuredAt: "2026-06-01T09:00:00.000Z" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    expect(prisma.measurement.update).toHaveBeenCalledTimes(1);
  });

  it("happy path: an in-band edit on a client-owned row persists", async () => {
    const res = await PUT(putReq({ value: 82.5 }), ROUTE_CTX);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { value: number } };
    expect(body.data.value).toBe(82.5);
    const call = vi.mocked(prisma.measurement.update).mock.calls[0]?.[0] as {
      data: { value?: number };
    };
    expect(call.data.value).toBe(82.5);
  });
});
