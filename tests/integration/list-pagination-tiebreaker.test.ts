/**
 * Offset pagination over a tied sort key must not repeat or drop a row.
 *
 * `/api/measurements` and `/api/labs` page with `skip`/`take` over a single
 * non-unique column. Ties are the normal case on both: an Apple Health import
 * stamps long runs of samples with one instant and the documented
 * `stats:<identifier>:YYYY-MM-DD` rollup convention puts every daily total at
 * the same one, while a lab panel drawn in one sitting shares `takenAt` across
 * every analyte in it. Without a unique secondary key Postgres may order the
 * tied block differently for the query that fetches page N and the one that
 * fetches page N+1, so a client mirroring its own history silently receives
 * one row twice and never receives another. For a health record that is a
 * data-integrity bug, and it is invisible to both sides.
 *
 * The fixtures are seeded with explicit ids in a deliberately scrambled order,
 * so heap order and id order disagree. That is what makes this a real gate:
 * asserting only that two pages are disjoint would pass on an unordered scan
 * that happened to be stable, whereas the id ordering inside a tied block can
 * only hold if the secondary sort key is actually there.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-pagination-tiebreaker";
const TIED_AT = new Date("2026-03-04T09:00:00.000Z");

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Insertion order deliberately unrelated to id order: 04, 09, 01, 06, 00, …
 * A scan that ignores the secondary key returns this sequence; one that
 * honours it returns 09, 08, 07, … on a descending sort.
 */
const SCRAMBLED = [4, 9, 1, 6, 0, 8, 3, 7, 2, 5];

/**
 * One type per row. The partial unique index on
 * `(user_id, type, measured_at, source, sleep_stage)` forbids two live rows of
 * the SAME type at one instant, so the tie that actually occurs in production
 * is the cross-type one: a daily `stats:` rollup posts steps, distance,
 * flights, active energy and the rest at the identical timestamp, and an
 * unfiltered history list pages straight through the block.
 */
const TYPES = [
  "ACTIVITY_STEPS",
  "FLIGHTS_CLIMBED",
  "WALKING_RUNNING_DISTANCE",
  "ACTIVE_ENERGY_BURNED",
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "OXYGEN_SATURATION",
  "RESPIRATORY_RATE",
  "BODY_TEMPERATURE",
  "WEIGHT",
] as const;

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "pagination-tiebreaker",
      email: "pagination-tiebreaker@example.test",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);

  // Every row shares one `measuredAt` / `takenAt` — the whole page is one
  // tied block, which is the worst case and the realistic one.
  for (const n of SCRAMBLED) {
    const suffix = String(n).padStart(2, "0");
    await prisma.measurement.create({
      data: {
        id: `tie-measurement-${suffix}`,
        userId: TEST_USER_ID,
        type: TYPES[n],
        value: 80 + n,
        unit: "count",
        measuredAt: TIED_AT,
        source: "APPLE_HEALTH",
      },
    });
    await prisma.labResult.create({
      data: {
        id: `tie-lab-${suffix}`,
        userId: TEST_USER_ID,
        analyte: `Analyte ${suffix}`,
        value: 1 + n,
        unit: "mg/dl",
        takenAt: TIED_AT,
      },
    });
  }
});

function get(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

async function idsOf(
  res: Response,
  key: "measurements" | "results",
): Promise<string[]> {
  const body = (await res.json()) as {
    data: Record<string, Array<{ id: string }>>;
  };
  return body.data[key].map((row) => row.id);
}

describe("offset pagination over a tied sort key (real Postgres)", () => {
  it("pages /api/measurements with no duplicate and no gap", async () => {
    const { GET } = await import("@/app/api/measurements/route");

    const first = await idsOf(
      await GET(get("/api/measurements?limit=4&offset=0") as never),
      "measurements",
    );
    const second = await idsOf(
      await GET(get("/api/measurements?limit=4&offset=4") as never),
      "measurements",
    );
    const third = await idsOf(
      await GET(get("/api/measurements?limit=4&offset=8") as never),
      "measurements",
    );

    const seen = [...first, ...second, ...third];
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
    expect([...seen].sort()).toEqual(
      SCRAMBLED.map((n) => `tie-measurement-${String(n).padStart(2, "0")}`)
        .slice()
        .sort(),
    );

    // The default sort is `measuredAt desc`; with every row tied, the
    // tiebreaker is the only thing deciding the order, so it must be
    // strictly descending by id across the page boundaries.
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("pages /api/labs with no duplicate and no gap", async () => {
    const { GET } = await import("@/app/api/labs/route");

    const first = await idsOf(
      await GET(get("/api/labs?limit=4&offset=0") as never),
      "results",
    );
    const second = await idsOf(
      await GET(get("/api/labs?limit=4&offset=4") as never),
      "results",
    );
    const third = await idsOf(
      await GET(get("/api/labs?limit=4&offset=8") as never),
      "results",
    );

    const seen = [...first, ...second, ...third];
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("keeps the ascending direction stable too", async () => {
    const { GET } = await import("@/app/api/measurements/route");

    const first = await idsOf(
      await GET(get("/api/measurements?limit=5&offset=0&sortDir=asc") as never),
      "measurements",
    );
    const second = await idsOf(
      await GET(get("/api/measurements?limit=5&offset=5&sortDir=asc") as never),
      "measurements",
    );

    const seen = [...first, ...second];
    expect(new Set(seen).size).toBe(10);
    expect(seen).toEqual([...seen].sort());
  });
});
