/**
 * v1.4.43 W6 — multi-issue 422 envelope on GET + POST /api/mood-entries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// v1.8.5 — the POST happy path writes the entry + its structured-tag
// links inside one `$transaction`. The mock hands the same client object
// to the interactive-transaction callback so the route's tx-scoped writes
// (entry create + tag-link read-back) resolve against the same fakes.
const txClient = {
  moodEntry: {
    create: vi.fn(),
    // v1.12.1 — the create path upserts on `(userId, source, externalId)`
    // when the body carries a source-stable id, so the tx client must
    // expose `upsert` too.
    upsert: vi.fn(),
  },
  moodEntryTagLink: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  // v1.38 — the day context is written inside the same transaction, and the
  // route reads it back for the response. A fake that answered a row here
  // regardless of what was written would prove nothing, so `findUnique`
  // answers null and the context-carrying claims live in the integration
  // suite (`tests/integration/mood-context.test.ts`) against real Postgres.
  moodContext: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    upsert: vi.fn(),
    findUnique: vi.fn().mockResolvedValue(null),
  },
};

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  // The shared single-record write ceiling. Allowed here: this file is about
  // what the handler does with a body it accepted, not about the bucket.
  checkRecordWriteRateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 300,
    remaining: 299,
    resetAt: Date.now() + 60_000,
  })),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    moodEntry: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
    },
    moodEntryTagLink: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: typeof txClient) => unknown) =>
      fn(txClient),
    ),
  },
}));

// v1.12.0 — keep the real `RatedFactorOutOfRangeError` so the route's
// `instanceof` 422 branch still matches when the mock throws it.
vi.mock("@/lib/mood/tag-links", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mood/tag-links")>(
    "@/lib/mood/tag-links",
  );
  return {
    createTagLinks: vi.fn().mockResolvedValue(undefined),
    RatedFactorOutOfRangeError: actual.RatedFactorOutOfRangeError,
  };
});

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
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

import { GET, POST } from "../route";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { createTagLinks } from "@/lib/mood/tag-links";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import { Prisma } from "@/generated/prisma/client";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function getReq(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/mood-entries?${qs}`);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mood-entries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  // v1.36.0 — the GET's validation breadcrumb goes through the `auditLog`
  // helper now, because that helper is the only writer that stamps
  // `actorUserId`. `resetAllMocks` clears the factory's implementation, so the
  // resolved promise the route attaches a `.catch` to is restored here.
  vi.mocked(auditLog).mockResolvedValue(undefined);
  // Re-establish the interactive-transaction passthrough after the reset.
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) =>
    (fn as (tx: typeof txClient) => unknown)(txClient),
  );
  txClient.moodEntryTagLink.findMany.mockResolvedValue([]);
  vi.mocked(createTagLinks).mockResolvedValue(undefined);
  // `reset` blanks the post-commit best-effort mock; restore the promise
  // return so `recompute(...)` awaits.
  vi.mocked(recomputeMoodBucketsForEntry).mockResolvedValue(undefined);
});

describe("GET /api/mood-entries — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad `mood` enum + bad `sortBy` enum.
    const res = await GET(getReq("mood=junk&sortBy=garbage"));
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
    // Bad mood + bad sortBy + bad sortDir.
    const res = await GET(getReq("mood=junk&sortBy=garbage&sortDir=upside"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; code: string }> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes a mood-entries.list.validation-failed audit row", async () => {
    const res = await GET(getReq("mood=junk&sortBy=garbage"));
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(auditLog).toHaveBeenCalledWith(
      "mood-entries.list.validation-failed",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(auditLog).mockRejectedValueOnce(new Error("db down"));
    const res = await GET(getReq("mood=junk&sortBy=garbage"));
    expect(res.status).toBe(422);
  });
});

describe("GET /api/mood-entries — source filter (v1.15.13)", () => {
  it("threads a valid source into the list where", async () => {
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.count).mockResolvedValue(0 as never);

    const res = await GET(getReq("source=TELEGRAM"));
    expect(res.status).toBe(200);

    const call = vi.mocked(prisma.moodEntry.findMany).mock.calls[0][0];
    expect(call?.where).toMatchObject({
      userId: "user-1",
      deletedAt: null,
      source: "TELEGRAM",
    });
  });

  it("omits source from the where when not supplied", async () => {
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.count).mockResolvedValue(0 as never);

    const res = await GET(getReq(""));
    expect(res.status).toBe(200);
    const call = vi.mocked(prisma.moodEntry.findMany).mock.calls[0][0];
    expect(call?.where).not.toHaveProperty("source");
  });

  it("422s on an unknown source value", async () => {
    const res = await GET(getReq("source=BOGUS"));
    expect(res.status).toBe(422);
  });
});

describe("POST /api/mood-entries — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad `mood` enum + missing `moodLoggedAt`.
    const res = await POST(postReq({ mood: "ecstatic-junk" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
      meta?: { errorCode?: string };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
    expect(body.meta?.errorCode).toBe("mood.create.invalid");
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    // Bad `mood` + bad `moodLoggedAt` + bad `note` (too long).
    const res = await POST(
      postReq({
        mood: "junk",
        moodLoggedAt: "definitely-not-iso",
        note: "x".repeat(2000),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes a mood-entries.create.validation-failed audit row", async () => {
    const res = await POST(postReq({ mood: "junk" }));
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    // v1.37.0 — the breadcrumb goes through `auditLog()`, the only writer
    // that stamps `actorUserId`.
    const breadcrumbs = vi
      .mocked(auditLog)
      .mock.calls.filter(([name]) => name.endsWith("validation-failed"));
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]?.[0]).toBe("mood-entries.create.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(auditLog).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(postReq({ mood: "junk" }));
    expect(res.status).toBe(422);
  });

  it("pins the duplicate-timestamp conflict code", async () => {
    txClient.moodEntry.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    const res = await POST(
      postReq({
        mood: "GUT",
        moodLoggedAt: "2026-07-10T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).meta?.errorCode).toBe("mood.duplicate_timestamp");
  });
});

describe("POST /api/mood-entries — entry + tag-links transaction (v1.8.5)", () => {
  const VALID_BODY = {
    mood: "GUT",
    moodLoggedAt: "2026-06-01T08:00:00.000Z",
    tagKeys: ["happy"],
  };

  it("writes the entry + tag links through the transaction client", async () => {
    txClient.moodEntry.create.mockResolvedValue({
      id: "mood-1",
      tags: null,
      moodLoggedAt: new Date(VALID_BODY.moodLoggedAt),
      mood: "GUT",
      note: null,
      source: "MANUAL",
      date: "2026-06-01",
    });

    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(201);
    // The tag-link write runs against the same `$transaction` client that
    // created the entry, so both commit (or roll back) together. The 4th
    // arg is the rated-factor set (empty here — binary tag only).
    expect(createTagLinks).toHaveBeenCalledWith(
      "mood-1",
      "user-1",
      ["happy"],
      txClient,
      [],
    );
  });

  it("returns the persisted tagKeys in the create response", async () => {
    txClient.moodEntry.create.mockResolvedValue({
      id: "mood-1",
      tags: null,
      moodLoggedAt: new Date(VALID_BODY.moodLoggedAt),
      mood: "GUT",
      note: null,
      source: "MANUAL",
      date: "2026-06-01",
    });
    txClient.moodEntryTagLink.findMany.mockResolvedValue([
      { moodTag: { key: "happy" } },
    ]);

    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; tagKeys: string[] };
    };
    // Read-after-write parity: the create response carries the same
    // `tagKeys` the list GET surfaces.
    expect(body.data.tagKeys).toEqual(["happy"]);
  });

  it("rolls the entry back when the tag-link write fails (no commit)", async () => {
    txClient.moodEntry.create.mockResolvedValue({
      id: "mood-2",
      tags: null,
      moodLoggedAt: new Date(VALID_BODY.moodLoggedAt),
      mood: "GUT",
      note: null,
      source: "MANUAL",
      date: "2026-06-01",
    });
    // A failing tag-link write must propagate out of the transaction so
    // Prisma aborts the entry create — the route surfaces it as a 5xx and
    // the entry is never committed (no audit row, no rollup recompute).
    vi.mocked(createTagLinks).mockRejectedValueOnce(new Error("link write"));

    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(500);

    const { auditLog } = await import("@/lib/auth/audit");
    expect(auditLog).not.toHaveBeenCalled();
    const { recomputeMoodBucketsForEntry } =
      await import("@/lib/rollups/mood-rollups");
    expect(recomputeMoodBucketsForEntry).not.toHaveBeenCalled();
  });
});

describe("POST /api/mood-entries — rated factors (v1.12.0)", () => {
  const ENTRY = {
    id: "mood-rf",
    tags: null,
    moodLoggedAt: new Date("2026-06-01T08:00:00.000Z"),
    mood: "GUT",
    note: null,
    source: "MANUAL",
    date: "2026-06-01",
  };

  it("threads ratedFactors into createTagLinks", async () => {
    txClient.moodEntry.create.mockResolvedValue(ENTRY);
    const body = {
      mood: "GUT",
      moodLoggedAt: "2026-06-01T08:00:00.000Z",
      tagKeys: ["happy"],
      ratedFactors: [{ key: "factor_work", rating: 4 }],
    };
    const res = await POST(postReq(body));
    expect(res.status).toBe(201);
    expect(createTagLinks).toHaveBeenCalledWith(
      "mood-rf",
      "user-1",
      ["happy"],
      txClient,
      [{ key: "factor_work", rating: 4 }],
    );
  });

  it("surfaces persisted rated factors split from binary tagKeys in the response", async () => {
    txClient.moodEntry.create.mockResolvedValue(ENTRY);
    // Read-back returns one binary link + one rated link; the route splits
    // them by `kind`.
    txClient.moodEntryTagLink.findMany.mockResolvedValue([
      { rating: null, moodTag: { key: "happy", kind: "BINARY" } },
      { rating: 4, moodTag: { key: "factor_work", kind: "RATED" } },
    ]);
    const res = await POST(
      postReq({
        mood: "GUT",
        moodLoggedAt: "2026-06-01T08:00:00.000Z",
        tagKeys: ["happy"],
        ratedFactors: [{ key: "factor_work", rating: 4 }],
      }),
    );
    expect(res.status).toBe(201);
    const out = (await res.json()) as {
      data: {
        tagKeys: string[];
        ratedFactors: { key: string; rating: number }[];
      };
    };
    expect(out.data.tagKeys).toEqual(["happy"]);
    expect(out.data.ratedFactors).toEqual([{ key: "factor_work", rating: 4 }]);
  });

  it("returns 422 with errorCode when a rating is out of the factor's scale", async () => {
    txClient.moodEntry.create.mockResolvedValue(ENTRY);
    const { RatedFactorOutOfRangeError } = await import("@/lib/mood/tag-links");
    vi.mocked(createTagLinks).mockRejectedValueOnce(
      new RatedFactorOutOfRangeError("factor_conflict", 5, 1, 2),
    );
    const res = await POST(
      postReq({
        mood: "GUT",
        moodLoggedAt: "2026-06-01T08:00:00.000Z",
        ratedFactors: [{ key: "factor_conflict", rating: 5 }],
      }),
    );
    expect(res.status).toBe(422);
    const out = (await res.json()) as { meta?: { errorCode?: string } };
    expect(out.meta?.errorCode).toBe("mood.ratedFactor.out_of_range");
  });

  it("rejects a non-integer / out-of-envelope rating at the Zod layer (422)", async () => {
    const res = await POST(
      postReq({
        mood: "GUT",
        moodLoggedAt: "2026-06-01T08:00:00.000Z",
        ratedFactors: [{ key: "factor_work", rating: 9 }],
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe("POST /api/mood-entries — externalId idempotent re-import (v1.12.1)", () => {
  it("upserts on (userId, source, externalId) when externalId is present", async () => {
    txClient.moodEntry.upsert.mockResolvedValue({
      id: "mood-ext",
      tags: null,
      moodLoggedAt: new Date("2026-06-01T08:00:00.000Z"),
      mood: "GUT",
      note: null,
      source: "MANUAL",
      externalId: "ios-uuid-1",
      date: "2026-06-01",
    });

    const res = await POST(
      postReq({
        mood: "GUT",
        moodLoggedAt: "2026-06-01T08:00:00.000Z",
        externalId: "ios-uuid-1",
      }),
    );
    expect(res.status).toBe(201);
    // The legacy `create` path is NOT taken when externalId is present.
    expect(txClient.moodEntry.create).not.toHaveBeenCalled();
    expect(txClient.moodEntry.upsert).toHaveBeenCalledTimes(1);
    const call = txClient.moodEntry.upsert.mock.calls[0]?.[0] as {
      where: {
        userId_source_externalId: {
          userId: string;
          source: string;
          externalId: string;
        };
      };
      create: { externalId: string; source: string };
    };
    expect(call.where.userId_source_externalId).toEqual({
      userId: "user-1",
      source: "MANUAL",
      externalId: "ios-uuid-1",
    });
    expect(call.create.externalId).toBe("ios-uuid-1");
  });

  it("echoes externalId back in the create response", async () => {
    txClient.moodEntry.upsert.mockResolvedValue({
      id: "mood-ext",
      tags: null,
      moodLoggedAt: new Date("2026-06-01T08:00:00.000Z"),
      mood: "GUT",
      note: null,
      source: "MANUAL",
      externalId: "ios-uuid-2",
      date: "2026-06-01",
    });
    const res = await POST(
      postReq({
        mood: "GUT",
        moodLoggedAt: "2026-06-01T08:00:00.000Z",
        externalId: "ios-uuid-2",
      }),
    );
    expect(res.status).toBe(201);
    const out = (await res.json()) as { data: { externalId: string } };
    expect(out.data.externalId).toBe("ios-uuid-2");
  });

  it("threads the upserted source into the dedup key for a non-MANUAL source", async () => {
    txClient.moodEntry.upsert.mockResolvedValue({
      id: "mood-ext",
      tags: null,
      moodLoggedAt: new Date("2026-06-01T08:00:00.000Z"),
      mood: "GUT",
      note: null,
      source: "DAYLIO",
      externalId: "daylio-7",
      date: "2026-06-01",
    });
    const res = await POST(
      postReq({
        mood: "GUT",
        moodLoggedAt: "2026-06-01T08:00:00.000Z",
        source: "DAYLIO",
        externalId: "daylio-7",
      }),
    );
    expect(res.status).toBe(201);
    const call = txClient.moodEntry.upsert.mock.calls[0]?.[0] as {
      where: { userId_source_externalId: { source: string } };
    };
    expect(call.where.userId_source_externalId.source).toBe("DAYLIO");
  });

  it("falls back to the legacy create when externalId is absent", async () => {
    txClient.moodEntry.create.mockResolvedValue({
      id: "mood-legacy",
      tags: null,
      moodLoggedAt: new Date("2026-06-01T08:00:00.000Z"),
      mood: "GUT",
      note: null,
      source: "MANUAL",
      externalId: null,
      date: "2026-06-01",
    });
    const res = await POST(
      postReq({ mood: "GUT", moodLoggedAt: "2026-06-01T08:00:00.000Z" }),
    );
    expect(res.status).toBe(201);
    expect(txClient.moodEntry.create).toHaveBeenCalledTimes(1);
    expect(txClient.moodEntry.upsert).not.toHaveBeenCalled();
  });

  it("rejects an over-long externalId at the Zod layer (422)", async () => {
    const res = await POST(
      postReq({
        mood: "GUT",
        moodLoggedAt: "2026-06-01T08:00:00.000Z",
        externalId: "x".repeat(121),
      }),
    );
    expect(res.status).toBe(422);
    expect(txClient.moodEntry.upsert).not.toHaveBeenCalled();
    expect(txClient.moodEntry.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/mood-entries — external-id stability floor", () => {
  const BASE = {
    mood: "GUT",
    moodLoggedAt: "2026-06-01T08:00:00.000Z",
  };

  /**
   * The create upserts on `(userId, source, externalId)` so a re-post with
   * the same id updates in place. A per-launch id defeats that and mints a
   * new entry every sync.
   */
  it("422s on an object-description externalId and writes nothing", async () => {
    const res = await POST(
      postReq({
        ...BASE,
        externalId: "<HKHealthConceptIdentifier: 0x12568db80>",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
      meta?: { errorCode?: string };
    };
    const issue = body.details.issues.find((i) => i.path === "externalId");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("stable across app restarts");
    expect(issue!.message).toContain("object description");
    expect(body.meta?.errorCode).toBe("mood.create.invalid");
    expect(txClient.moodEntry.upsert).not.toHaveBeenCalled();
    expect(txClient.moodEntry.create).not.toHaveBeenCalled();
  });

  it("422s on a bare memory-address externalId", async () => {
    const res = await POST(postReq({ ...BASE, externalId: "0x126b25160" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
    };
    expect(
      body.details.issues.some(
        (i) => i.path === "externalId" && i.message.includes("memory address"),
      ),
    ).toBe(true);
    expect(txClient.moodEntry.upsert).not.toHaveBeenCalled();
  });

  it("accepts the SwiftData row UUID the iOS client actually sends", async () => {
    txClient.moodEntry.upsert.mockResolvedValue({
      id: "mood-ext-1",
      tags: null,
      moodLoggedAt: new Date(BASE.moodLoggedAt),
      mood: "GUT",
      note: null,
      source: "MANUAL",
      date: "2026-06-01",
    });

    const res = await POST(
      postReq({
        ...BASE,
        externalId: "8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30",
      }),
    );
    expect(res.status).toBe(201);
    expect(txClient.moodEntry.upsert).toHaveBeenCalledTimes(1);
  });
});
