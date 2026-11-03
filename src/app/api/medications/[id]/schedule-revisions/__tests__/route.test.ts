/**
 * v1.16.5 — schedule-era endpoints: ownership, validation, provenance.
 *
 *   GET    /api/medications/[id]/schedule-revisions
 *   POST   /api/medications/[id]/schedule-revisions
 *   PATCH  /api/medications/[id]/schedule-revisions/[revisionId]
 *   DELETE /api/medications/[id]/schedule-revisions/[revisionId]
 *
 * The POST guards are the contract under test: a manual era must end
 * at or before the start of the live plan, must not overlap an
 * archived era, and is always minted with `source: "MANUAL"`. The
 * DELETE refuses write-path archives (409) so the immutable history
 * the replace path mints can never be falsified through the API.
 * PATCH (v1.16.6) corrects an era: MANUAL updates in place, ARCHIVED
 * stays as the audit record behind a superseding MANUAL correction;
 * both write paths run inside the per-medication `FOR UPDATE`
 * transaction so concurrent era writes serialise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => {
  const prisma: Record<string, unknown> = {
    medication: {
      findUnique: vi.fn(),
    },
    medicationScheduleRevision: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
  prisma.$transaction = vi.fn();
  return { prisma };
});

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, POST } from "../route";
import { DELETE, PATCH } from "../[revisionId]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const ROUTE_CTX = { params: Promise.resolve({ id: "m1" }) };

function getReq(): NextRequest {
  return new NextRequest(
    "http://localhost/api/medications/m1/schedule-revisions",
  );
}

function postReq(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/medications/m1/schedule-revisions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function deleteReq(revisionId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/medications/m1/schedule-revisions/${revisionId}`,
    { method: "DELETE" },
  );
}

function deleteCtx(revisionId: string) {
  return { params: Promise.resolve({ id: "m1", revisionId }) };
}

function patchReq(revisionId: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/medications/m1/schedule-revisions/${revisionId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

const MED_CREATED_AT = new Date("2026-01-10T08:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  // Interactive form runs the callback against the same mock client
  // (the routes only touch models the flat mock already carries); the
  // array form resolves the batched operations like Promise.all.
  vi.mocked(prisma.$transaction).mockImplementation((async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: typeof prisma) => unknown)(prisma)
      : Promise.all(arg as Array<Promise<unknown>>)) as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  // Ownership guard + GET both read `medication.findUnique`; the guard
  // selects `{ id, userId }`, the GET selects `{ createdAt }` — one
  // superset row satisfies both.
  vi.mocked(prisma.medication.findUnique).mockResolvedValue({
    id: "m1",
    userId: "user-1",
    createdAt: MED_CREATED_AT,
  } as never);
  vi.mocked(prisma.medicationScheduleRevision.findMany).mockResolvedValue(
    [] as never,
  );
});

describe("GET /api/medications/[id]/schedule-revisions", () => {
  it("404s for another user's medication (existence sealed)", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "m1",
      userId: "someone-else",
      createdAt: MED_CREATED_AT,
    } as never);
    const res = await GET(getReq(), ROUTE_CTX);
    expect(res.status).toBe(404);
  });

  it("returns currentSince = createdAt when no revision exists", async () => {
    const res = await GET(getReq(), ROUTE_CTX);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.currentSince).toBe(MED_CREATED_AT.toISOString());
    expect(json.data.revisions).toEqual([]);
  });

  it("returns currentSince = newest validUntil and summarised entries", async () => {
    vi.mocked(prisma.medicationScheduleRevision.findMany).mockResolvedValue([
      {
        id: "rev-2",
        validFrom: new Date("2026-03-01T00:00:00Z"),
        validUntil: new Date("2026-05-01T00:00:00Z"),
        source: "ARCHIVED",
        payload: [
          {
            timesOfDay: ["07:00", "19:00"],
            label: "Morgens",
            dose: null,
            scheduleType: "SCHEDULED",
          },
        ],
      },
      {
        id: "rev-1",
        validFrom: new Date("2026-01-10T08:00:00Z"),
        validUntil: new Date("2026-03-01T00:00:00Z"),
        source: "MANUAL",
        // Malformed payload must degrade, never throw on a read path.
        payload: { not: "an array" },
      },
    ] as never);

    const res = await GET(getReq(), ROUTE_CTX);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.currentSince).toBe("2026-05-01T00:00:00.000Z");
    expect(json.data.revisions).toHaveLength(2);
    expect(json.data.revisions[0].entries[0].timesOfDay).toEqual([
      "07:00",
      "19:00",
    ]);
    expect(json.data.revisions[1].entries).toEqual([]);
    expect(json.data.revisions[1].source).toBe("MANUAL");
  });
});

describe("POST /api/medications/[id]/schedule-revisions", () => {
  const VALID_BODY = {
    validFrom: "2025-03-12T00:00:00.000Z",
    validUntil: "2025-06-01T00:00:00.000Z",
    timesOfDay: ["19:00", "07:00"],
  };

  it("404s for another user's medication", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "m1",
      userId: "someone-else",
      createdAt: MED_CREATED_AT,
    } as never);
    const res = await POST(postReq(VALID_BODY), ROUTE_CTX);
    expect(res.status).toBe(404);
    expect(prisma.medicationScheduleRevision.create).not.toHaveBeenCalled();
  });

  it("422s when validFrom is not before validUntil", async () => {
    const res = await POST(
      postReq({ ...VALID_BODY, validUntil: VALID_BODY.validFrom }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });

  it("422s on a malformed time literal", async () => {
    const res = await POST(
      postReq({ ...VALID_BODY, timesOfDay: ["25:99"] }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });

  it("422s when the era overlaps an archived era", async () => {
    vi.mocked(prisma.medicationScheduleRevision.findMany).mockResolvedValue([
      {
        validFrom: new Date("2025-05-01T00:00:00Z"),
        validUntil: new Date("2026-01-01T00:00:00Z"),
      },
    ] as never);
    const res = await POST(postReq(VALID_BODY), ROUTE_CTX);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/overlap/i);
  });

  it("422s when the era ends after the live plan began", async () => {
    // Realistic archive: the plan was replaced on 2026-03-01, after
    // tracking began (createdAt 2026-01-10) — the live plan has run
    // since 2026-03-01.
    vi.mocked(prisma.medicationScheduleRevision.findMany).mockResolvedValue([
      {
        validFrom: MED_CREATED_AT,
        validUntil: new Date("2026-03-01T00:00:00Z"),
      },
    ] as never);
    // Ends 2026-04-01 — after the live plan start — and does NOT
    // overlap the archived era; the boundary check must fire.
    const res = await POST(
      postReq({
        ...VALID_BODY,
        validFrom: "2026-03-05T00:00:00.000Z",
        validUntil: "2026-04-01T00:00:00.000Z",
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/current plan/i);
  });

  it("accepts a manual era filling the gap between an older manual era and createdAt", async () => {
    // Two-chunk pre-tracking history entered oldest-first: the second
    // chunk ends after the first chunk's validUntil but still at or
    // before createdAt. The boundary is max(createdAt, newest active
    // validUntil) — order of entry must not matter.
    vi.mocked(prisma.medicationScheduleRevision.findMany).mockResolvedValue([
      {
        validFrom: new Date("2025-01-01T00:00:00Z"),
        validUntil: new Date("2025-04-01T00:00:00Z"),
      },
    ] as never);
    vi.mocked(prisma.medicationScheduleRevision.create).mockResolvedValue({
      id: "rev-new",
      validFrom: new Date("2025-04-01T00:00:00.000Z"),
      validUntil: new Date("2025-06-01T00:00:00.000Z"),
      source: "MANUAL",
      payload: [],
    } as never);
    const res = await POST(
      postReq({ ...VALID_BODY, validFrom: "2025-04-01T00:00:00.000Z" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(201);
  });

  it("422s when no revision exists and the era reaches past createdAt", async () => {
    // With zero archived revisions the live plan has covered everything
    // since `createdAt` (2026-01-10); a manual era ending inside the
    // tracked window would re-score live compliance against the manual
    // snapshot. The boundary is createdAt, not "now".
    const res = await POST(
      postReq({
        ...VALID_BODY,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2026-02-01T00:00:00.000Z",
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/current plan/i);
    expect(prisma.medicationScheduleRevision.create).not.toHaveBeenCalled();
  });

  it("creates a MANUAL revision with a daily snapshot entry", async () => {
    vi.mocked(prisma.medicationScheduleRevision.create).mockResolvedValue({
      id: "rev-new",
      validFrom: new Date(VALID_BODY.validFrom),
      validUntil: new Date(VALID_BODY.validUntil),
      source: "MANUAL",
      payload: [],
    } as never);

    const res = await POST(postReq(VALID_BODY), ROUTE_CTX);
    expect(res.status).toBe(201);

    const createArgs = vi.mocked(prisma.medicationScheduleRevision.create).mock
      .calls[0][0] as unknown as {
      data: {
        medicationId: string;
        source: string;
        payload: Array<{
          timesOfDay: string[];
          rrule: string | null;
          windowStart: string;
          windowEnd: string;
          scheduleType: string;
        }>;
      };
    };
    expect(createArgs.data.medicationId).toBe("m1");
    expect(createArgs.data.source).toBe("MANUAL");
    expect(createArgs.data.payload).toHaveLength(1);
    // Times sorted ascending; window pulled to their min/max; daily.
    expect(createArgs.data.payload[0].timesOfDay).toEqual(["07:00", "19:00"]);
    expect(createArgs.data.payload[0].windowStart).toBe("07:00");
    expect(createArgs.data.payload[0].windowEnd).toBe("19:00");
    expect(createArgs.data.payload[0].rrule).toBe("FREQ=DAILY");
    expect(createArgs.data.payload[0].scheduleType).toBe("SCHEDULED");

    // Check-then-insert ran inside the transaction with the
    // per-medication `FOR UPDATE` lock taken first.
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it("collapses duplicate timesOfDay before snapshotting", async () => {
    vi.mocked(prisma.medicationScheduleRevision.create).mockResolvedValue({
      id: "rev-new",
      validFrom: new Date(VALID_BODY.validFrom),
      validUntil: new Date(VALID_BODY.validUntil),
      source: "MANUAL",
      payload: [],
    } as never);

    const res = await POST(
      postReq({ ...VALID_BODY, timesOfDay: ["19:00", "07:00", "19:00"] }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(201);
    const createArgs = vi.mocked(prisma.medicationScheduleRevision.create).mock
      .calls[0][0] as unknown as {
      data: { payload: Array<{ timesOfDay: string[] }> };
    };
    // The Zod transform dedupes + sorts — a double-tapped chip must
    // never mint a double-counted slot.
    expect(createArgs.data.payload[0].timesOfDay).toEqual(["07:00", "19:00"]);
  });
});

describe("DELETE /api/medications/[id]/schedule-revisions/[revisionId]", () => {
  it("404s when the revision belongs to another medication", async () => {
    vi.mocked(prisma.medicationScheduleRevision.findUnique).mockResolvedValue({
      id: "rev-x",
      medicationId: "other-med",
      source: "MANUAL",
    } as never);
    const res = await DELETE(deleteReq("rev-x"), deleteCtx("rev-x"));
    expect(res.status).toBe(404);
    expect(prisma.medicationScheduleRevision.delete).not.toHaveBeenCalled();
  });

  it("409s for a write-path archive", async () => {
    vi.mocked(prisma.medicationScheduleRevision.findUnique).mockResolvedValue({
      id: "rev-a",
      medicationId: "m1",
      source: "ARCHIVED",
    } as never);
    const res = await DELETE(deleteReq("rev-a"), deleteCtx("rev-a"));
    expect(res.status).toBe(409);
    expect(prisma.medicationScheduleRevision.delete).not.toHaveBeenCalled();
  });

  it("deletes a MANUAL era, restores a superseded original, and enqueues the rollup backfill", async () => {
    vi.mocked(prisma.medicationScheduleRevision.findUnique).mockResolvedValue({
      id: "rev-m",
      medicationId: "m1",
      source: "MANUAL",
    } as never);
    vi.mocked(prisma.medicationScheduleRevision.delete).mockResolvedValue(
      {} as never,
    );
    vi.mocked(prisma.medicationScheduleRevision.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    const res = await DELETE(deleteReq("rev-m"), deleteCtx("rev-m"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.deleted).toBe(true);
    expect(prisma.medicationScheduleRevision.delete).toHaveBeenCalledWith({
      where: { id: "rev-m" },
    });
    // If the deleted row was a correction, the archived original it
    // superseded becomes the era again.
    expect(prisma.medicationScheduleRevision.updateMany).toHaveBeenCalledWith({
      where: { medicationId: "m1", supersededByRevisionId: "rev-m" },
      data: { supersededByRevisionId: null },
    });
  });
});

describe("PATCH /api/medications/[id]/schedule-revisions/[revisionId]", () => {
  const PATCH_BODY = {
    validFrom: "2025-03-12T00:00:00.000Z",
    validUntil: "2025-06-01T00:00:00.000Z",
    timesOfDay: ["08:00", "20:00", "08:00"],
  };

  function mockTarget(overrides: Record<string, unknown> = {}) {
    vi.mocked(prisma.medicationScheduleRevision.findUnique).mockResolvedValue({
      id: "rev-t",
      medicationId: "m1",
      source: "MANUAL",
      supersededByRevisionId: null,
      validUntil: new Date("2025-06-01T00:00:00Z"),
      ...overrides,
    } as never);
  }

  it("404s when the revision belongs to another medication", async () => {
    mockTarget({ medicationId: "other-med" });
    const res = await PATCH(patchReq("rev-t", PATCH_BODY), deleteCtx("rev-t"));
    expect(res.status).toBe(404);
    expect(prisma.medicationScheduleRevision.update).not.toHaveBeenCalled();
  });

  it("409s when the era has already been corrected", async () => {
    mockTarget({ source: "ARCHIVED", supersededByRevisionId: "rev-fix" });
    const res = await PATCH(patchReq("rev-t", PATCH_BODY), deleteCtx("rev-t"));
    expect(res.status).toBe(409);
    expect(prisma.medicationScheduleRevision.update).not.toHaveBeenCalled();
    expect(prisma.medicationScheduleRevision.create).not.toHaveBeenCalled();
  });

  it("422s when the corrected era overlaps another active era", async () => {
    mockTarget();
    vi.mocked(prisma.medicationScheduleRevision.findMany).mockResolvedValue([
      {
        validFrom: new Date("2025-06-01T00:00:00Z"),
        validUntil: new Date("2025-08-01T00:00:00Z"),
      },
    ] as never);
    const res = await PATCH(
      patchReq("rev-t", {
        ...PATCH_BODY,
        validUntil: "2025-07-01T00:00:00.000Z",
      }),
      deleteCtx("rev-t"),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/overlap/i);
  });

  it("422s when the correction extends past the live boundary", async () => {
    // ARCHIVED era ending 2025-06-01, no other revisions; the live
    // ceiling is max(own recorded end, createdAt 2026-01-10) — a
    // correction reaching past it would swallow tracked live history.
    mockTarget({ source: "ARCHIVED" });
    const res = await PATCH(
      patchReq("rev-t", {
        ...PATCH_BODY,
        validUntil: "2026-02-01T00:00:00.000Z",
      }),
      deleteCtx("rev-t"),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/current plan/i);
  });

  it("updates a MANUAL era in place with the deduped snapshot", async () => {
    mockTarget();
    vi.mocked(prisma.medicationScheduleRevision.update).mockResolvedValue({
      id: "rev-t",
      validFrom: new Date(PATCH_BODY.validFrom),
      validUntil: new Date(PATCH_BODY.validUntil),
      source: "MANUAL",
    } as never);

    const res = await PATCH(patchReq("rev-t", PATCH_BODY), deleteCtx("rev-t"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe("rev-t");
    expect(json.data.entries[0].timesOfDay).toEqual(["08:00", "20:00"]);

    const updateArgs = vi.mocked(prisma.medicationScheduleRevision.update).mock
      .calls[0][0] as unknown as {
      where: { id: string };
      data: { payload: Array<{ timesOfDay: string[]; rrule: string }> };
    };
    expect(updateArgs.where.id).toBe("rev-t");
    expect(updateArgs.data.payload[0].timesOfDay).toEqual(["08:00", "20:00"]);
    expect(updateArgs.data.payload[0].rrule).toBe("FREQ=DAILY");
    // In-place — no superseding row is minted.
    expect(prisma.medicationScheduleRevision.create).not.toHaveBeenCalled();
    // Check-then-write ran inside the locked transaction.
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it("corrects an ARCHIVED era via a superseding MANUAL revision", async () => {
    mockTarget({ source: "ARCHIVED" });
    vi.mocked(prisma.medicationScheduleRevision.create).mockResolvedValue({
      id: "rev-fix",
      validFrom: new Date(PATCH_BODY.validFrom),
      validUntil: new Date(PATCH_BODY.validUntil),
      source: "MANUAL",
    } as never);
    vi.mocked(prisma.medicationScheduleRevision.update).mockResolvedValue(
      {} as never,
    );

    const res = await PATCH(patchReq("rev-t", PATCH_BODY), deleteCtx("rev-t"));
    expect(res.status).toBe(200);
    const json = await res.json();
    // The response carries the correction, which now takes the
    // original's place in every era read.
    expect(json.data.id).toBe("rev-fix");
    expect(json.data.source).toBe("MANUAL");

    const createArgs = vi.mocked(prisma.medicationScheduleRevision.create).mock
      .calls[0][0] as unknown as {
      data: { source: string; payload: Array<{ timesOfDay: string[] }> };
    };
    expect(createArgs.data.source).toBe("MANUAL");
    expect(createArgs.data.payload[0].timesOfDay).toEqual(["08:00", "20:00"]);
    // The ARCHIVED original is parked behind the correction, not
    // touched in its recorded content.
    expect(prisma.medicationScheduleRevision.update).toHaveBeenCalledWith({
      where: { id: "rev-t" },
      data: { supersededByRevisionId: "rev-fix" },
    });
  });
});
