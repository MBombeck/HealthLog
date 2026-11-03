/**
 * v1.28 — `POST /api/nutrients/batch` + `GET /api/nutrients` real-Postgres
 * integration.
 *
 * Asserts the composite-PK contract the unit mocks can't pin:
 *   - a clean batch inserts one row per (user, day, nutrient)
 *   - a re-post replaces the day total in place (`updated`, no new row)
 *   - a unit-mismatched entry is skipped and never lands
 *   - the opt-in module gate refuses ingest AND read with 403
 *     `module.disabled` for an account that never opted in
 *   - the read endpoint folds stored rows into the window summary
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const OPTED_IN_USER = "user-nutrients";
const OPTED_OUT_USER = "user-nutrients-off";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

async function signIn(userId: string): Promise<void> {
  const session = await getPrismaClient().session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: OPTED_IN_USER,
      username: "nutrients-on",
      email: "nutrients-on@example.test",
      timezone: "Europe/Berlin",
      // Opt-in module: only an explicit `true` enables it.
      modulePreferencesJson: { nutrients: true },
    },
  });
  await getPrismaClient().user.create({
    data: {
      id: OPTED_OUT_USER,
      username: "nutrients-off",
      email: "nutrients-off@example.test",
      timezone: "Europe/Berlin",
    },
  });
  await signIn(OPTED_IN_USER);
});

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/nutrients/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function recentDay(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

interface BatchEnvelope {
  data: {
    processed: number;
    inserted: number;
    updated: number;
    skipped: Array<{ index: number; reason: string }>;
    entries: Array<{ index: number; status: string }>;
  };
}

describe("POST /api/nutrients/batch (real Postgres)", () => {
  it("inserts a clean batch — one row per (user, day, nutrient)", async () => {
    const { POST } = await import("@/app/api/nutrients/batch/route");
    const res = await POST(
      postReq({
        entries: [
          {
            day: recentDay(1),
            nutrient: "vitamin_d",
            unit: "ug",
            amount: 20,
            externalSourceVersion: "writer-1.0",
          },
          { day: recentDay(1), nutrient: "caffeine", unit: "mg", amount: 250 },
          { day: recentDay(2), nutrient: "caffeine", unit: "mg", amount: 400 },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as BatchEnvelope;
    expect(json.data.processed).toBe(3);
    expect(json.data.inserted).toBe(3);
    expect(json.data.updated).toBe(0);

    const stored = await getPrismaClient().nutrientIntakeDay.findMany({
      where: { userId: OPTED_IN_USER },
      orderBy: [{ nutrient: "asc" }, { day: "asc" }],
    });
    expect(stored).toHaveLength(3);
    expect(stored.map((r) => r.nutrient)).toEqual([
      "caffeine",
      "caffeine",
      "vitamin_d",
    ]);
    expect(stored[2].unit).toBe("ug");
    expect(stored[2].source).toBe("APPLE_HEALTH");
    expect(stored[2].externalSourceVersion).toBe("writer-1.0");
  });

  it("re-post replaces the day total in place (composite-PK upsert, status updated)", async () => {
    const { POST } = await import("@/app/api/nutrients/batch/route");
    const day = recentDay(1);

    await POST(
      postReq({
        entries: [{ day, nutrient: "water", unit: "ml", amount: 900 }],
      }),
    );
    // The steps pattern: the total grows as the day progresses.
    const res = await POST(
      postReq({
        entries: [{ day, nutrient: "water", unit: "ml", amount: 1800 }],
      }),
    );

    const json = (await res.json()) as BatchEnvelope;
    expect(json.data.inserted).toBe(0);
    expect(json.data.updated).toBe(1);
    expect(json.data.entries[0].status).toBe("updated");

    const stored = await getPrismaClient().nutrientIntakeDay.findMany({
      where: { userId: OPTED_IN_USER, nutrient: "water" },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].amount).toBe(1800);
  });

  it("skips a unit-mismatched entry without landing a row", async () => {
    const { POST } = await import("@/app/api/nutrients/batch/route");
    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(1), nutrient: "vitamin_d", unit: "mg", amount: 20 },
        ],
      }),
    );
    const json = (await res.json()) as BatchEnvelope;
    expect(json.data.skipped).toEqual([{ index: 0, reason: "unit_mismatch" }]);
    const count = await getPrismaClient().nutrientIntakeDay.count({
      where: { userId: OPTED_IN_USER },
    });
    expect(count).toBe(0);
  });

  // Before this, `nutrient.batch.ingest` audited only when
  // `inserted + updated > 0` — the ONLY durable record of the call — so a
  // batch where every entry was rejected left the exact same empty
  // AuditLog trail as a phone that never posted at all. An operator could
  // not tell the two apart from the durable record.
  it("records an audit-log row even when every entry is rejected", async () => {
    const { POST } = await import("@/app/api/nutrients/batch/route");
    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(1), nutrient: "vitamin_d", unit: "mg", amount: 20 },
          { day: recentDay(2), nutrient: "iron", unit: "mg", amount: 999 },
        ],
      }),
    );
    const json = (await res.json()) as BatchEnvelope;
    expect(json.data.inserted).toBe(0);
    expect(json.data.updated).toBe(0);
    expect(json.data.skipped).toHaveLength(2);

    const rows = await getPrismaClient().auditLog.findMany({
      where: { userId: OPTED_IN_USER, action: "nutrient.batch.ingest" },
    });
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details ?? "{}") as {
      processed: number;
      inserted: number;
      updated: number;
      skipped: number;
      skippedByReason: Record<string, number>;
    };
    expect(details).toMatchObject({
      processed: 2,
      inserted: 0,
      updated: 0,
      skipped: 2,
    });
    expect(details.skippedByReason).toMatchObject({
      unit_mismatch: 1,
      value_out_of_range: 1,
    });
  });

  it("refuses ingest 403 module.disabled for an account that never opted in", async () => {
    const { POST } = await import("@/app/api/nutrients/batch/route");
    cookieJar.clear();
    await signIn(OPTED_OUT_USER);

    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(1), nutrient: "iron", unit: "mg", amount: 12 },
        ],
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("module.disabled");
    const count = await getPrismaClient().nutrientIntakeDay.count({
      where: { userId: OPTED_OUT_USER },
    });
    expect(count).toBe(0);
  });
});

describe("GET /api/nutrients (real Postgres)", () => {
  it("folds stored rows into the catalog-ordered window summary", async () => {
    const { POST } = await import("@/app/api/nutrients/batch/route");
    const { GET } = await import("@/app/api/nutrients/route");

    await POST(
      postReq({
        entries: [
          { day: recentDay(2), nutrient: "caffeine", unit: "mg", amount: 400 },
          { day: recentDay(1), nutrient: "caffeine", unit: "mg", amount: 250 },
          { day: recentDay(1), nutrient: "vitamin_d", unit: "ug", amount: 20 },
        ],
      }),
    );

    const res = await GET(
      new NextRequest("http://localhost/api/nutrients?days=14"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        windowDays: number;
        nutrients: Array<{
          nutrient: string;
          latestDay: string;
          latestAmount: number;
          daysWithData: number;
        }>;
      };
    };
    expect(json.data.windowDays).toBe(14);
    expect(json.data.nutrients).toHaveLength(2);
    // Catalog order: vitamin_d before the caffeine tail entry.
    expect(json.data.nutrients[0].nutrient).toBe("vitamin_d");
    expect(json.data.nutrients[1]).toMatchObject({
      nutrient: "caffeine",
      latestDay: recentDay(1),
      latestAmount: 250,
      daysWithData: 2,
    });
  });

  it("refuses the read 403 module.disabled when the module is off", async () => {
    const { GET } = await import("@/app/api/nutrients/route");
    cookieJar.clear();
    await signIn(OPTED_OUT_USER);
    const res = await GET(new NextRequest("http://localhost/api/nutrients"));
    expect(res.status).toBe(403);
  });

  // The account holder's only signal that a sync ever arrived: when the
  // window is genuinely empty AND the most recent nutrient-batch call
  // landed nothing, the read surfaces why instead of a bare empty state.
  it("surfaces the last failed attempt when the window is genuinely empty", async () => {
    const { POST } = await import("@/app/api/nutrients/batch/route");
    const { GET } = await import("@/app/api/nutrients/route");

    await POST(
      postReq({
        entries: [
          { day: recentDay(1), nutrient: "vitamin_d", unit: "mg", amount: 20 },
        ],
      }),
    );

    const res = await GET(
      new NextRequest("http://localhost/api/nutrients?days=14"),
    );
    const json = (await res.json()) as {
      data: { nutrients: unknown[]; lastAttempt: { topReason: string } | null };
    };
    expect(json.data.nutrients).toHaveLength(0);
    expect(json.data.lastAttempt).toMatchObject({
      topReason: "unit_mismatch",
    });
  });

  it("omits lastAttempt entirely once the window has data", async () => {
    const { POST } = await import("@/app/api/nutrients/batch/route");
    const { GET } = await import("@/app/api/nutrients/route");

    await POST(
      postReq({
        entries: [
          { day: recentDay(1), nutrient: "caffeine", unit: "mg", amount: 250 },
        ],
      }),
    );

    const res = await GET(
      new NextRequest("http://localhost/api/nutrients?days=14"),
    );
    const json = (await res.json()) as {
      data: { nutrients: unknown[]; lastAttempt: unknown };
    };
    expect(json.data.nutrients).toHaveLength(1);
    expect(json.data.lastAttempt).toBeNull();
  });

  // A last attempt that actually SUCCEEDED must never be reframed as a
  // failure just because the window is empty for an unrelated reason
  // (here: the stored row was removed after the fact). Showing a failure
  // notice over a real success is the exact false claim this feature
  // exists to prevent.
  it("stays silent when the last recorded attempt succeeded, even if the window is now empty", async () => {
    const { POST } = await import("@/app/api/nutrients/batch/route");
    const { GET } = await import("@/app/api/nutrients/route");

    await POST(
      postReq({
        entries: [
          { day: recentDay(1), nutrient: "caffeine", unit: "mg", amount: 250 },
        ],
      }),
    );
    await getPrismaClient().nutrientIntakeDay.deleteMany({
      where: { userId: OPTED_IN_USER },
    });

    const res = await GET(
      new NextRequest("http://localhost/api/nutrients?days=14"),
    );
    const json = (await res.json()) as {
      data: { nutrients: unknown[]; lastAttempt: unknown };
    };
    expect(json.data.nutrients).toHaveLength(0);
    expect(json.data.lastAttempt).toBeNull();
  });
});
