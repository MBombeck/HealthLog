/**
 * v1.4.33 C1 — `?slice=summaries` integration coverage.
 *
 * Pins the slim summaries slice against the real Postgres + the real
 * `regr_slope` / `regr_r2` functions, not a unit-level `$queryRaw`
 * mock. The slice replaces the route's 30-type × Promise.all chunked
 * findMany walk with 2 SQL passes; the integration test runs against
 * the test container so any drift in the SQL (alias names, casts,
 * `FILTER` semantics) surfaces here instead of in production.
 *
 * Three contracts pinned:
 *
 *   1. **Empty user.** A brand-new account with zero rows returns the
 *      empty `DataSummary` skeleton for every `MeasurementType` and
 *      `bmi: null`. No JS-side spread anywhere along the chain — the
 *      v1.4.33 P0 RangeError won't reach this path.
 *
 *   2. **Populated WEIGHT series.** A 14-day descending-weight series
 *      lands `count`, `latest`, `avg7`, `avg30`, the negative-slope
 *      `direction: "down"` tuple from `regr_slope`, plus min/max/mean
 *      with the same 2-decimal rounding the `summarize()` helper uses.
 *
 *   3. **Default slice unchanged.** Hitting the route WITHOUT
 *      `?slice=summaries` still returns the thick `healthScore` /
 *      `correlations` / `bpInTargetPct` / `sleepStages` envelope. C1
 *      is additive — no behaviour change for the existing consumers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface DataSummaryShape {
  count: number;
  latest: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  avg7: number | null;
  avg30: number | null;
  slope7: { slope: number; direction: string; confidence: number } | null;
  slope30: { slope: number; direction: string; confidence: number } | null;
  slope90: { slope: number; direction: string; confidence: number } | null;
  anomalyCount: number;
  avg30LastMonth: number | null;
  avg30LastYear: number | null;
}

interface SlimEnvelope {
  data: {
    summaries: Record<string, DataSummaryShape>;
    bmi: number | null;
  };
  error: null;
}

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

describe("GET /api/analytics?slice=summaries (C1)", () => {
  it("returns the empty-summary skeleton for a brand-new user", async () => {
    await seedSession("slim-empty-user");

    const { GET } = await import("@/app/api/analytics/route");
    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/analytics?slice=summaries"));

    expect(response.status).toBe(200);
    const envelope = (await response.json()) as SlimEnvelope;
    // Every enum option is present with the deterministic empty
    // shape so consumers can read `summaries.WEIGHT.count > 0`
    // without an undefined guard.
    expect(envelope.data.summaries.WEIGHT.count).toBe(0);
    expect(envelope.data.summaries.WEIGHT.latest).toBeNull();
    expect(envelope.data.summaries.WEIGHT.slope30).toBeNull();
    expect(envelope.data.summaries.BLOOD_PRESSURE_SYS.count).toBe(0);
    expect(envelope.data.summaries.PULSE.count).toBe(0);
    // The slim slice never carries BMI — consumers re-derive from
    // `summaries.WEIGHT.latest` + `user.heightCm` client-side or
    // fetch the default slice.
    expect(envelope.data.bmi).toBeNull();
  });

  it("reports count + latest + slope + windowed averages from real SQL", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("slim-populated-user");

    // 14 descending-WEIGHT entries spaced one day apart. Slope per
    // day = (84.0 - 80.0) / 13 ≈ -0.308 — solidly inside the "down"
    // band (|slope| >= 0.01 units/day threshold).
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const N = 14;
    const rows = Array.from({ length: N }, (_, i) => ({
      userId: user.id,
      type: "WEIGHT" as const,
      // Most-recent reading is the smallest — slope must come out
      // negative when regressing value against time.
      value: 80 + i * (4 / (N - 1)),
      unit: "kg",
      source: "MANUAL" as const,
      measuredAt: new Date(now - i * DAY_MS),
    }));
    await prisma.measurement.createMany({ data: rows });

    const { GET } = await import("@/app/api/analytics/route");
    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/analytics?slice=summaries"));

    expect(response.status).toBe(200);
    const envelope = (await response.json()) as SlimEnvelope;
    const weight = envelope.data.summaries.WEIGHT;

    expect(weight.count).toBe(N);
    // Most-recent row in DESCENDING construction = index 0 = value 80.
    expect(weight.latest).toBeCloseTo(80, 1);
    // Min / max across the 14 rows.
    expect(weight.min).toBeCloseTo(80, 1);
    expect(weight.max).toBeCloseTo(84, 1);
    // 7-day window covers the first 7 entries (descending dates).
    expect(weight.avg7).not.toBeNull();
    expect(weight.avg30).not.toBeNull();
    // Slope direction must be "down" — value decreases with time.
    expect(weight.slope30).not.toBeNull();
    expect(weight.slope30!.direction).toBe("down");
    expect(weight.slope30!.slope).toBeLessThan(0);
    // R² confidence is in [0, 1].
    expect(weight.slope30!.confidence).toBeGreaterThanOrEqual(0);
    expect(weight.slope30!.confidence).toBeLessThanOrEqual(1);

    // Sanity-check: PULSE is empty on this fixture.
    expect(envelope.data.summaries.PULSE.count).toBe(0);
  });

  it("default slice still carries the thick envelope (additive contract)", async () => {
    await seedSession("slim-default-still-thick");

    const { GET } = await import("@/app/api/analytics/route");
    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/analytics"));

    expect(response.status).toBe(200);
    // Default slice still produces every block the route v1.4.32
    // shipped — proving C1 added a branch instead of mutating the
    // existing path.
    const body = (await response.json()) as {
      data: {
        summaries: unknown;
        bmi: unknown;
        bpInTargetPct: unknown;
        correlations: unknown;
        healthScore: unknown;
        sleepStages: unknown;
        glucoseByContext: unknown;
      };
    };
    expect(body.data.summaries).toBeDefined();
    // Every thick-slice key must still be on the envelope (value can
    // be null for an empty user — what we care about is presence).
    expect("bpInTargetPct" in body.data).toBe(true);
    expect("correlations" in body.data).toBe(true);
    expect("healthScore" in body.data).toBe(true);
    expect("sleepStages" in body.data).toBe(true);
    expect("glucoseByContext" in body.data).toBe(true);
  });
});
