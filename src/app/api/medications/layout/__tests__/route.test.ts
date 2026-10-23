/**
 * v1.16.10 — `/api/medications/layout` route.
 *
 * Mirrors the insights-layout test deck: GET returns the defaults for
 * users who have not saved a blob, PUT round-trips through the
 * serializer with preserve-when-absent semantics for `view` / `order`,
 * 422s carry the multi-issue envelope, DELETE returns the canonical
 * defaults.
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
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { __resetAuditDedupMemoForTests } from "@/lib/audit-dedup";
import { DEFAULT_MEDICATION_LIST_LAYOUT } from "@/lib/medication-list-layout";

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
  return new NextRequest("http://localhost/api/medications/layout", {
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

describe("GET /api/medications/layout", () => {
  it("returns the defaults when the user has no saved blob", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      medicationListLayoutJson: null,
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: typeof DEFAULT_MEDICATION_LIST_LAYOUT;
    };
    expect(body.data).toEqual(DEFAULT_MEDICATION_LIST_LAYOUT);
  });

  it("does not lazy-write a row on GET", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      medicationListLayoutJson: null,
    } as never);

    await callGet();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("returns the saved blob through the resolver", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      medicationListLayoutJson: {
        version: 1,
        view: "table",
        order: ["med-b", "med-a"],
      },
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { view: string; order: string[] };
    };
    expect(body.data.view).toBe("table");
    expect(body.data.order).toEqual(["med-b", "med-a"]);
  });

  it("collapses a malformed stored blob onto the defaults instead of failing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      medicationListLayoutJson: { view: "kanban", order: "nope" },
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { view: string; order: string[] };
    };
    expect(body.data.view).toBe("cards");
    expect(body.data.order).toEqual([]);
  });
});

describe("PUT /api/medications/layout — preserve-when-absent", () => {
  it("persists a full blob and echoes the normalised result", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({ version: 1, view: "table", order: ["med-a", "med-b"] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { version: number; view: string; order: string[] };
    };
    expect(body.data).toEqual({
      version: 1,
      view: "table",
      order: ["med-a", "med-b"],
      // v1.32.21 — the write now echoes the fresh optimistic-concurrency token.
      updatedAt: expect.any(String),
    });

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as {
      where: { id: string };
      data: { medicationListLayoutJson: unknown };
    };
    expect(call.where.id).toBe("user-1");
    expect(call.data.medicationListLayoutJson).toEqual({
      version: 1,
      view: "table",
      order: ["med-a", "med-b"],
    });
    // No stored-blob read needed — both fields were on the body.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("a view-only PUT preserves the stored manual order", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      medicationListLayoutJson: {
        version: 1,
        view: "cards",
        order: ["med-z", "med-a"],
      },
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(makeReq({ version: 1, view: "table" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { view: string; order: string[] };
    };
    expect(body.data.view).toBe("table");
    expect(body.data.order).toEqual(["med-z", "med-a"]);
  });

  it("an order-only PUT preserves the stored view", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      medicationListLayoutJson: { version: 1, view: "table", order: [] },
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({ version: 1, order: ["med-1", "med-2"] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { view: string; order: string[] };
    };
    expect(body.data.view).toBe("table");
    expect(body.data.order).toEqual(["med-1", "med-2"]);
  });

  it("dedupes a repeated id in the submitted order", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({ version: 1, view: "cards", order: ["a", "b", "a"] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { order: string[] } };
    expect(body.data.order).toEqual(["a", "b"]);
  });
});

describe("PUT /api/medications/layout — 422 multi-issue envelope", () => {
  it("rejects an unknown view and a malformed order in one envelope", async () => {
    const res = await callPut(
      makeReq({ version: 1, view: "kanban", order: [""] }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: { issues: Array<{ path: string }> };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    const paths = body.details.issues.map((i) => i.path);
    expect(paths.some((p) => p.startsWith("view"))).toBe(true);
    expect(paths.some((p) => p.startsWith("order"))).toBe(true);
  });

  it("rejects a wrong version", async () => {
    const res = await callPut(makeReq({ version: 2, view: "table" }));
    expect(res.status).toBe(422);
  });

  it("files no row for an owner's repeated refusals", async () => {
    const res1 = await callPut(makeReq({ version: 9 }));
    const res2 = await callPut(makeReq({ version: 9 }));
    expect(res1.status).toBe(422);
    expect(res2.status).toBe(422);

    await new Promise((r) => setTimeout(r, 5));

    // An owner's own refused request is not an audit event: `auditLog`
    // keeps it on the wide event and files no row.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/medications/layout", () => {
  it("clears the saved blob and returns the defaults", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callDelete();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: typeof DEFAULT_MEDICATION_LIST_LAYOUT;
    };
    expect(body.data).toEqual(DEFAULT_MEDICATION_LIST_LAYOUT);

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as {
      data: { medicationListLayoutJson: unknown };
    };
    expect(call.data.medicationListLayoutJson).toBeDefined();
  });
});

/**
 * v1.32.21 — optimistic concurrency (issue #581 family). A PUT carrying
 * the `baseUpdatedAt` it was based on writes CONDITIONALLY on the stored row
 * still carrying that token, so a view toggle can never resurrect an order the
 * reorder Save just committed (and vice versa). A tokenless PUT keeps the prior
 * unconditional write — the iOS-compat arm.
 */
describe("PUT /api/medications/layout — optimistic concurrency", () => {
  // A full blob (view + order) so no preserve-read fires; the only findUnique
  // is the post-write token read.
  function fullBody(baseUpdatedAt?: string) {
    return {
      version: 1,
      view: "table",
      order: ["med-a", "med-b"],
      ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
    };
  }

  it("guards the write on the base token and returns the advanced token", async () => {
    const base = new Date("2026-07-24T10:00:00.000Z");
    const advanced = new Date("2026-07-24T10:05:00.000Z");
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      updatedAt: advanced,
    } as never);

    const res = await callPut(makeReq(fullBody(base.toISOString())));
    expect(res.status).toBe(200);

    // Conditional write on the exact base token — never unconditional.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const whereArg = vi.mocked(prisma.user.updateMany).mock.calls[0]?.[0]
      ?.where as { id: string; updatedAt: Date };
    expect(whereArg.id).toBe("user-1");
    expect((whereArg.updatedAt as Date).toISOString()).toBe(base.toISOString());
    expect(prisma.user.update).not.toHaveBeenCalled();

    const body = (await res.json()) as { data: { updatedAt: string } };
    expect(body.data.updatedAt).toBe(advanced.toISOString());
  });

  it("interleaved writers: the stale-base second writer gets 409 and clobbers nothing", async () => {
    // Writer B committed first (updatedAt advanced); writer A replays with the
    // pre-B token → the conditional write matches zero rows.
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await callPut(makeReq(fullBody("2026-07-24T09:00:00.000Z")));
    expect(res.status).toBe(409);

    const body = (await res.json()) as {
      data: null;
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.data).toBeNull();
    expect(body.meta?.errorCode).toBe("medication_layout_conflict");

    // The conditional write matched no row; there is NO unconditional
    // fallback, so nothing was written — B's value survives.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("422s a malformed base token without touching the row", async () => {
    const res = await callPut(makeReq(fullBody("not-a-date")));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("keeps the unconditional write when the client omits the token (iOS compat)", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({
      updatedAt: new Date("2026-07-24T11:00:00.000Z"),
    } as never);

    const res = await callPut(makeReq(fullBody()));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    const body = (await res.json()) as { data: { updatedAt: string } };
    expect(body.data.updatedAt).toBe("2026-07-24T11:00:00.000Z");
  });
});
