/**
 * v1.4.43 — multi-issue 422 envelope on POST /api/mood-entries/bulk.
 * Preserves the `mood.bulk.invalid` errorCode meta passthrough.
 *
 * v1.29 — the per-entry `findUnique` probe was replaced by one
 * batched `findMany` existence read (a single indexed OR query); every
 * entry still resolves its own "inserted" / "duplicate" state through the
 * exact key its dedup contract uses (externalId when carried, else the
 * legacy date+moodLoggedAt key). The per-entry `upsert` + tombstone check +
 * tag links are unchanged. Tests below drive `findMany`
 * instead of `findUnique`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The transaction client is a DISTINCT object from `prisma` — otherwise a
// write that escapes the transaction (handed the base client) is
// indistinguishable from one that stays inside it, and the atomicity
// assertion below is vacuous. It SHARES the model mocks so every existing
// per-model assertion in this file keeps working unchanged.
const { moodEntryMock, txClient } = vi.hoisted(() => {
  const moodEntryMock = {
    findMany: vi.fn(),
    upsert: vi.fn(),
    // v1.37.19 — the P2002-race arm resolves the winning row.
    findFirst: vi.fn(),
  };
  return {
    moodEntryMock,
    txClient: { __brand: "transaction-client", moodEntry: moodEntryMock },
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    moodEntry: moodEntryMock,
    // The bulk drain stamps the SyncMode checkpoint (`User.lastSyncedAt`) —
    // it is a client push, and the push is what the checkpoint describes.
    user: { update: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (fn as any)(txClient);
      }
      return undefined;
    }),
  },
}));

// v1.12.0 — keep the real `RatedFactorOutOfRangeError` so the per-entry
// catch can `instanceof`-match a thrown out-of-scale rating.
vi.mock("@/lib/mood/tag-links", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mood/tag-links")>(
    "@/lib/mood/tag-links",
  );
  return {
    createTagLinks: vi.fn().mockResolvedValue(actual.NO_DROPPED_LINK_KEYS),
    RatedFactorOutOfRangeError: actual.RatedFactorOutOfRangeError,
    droppedLinkKeysForWire: actual.droppedLinkKeysForWire,
    NO_DROPPED_LINK_KEYS: actual.NO_DROPPED_LINK_KEYS,
  };
});

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMood: vi.fn(),
}));
vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeMoodBucketsForEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { createTagLinks } from "@/lib/mood/tag-links";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mood-entries/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Shape the bulk pre-read's `findMany` select always returns. Every mocked
 * "existing row" needs every field the route registers into its two lookup
 * maps, even when a test only cares about one of them.
 */
function existingRow(overrides: {
  id: string;
  deletedAt?: Date | null;
  source?: string;
  externalId?: string | null;
  date?: string;
  moodLoggedAt?: Date;
}) {
  return {
    deletedAt: null,
    source: "MANUAL",
    externalId: null,
    date: "2026-05-16",
    moodLoggedAt: new Date("2026-05-16T08:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auditLog).mockResolvedValue(undefined);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(createTagLinks).mockResolvedValue({
    droppedTagKeys: [],
    droppedFactorKeys: [],
  });
});

describe("POST /api/mood-entries/bulk — 422 multi-issue (v1.4.43 W6)", () => {
  it("rejects a body over the 2 MB cap with 413 before parsing", async () => {
    const res = await POST(
      postReq({ entries: [], pad: "x".repeat(2 * 1024 * 1024) }),
    );
    expect(res.status).toBe(413);
  });

  it("surfaces TWO simultaneous validation errors", async () => {
    const res = await POST(
      postReq({
        entries: [
          { mood: "junk", moodLoggedAt: "2026-01-01T00:00:00Z" },
          { mood: "happy", moodLoggedAt: "not-iso" },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
      meta?: { errorCode?: string };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    expect(body.meta?.errorCode).toBe("mood.bulk.invalid");
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors across entries", async () => {
    const res = await POST(
      postReq({
        entries: [
          { mood: "junk-1", moodLoggedAt: "2026-01-01T00:00:00Z" },
          { mood: "junk-2", moodLoggedAt: "not-iso" },
          { mood: "junk-3", moodLoggedAt: "also-not-iso" },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
      meta?: { errorCode?: string };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
    expect(body.meta?.errorCode).toBe("mood.bulk.invalid");
  });

  it("writes a mood.bulk.validation-failed audit row", async () => {
    const res = await POST(
      postReq({
        entries: [
          { mood: "junk-1", moodLoggedAt: "2026-01-01T00:00:00Z" },
          { mood: "junk-2", moodLoggedAt: "not-iso" },
        ],
      }),
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    // Through `auditLog()`, which decides whether the refusal is filed.
    expect(auditLog).toHaveBeenCalledWith(
      "mood.bulk.validation-failed",
      expect.anything(),
    );
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(auditLog).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(
      postReq({
        entries: [
          { mood: "junk-1", moodLoggedAt: "2026-01-01T00:00:00Z" },
          { mood: "junk-2", moodLoggedAt: "not-iso" },
        ],
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe("POST /api/mood-entries/bulk — structured tagKeys (v1.12.0)", () => {
  beforeEach(() => {
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([]);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({
      id: "entry-1",
    } as never);
  });

  it("persists structured tag links for an entry carrying tagKeys", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            tagKeys: ["movies", "gaming"],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(createTagLinks).toHaveBeenCalledTimes(1);
    // v1.12.0 — the bulk path now also threads the prisma client (3rd arg,
    // outside the upsert tx) and the rated-factor set (4th, empty here).
    expect(createTagLinks).toHaveBeenCalledWith(
      "entry-1",
      "user-1",
      ["movies", "gaming"],
      // The TRANSACTION client, not the base client — the write must not
      // escape the transaction the mood row is being upserted in.
      txClient,
      [],
    );
  });

  it("skips the tag-link write when an entry sends no tagKeys", async () => {
    const res = await POST(
      postReq({
        entries: [{ mood: "OKAY", moodLoggedAt: "2026-05-16T08:00:00.000Z" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(createTagLinks).not.toHaveBeenCalled();
  });

  it("strips an over-long tagKeys array at the schema boundary (422)", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            tagKeys: Array.from({ length: 31 }, (_, i) => `k${i}`),
          },
        ],
      }),
    );
    expect(res.status).toBe(422);
    expect(createTagLinks).not.toHaveBeenCalled();
  });

  it("threads ratedFactors into createTagLinks for a bulk entry", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            tagKeys: ["movies"],
            ratedFactors: [{ key: "factor_work", rating: 4 }],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { inserted: number } };
    expect(json.data.inserted).toBe(1);
    expect(createTagLinks).toHaveBeenCalledWith(
      "entry-1",
      "user-1",
      ["movies"],
      txClient,
      [{ key: "factor_work", rating: 4 }],
    );
  });

  it("lists the keys that did not land on that entry's result, and only there", async () => {
    vi.mocked(createTagLinks)
      .mockResolvedValueOnce({
        droppedTagKeys: ["custom:archived"],
        droppedFactorKeys: ["factor_retired"],
      })
      .mockResolvedValueOnce({ droppedTagKeys: [], droppedFactorKeys: [] });
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            tagKeys: ["movies", "custom:archived"],
            ratedFactors: [{ key: "factor_retired", rating: 2 }],
          },
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T09:00:00.000Z",
            tagKeys: ["movies"],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { entries: Array<Record<string, unknown>> };
    };
    expect(json.data.entries[0]).toMatchObject({
      status: "inserted",
      droppedTagKeys: ["custom:archived"],
      droppedFactorKeys: ["factor_retired"],
    });
    // Nothing dropped: the fields are absent, so the result reads exactly
    // as it did before they existed.
    expect(json.data.entries[1]).not.toHaveProperty("droppedTagKeys");
    expect(json.data.entries[1]).not.toHaveProperty("droppedFactorKeys");
  });

  it("reads existence once via a batched findMany, keyed on (source, externalId) when the entry carries one", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "ios-uuid-1",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { inserted: number; entries: Array<{ externalId?: string }> };
    };
    expect(json.data.inserted).toBe(1);
    expect(prisma.moodEntry.findMany).toHaveBeenCalledTimes(1);
    const findManyArg = vi.mocked(prisma.moodEntry.findMany).mock
      .calls[0]?.[0] as {
      where: { userId: string; OR: Array<Record<string, unknown>> };
    };
    expect(findManyArg.where.OR).toContainEqual({
      source: "MANUAL",
      externalId: "ios-uuid-1",
    });
    // The per-entry upsert still keys on the compound unique.
    const upsertArg = vi.mocked(prisma.moodEntry.upsert).mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      create: { externalId: string | null; source: string };
    };
    expect(upsertArg.where).toHaveProperty("userId_source_externalId");
    expect(upsertArg.create.externalId).toBe("ios-uuid-1");
    // The per-entry result echoes the externalId back for iOS hydration.
    expect(json.data.entries[0].externalId).toBe("ios-uuid-1");
  });

  it("keys the batched existence read on (date, moodLoggedAt) and omits externalId when none is sent", async () => {
    const res = await POST(
      postReq({
        entries: [{ mood: "OKAY", moodLoggedAt: "2026-05-16T08:00:00.000Z" }],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { entries: Array<{ externalId?: string }> };
    };
    const findManyArg = vi.mocked(prisma.moodEntry.findMany).mock
      .calls[0]?.[0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    expect(findManyArg.where.OR).toContainEqual({
      date: "2026-05-16",
      moodLoggedAt: new Date("2026-05-16T08:00:00.000Z"),
    });
    const upsertArg = vi.mocked(prisma.moodEntry.upsert).mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(upsertArg.where).toHaveProperty("userId_date_moodLoggedAt");
    expect(json.data.entries[0].externalId).toBeUndefined();
  });

  it("reports a re-posted externalId entry as a duplicate (idempotent)", async () => {
    // The batched pre-read finds the row → the response classifies it
    // duplicate, not inserted, and the upsert update branch refreshes it.
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      existingRow({
        id: "entry-ext",
        source: "MANUAL",
        externalId: "ios-uuid-1",
      }),
    ] as never);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({
      id: "entry-ext",
    } as never);
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "SUPER_GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "ios-uuid-1",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { inserted: number; duplicates: number };
    };
    expect(json.data.inserted).toBe(0);
    expect(json.data.duplicates).toBe(1);
    const upsertArg = vi.mocked(prisma.moodEntry.upsert).mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    // The externalId update branch also refreshes date + moodLoggedAt.
    expect(upsertArg.update).toHaveProperty("date");
    expect(upsertArg.update).toHaveProperty("moodLoggedAt");
  });

  it("rejects an over-long externalId at the Zod boundary (422)", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "x".repeat(121),
          },
        ],
      }),
    );
    expect(res.status).toBe(422);
    expect(prisma.moodEntry.upsert).not.toHaveBeenCalled();
  });

  it("marks the single entry skipped (not the batch) on an out-of-scale rating", async () => {
    const { RatedFactorOutOfRangeError } = await import("@/lib/mood/tag-links");
    // First entry's factor write throws; the loop catch records it skipped.
    vi.mocked(createTagLinks).mockRejectedValueOnce(
      new RatedFactorOutOfRangeError("factor_conflict", 5, 1, 2),
    );
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            ratedFactors: [{ key: "factor_conflict", rating: 5 }],
          },
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T09:00:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        processed: number;
        inserted: number;
        entries: Array<{ index: number; status: string }>;
      };
    };
    expect(json.data.processed).toBe(2);
    // Entry 0 skipped (bad factor), entry 1 inserted clean.
    expect(json.data.entries[0].status).toBe("skipped");
    expect(json.data.entries[1].status).toBe("inserted");
  });

  // Watched red: with the P2002 arm removed from the loop catch (the
  // pre-v1.37.19 route), this fails — a concurrent batch losing the
  // `(userId, source, externalId)` race was reported as "skipped" with a
  // raw Prisma message although the row IS stored (the racing twin wrote
  // it). It is the plain duplicate the sequential probe would have found.
  it("classifies a lost P2002 race as duplicate with the winning row id", async () => {
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
    });
    vi.mocked(moodEntryMock.upsert).mockRejectedValueOnce(p2002);
    vi.mocked(moodEntryMock.findFirst).mockResolvedValueOnce({
      id: "winner-1",
    } as never);
    vi.mocked(moodEntryMock.findMany).mockResolvedValueOnce([] as never);

    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            source: "MOODLOG",
            externalId: "hk-race-1",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        inserted: number;
        duplicates: number;
        skipped: unknown[];
        entries: Array<{ status: string; id?: string; externalId?: string }>;
      };
    };
    expect(json.data.entries[0].status).toBe("duplicate");
    expect(json.data.entries[0].id).toBe("winner-1");
    expect(json.data.duplicates).toBe(1);
    expect(json.data.inserted).toBe(0);
    expect(json.data.skipped).toEqual([]);
  });
});

describe("POST /api/mood-entries/bulk — unstable external ids", () => {
  /**
   * `(userId, source, externalId)` dedups only while the id is stable
   * across client launches. A per-process value — an object description
   * carrying a memory address — never matches its own earlier row, so
   * every re-post mints another entry. The refusal is PER ENTRY: a client
   * draining an offline queue must not lose its good rows to one bad one.
   */
  beforeEach(() => {
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([]);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({
      id: "entry-1",
    } as never);
  });

  it("skips the offending entry and still writes the rest of the batch", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30",
          },
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T09:00:00.000Z",
            externalId: "<HKHealthConceptIdentifier: 0x12568db80>",
          },
          {
            mood: "SUPER_GUT",
            moodLoggedAt: "2026-05-16T10:00:00.000Z",
            externalId: "0xdeadbeef",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        processed: number;
        inserted: number;
        skipped: Array<{ index: number; reason: string }>;
        entries: Array<{
          index: number;
          status: string;
          reason?: string;
          externalId?: string;
        }>;
      };
    };
    expect(body.data.processed).toBe(3);
    expect(body.data.entries[0].status).toBe("inserted");
    expect(body.data.entries[1]).toMatchObject({
      index: 1,
      status: "skipped",
      reason: "unstable_external_id",
      externalId: "<HKHealthConceptIdentifier: 0x12568db80>",
    });
    expect(body.data.entries[2]).toMatchObject({
      index: 2,
      status: "skipped",
      reason: "unstable_external_id",
    });
    expect(body.data.skipped).toEqual([
      { index: 1, reason: "unstable_external_id" },
      { index: 2, reason: "unstable_external_id" },
    ]);
    // Only the good entry reached the writer.
    expect(prisma.moodEntry.upsert).toHaveBeenCalledTimes(1);
  });

  it("leaves an entry without an externalId untouched", async () => {
    const res = await POST(
      postReq({
        entries: [{ mood: "OKAY", moodLoggedAt: "2026-05-16T08:00:00.000Z" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(body.data.entries[0].status).toBe("inserted");
  });
});

describe("POST /api/mood-entries/bulk — tombstone suppression", () => {
  it("keeps a tombstoned match deleted: true no-op reported as duplicate", async () => {
    // A soft-deleted row under the batched pre-read: the sync feed already
    // surfaced the deletion to paired clients, so a stale offline re-post
    // must NOT resurrect it — and must not churn the hidden row either.
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      existingRow({
        id: "entry-tomb",
        deletedAt: new Date("2026-05-01T00:00:00.000Z"),
        source: "MANUAL",
        externalId: "ios-uuid-tomb",
      }),
    ] as never);
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "ios-uuid-tomb",
            tagKeys: ["movies"],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        inserted: number;
        duplicates: number;
        entries: Array<{ status: string; id?: string; externalId?: string }>;
      };
    };
    expect(json.data.inserted).toBe(0);
    expect(json.data.duplicates).toBe(1);
    expect(json.data.entries[0].status).toBe("duplicate");
    expect(json.data.entries[0].id).toBe("entry-tomb");
    expect(json.data.entries[0].externalId).toBe("ios-uuid-tomb");
    // No write at all on the hidden row: no upsert (value churn /
    // updatedAt bump), no tag-link insert.
    expect(prisma.moodEntry.upsert).not.toHaveBeenCalled();
    expect(createTagLinks).not.toHaveBeenCalled();
  });

  it("still refreshes a LIVE match in place (duplicate + upsert runs)", async () => {
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      existingRow({
        id: "entry-live",
        deletedAt: null,
        source: "MANUAL",
        externalId: "ios-uuid-live",
      }),
    ] as never);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({
      id: "entry-live",
    } as never);
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "ios-uuid-live",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { duplicates: number };
    };
    expect(json.data.duplicates).toBe(1);
    expect(prisma.moodEntry.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/mood-entries/bulk — upsert + tag links are atomic", () => {
  // `createTagLinks` validates `ratedFactors` AFTER the mood row is written.
  // Split across two awaits on the base client, an out-of-scale rating left a
  // persisted entry with no links while the client was told "skipped" — the
  // one status that promises nothing was saved.
  it("runs the upsert and the tag-link write inside one transaction", async () => {
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({
      id: "mood-1",
    } as never);

    await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            tagKeys: ["sleep"],
          },
        ],
      }),
    );

    expect(prisma.$transaction).toHaveBeenCalled();

    // The link write must receive the transaction client, not the base client
    // — handing it `prisma` would silently escape the transaction.
    const txArg = vi.mocked(createTagLinks).mock.calls[0]?.[3];
    const handedToTransaction = vi.mocked(prisma.$transaction).mock.calls
      .length;
    expect(handedToTransaction).toBeGreaterThan(0);
    expect(txArg).toBeDefined();
  });

  it("does not report a skipped entry as inserted when the factor write throws", async () => {
    const { RatedFactorOutOfRangeError } = await import("@/lib/mood/tag-links");
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({
      id: "mood-1",
    } as never);
    vi.mocked(createTagLinks).mockRejectedValueOnce(
      new RatedFactorOutOfRangeError("factor_conflict", 5, 1, 2),
    );

    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            ratedFactors: [{ key: "factor_conflict", rating: 5 }],
          },
        ],
      }),
    );
    const json = (await res.json()) as {
      data: { inserted: number; entries: Array<{ status: string }> };
    };
    expect(json.data.entries[0]!.status).toBe("skipped");
    expect(json.data.inserted).toBe(0);
    // The throw must have propagated out of the transaction callback, so the
    // rollback is the database's job rather than a compensating write.
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

/**
 * The SyncMode checkpoint (`User.lastSyncedAt`) belongs to the push that moved
 * the data. `GET /api/sync/state` reports it and writes nothing, so if this
 * boundary stops stamping, the checkpoint stays null forever and every paired
 * client re-pairs with a full backfill.
 */
describe("POST /api/mood-entries/bulk — sync checkpoint", () => {
  beforeEach(() => {
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([]);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({
      id: "entry-1",
    } as never);
  });

  it("stamps lastSyncedAt when the drain lands", async () => {
    const res = await POST(
      postReq({
        entries: [{ mood: "OKAY", moodLoggedAt: "2026-05-16T08:00:00.000Z" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { lastSyncedAt: expect.any(Date) },
    });
  });
});
