/**
 * v1.4.43 — multi-issue 422 envelope on PUT /api/mood-entries/[id].
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type * as TagLinksModule from "@/lib/mood/tag-links";
const txClient = vi.hoisted(() => ({
  moodEntry: {
    update: vi.fn(),
  },
  moodEntryTagLink: {
    findMany: vi.fn(),
  },
  // v1.38 — the day context is replaced inside the same transaction. Answering
  // null from `findUnique` keeps this fake honest: what a context write
  // actually stores is proven against real Postgres in
  // `tests/integration/mood-context.test.ts`, not by a stub that agrees with
  // whatever it is asked.
  moodContext: {
    deleteMany: vi.fn(),
    upsert: vi.fn(),
    findUnique: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    moodEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    moodEntryTagLink: {
      findMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/mood/tag-links", async (importOriginal) => ({
  ...(await importOriginal<typeof TagLinksModule>()),
  replaceTagLinks: vi.fn(),
  replaceRatedFactorLinks: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMood: vi.fn(),
}));
vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeMoodBucketsForEntry: vi.fn().mockResolvedValue(undefined),
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

import { GET, PUT } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { getSession } from "@/lib/auth/session";
import {
  RatedFactorOutOfRangeError,
  replaceRatedFactorLinks,
  replaceTagLinks,
} from "@/lib/mood/tag-links";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const EXISTING_ENTRY = {
  id: "me1",
  userId: "user-1",
  date: "2026-06-01",
  mood: "OKAY",
  score: 3,
  tags: null,
  note: null,
  noteEncrypted: null,
  source: "MANUAL",
  moodLoggedAt: new Date("2026-06-01T08:00:00.000Z"),
  syncVersion: 7,
};

const UPDATED_ENTRY = {
  ...EXISTING_ENTRY,
  moodLoggedAt: new Date("2026-06-02T08:00:00.000Z"),
  syncVersion: 8,
};

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mood-entries/me1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ROUTE_CTX = { params: Promise.resolve({ id: "me1" }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  // v1.37.0 — the breadcrumb goes through `auditLog()` now; `resetAllMocks`
  // clears the factory's resolved value and the route chains `.catch()`.
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  vi.mocked(prisma.$transaction).mockImplementation(async (callback) =>
    callback(txClient as never),
  );
  txClient.moodEntry.update.mockResolvedValue(UPDATED_ENTRY as never);
  txClient.moodEntryTagLink.findMany.mockResolvedValue([]);
  txClient.moodContext.deleteMany.mockResolvedValue({ count: 0 });
  txClient.moodContext.findUnique.mockResolvedValue(null);
  vi.mocked(replaceTagLinks).mockResolvedValue([]);
  vi.mocked(replaceRatedFactorLinks).mockResolvedValue([]);
  // v1.7.0 sync — PUT now looks the row up via `findFirst` with a
  // `deletedAt: null` guard (refuses to resurrect-edit a tombstone).
  vi.mocked(prisma.moodEntry.findFirst).mockResolvedValue(
    EXISTING_ENTRY as never,
  );
  vi.mocked(prisma.moodEntry.findUnique).mockResolvedValue(
    EXISTING_ENTRY as never,
  );
});

describe("GET /api/mood-entries/[id] — the list's wire shape", () => {
  it("carries the structured tags and rated factors, as the list does", async () => {
    vi.mocked(prisma.moodEntry.findFirst).mockResolvedValue({
      ...EXISTING_ENTRY,
      tagLinks: [
        { rating: null, moodTag: { key: "sleep_good", kind: "BINARY" } },
        { rating: 4, moodTag: { key: "energy", kind: "RATED" } },
      ],
      context: null,
    } as never);

    const res = await GET(
      new NextRequest("http://localhost/api/mood-entries/me1"),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        tagKeys: string[];
        ratedFactors: Array<{ key: string; rating: number }>;
        tagLinks?: unknown;
      };
    };
    expect(body.data.tagKeys).toEqual(["sleep_good"]);
    expect(body.data.ratedFactors).toEqual([{ key: "energy", rating: 4 }]);
    // The join is projected, never shipped raw.
    expect(body.data.tagLinks).toBeUndefined();
    const findCall = vi.mocked(prisma.moodEntry.findFirst).mock.calls[0][0] as {
      include?: Record<string, unknown>;
    };
    expect(Object.keys(findCall.include ?? {}).sort()).toEqual([
      "context",
      "tagLinks",
    ]);
  });
});

describe("PUT /api/mood-entries/[id] — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad `mood` enum + bad `moodLoggedAt`.
    const res = await PUT(
      putReq({ mood: "junk", moodLoggedAt: "not-iso" }),
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
    // Bad mood + bad moodLoggedAt + bad note (too long).
    const res = await PUT(
      putReq({
        mood: "junk",
        moodLoggedAt: "not-iso",
        note: "x".repeat(2000),
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes a mood-entries.update.validation-failed audit row", async () => {
    const res = await PUT(
      putReq({ mood: "junk", moodLoggedAt: "not-iso" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(auditLog).toHaveBeenCalledTimes(1);
    const [auditAction, auditOpts] = vi.mocked(auditLog).mock.calls[0] as [
      string,
      { userId: string },
    ];
    const call = { data: { userId: auditOpts.userId, action: auditAction } };
    expect(call.data.action).toBe("mood-entries.update.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(auditLog).mockRejectedValueOnce(new Error("db down"));
    const res = await PUT(
      putReq({ mood: "junk", moodLoggedAt: "not-iso" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });
});

describe("PUT /api/mood-entries/[id] — split tag replacement", () => {
  it("preserves RATED links for a note/time/tagKeys-only edit", async () => {
    txClient.moodEntryTagLink.findMany.mockResolvedValue([
      { rating: null, moodTag: { key: "happy", kind: "BINARY" } },
      { rating: 4, moodTag: { key: "factor_work", kind: "RATED" } },
    ]);

    const res = await PUT(
      putReq({
        note: null,
        moodLoggedAt: "2026-06-02T08:00:00.000Z",
        tagKeys: ["happy"],
      }),
      ROUTE_CTX,
    );

    expect(res.status).toBe(200);
    expect(replaceTagLinks).toHaveBeenCalledWith(
      "me1",
      "user-1",
      ["happy"],
      txClient,
    );
    expect(replaceRatedFactorLinks).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      data: {
        tagKeys: string[];
        ratedFactors: Array<{ key: string; rating: number }>;
      };
      error: null;
    };
    expect(body.data.tagKeys).toEqual(["happy"]);
    expect(body.data.ratedFactors).toEqual([{ key: "factor_work", rating: 4 }]);
    expect(body.error).toBeNull();
  });

  it("preserves BINARY links and updates scores for a ratedFactors-only edit", async () => {
    txClient.moodEntryTagLink.findMany.mockResolvedValue([
      { rating: null, moodTag: { key: "happy", kind: "BINARY" } },
      { rating: 5, moodTag: { key: "factor_work", kind: "RATED" } },
    ]);

    const res = await PUT(
      putReq({ ratedFactors: [{ key: "factor_work", rating: 5 }] }),
      ROUTE_CTX,
    );

    expect(res.status).toBe(200);
    expect(replaceTagLinks).not.toHaveBeenCalled();
    expect(replaceRatedFactorLinks).toHaveBeenCalledWith(
      "me1",
      "user-1",
      [{ key: "factor_work", rating: 5 }],
      txClient,
    );
    const body = (await res.json()) as {
      data: {
        tagKeys: string[];
        ratedFactors: Array<{ key: string; rating: number }>;
      };
    };
    expect(body.data.tagKeys).toEqual(["happy"]);
    expect(body.data.ratedFactors).toEqual([{ key: "factor_work", rating: 5 }]);
  });

  it("returns 422 when a factor score is outside its catalog scale", async () => {
    vi.mocked(replaceRatedFactorLinks).mockRejectedValueOnce(
      new RatedFactorOutOfRangeError("factor_conflict", 5, 1, 2),
    );

    const res = await PUT(
      putReq({ ratedFactors: [{ key: "factor_conflict", rating: 5 }] }),
      ROUTE_CTX,
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      meta: { errorCode: string };
    };
    expect(body.data).toBeNull();
    expect(body.meta.errorCode).toBe("mood.ratedFactor.out_of_range");
  });

  it("rolls back the mood row, both link sets, and syncVersion when the second replacement fails", async () => {
    let persisted = {
      mood: "OKAY",
      syncVersion: 7,
      binary: ["happy"],
      rated: [{ key: "factor_work", rating: 2 }],
    };
    let draft = structuredClone(persisted);
    const transactionClient = {
      moodEntry: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (typeof data.mood === "string") draft.mood = data.mood;
          if (data.syncVersion) draft.syncVersion += 1;
          return UPDATED_ENTRY;
        }),
      },
      moodEntryTagLink: {
        findMany: vi.fn(),
      },
      moodContext: {
        deleteMany: vi.fn(),
        upsert: vi.fn(),
        findUnique: vi.fn(),
      },
    };
    vi.mocked(replaceTagLinks).mockImplementationOnce(async () => {
      draft.binary = ["calm"];
      return [];
    });
    vi.mocked(replaceRatedFactorLinks).mockImplementationOnce(async () => {
      draft.rated = [{ key: "factor_work", rating: 5 }];
      throw new Error("injected rated-link replacement failure");
    });
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (callback) => {
      draft = structuredClone(persisted);
      const result = await callback(transactionClient as never);
      persisted = draft;
      return result;
    });

    const res = await PUT(
      putReq({
        mood: "GUT",
        tagKeys: ["calm"],
        ratedFactors: [{ key: "factor_work", rating: 5 }],
      }),
      ROUTE_CTX,
    );

    expect(replaceTagLinks).toHaveBeenCalledTimes(1);
    expect(replaceRatedFactorLinks).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(persisted).toEqual({
      mood: "OKAY",
      syncVersion: 7,
      binary: ["happy"],
      rated: [{ key: "factor_work", rating: 2 }],
    });
  });

  it.each([{ ratedFactors: null }, { ratedFactors: [] }])(
    "clears RATED links for an explicit $ratedFactors",
    async (payload) => {
      const res = await PUT(putReq(payload), ROUTE_CTX);

      expect(res.status).toBe(200);
      expect(replaceRatedFactorLinks).toHaveBeenCalledWith(
        "me1",
        "user-1",
        [],
        txClient,
      );
    },
  );
});
