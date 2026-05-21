/**
 * v1.4.40 W-INSIGHTS — `/api/insights/targets` mood-rollup tier swap.
 *
 * Audit Critical Finding #2 (`.planning/round-v1439-arch-qa-infra-db.md`)
 * flagged the unbounded `prisma.moodEntry.findMany({ where: { userId } })`
 * at the bottom of the route as one of the six unbounded mood walks
 * that paint the Insights surface 12 s cold on a power-user account.
 * This file pins:
 *
 *   1. **The mood-rollup DAY tier replaces the raw findMany when
 *      populated.** Mood targets (`MOOD_SCORE`, `MOOD_STABILITY`)
 *      compute their `current` / `average30` / `consistency7d` from
 *      the rollup row set; `prisma.moodEntry.findMany` is never
 *      called on the fast path. A single `findFirst` reads the
 *      latest score (one bounded row).
 *
 *   2. **The coverage-fallback runs the live walk once when the
 *      rollup tier is empty but raw entries exist** (legacy account
 *      before the boot-time backfill has caught up). Bounded by the
 *      trailing 30-day window so the fallback never repeats the
 *      legacy unbounded scan.
 *
 *   3. **The `findMany distinct(["type"])` "latest ever per type"
 *      query carries a `measuredAt: { gte: oneYearAgo }` floor**
 *      (audit High finding 3). Without the floor Postgres still has
 *      to sort the full 347 k-row tenant before applying DISTINCT ON
 *      because Prisma's `distinct` does not compile to PG's
 *      `DISTINCT ON`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn(), findFirst: vi.fn() },
    moodEntryRollup: { findMany: vi.fn(), findFirst: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    appSettings: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
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

// Stub the warm-up so test runs don't fire the real
// `recomputeUserMoodRollups` aggregate. The warm-up is fire-and-forget
// on the route so its return value is irrelevant for parity.
vi.mock("@/lib/rollups/mood-rollups", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rollups/mood-rollups")>(
    "@/lib/rollups/mood-rollups",
  );
  return {
    ...actual,
    ensureUserMoodRollupsFresh: vi.fn().mockResolvedValue({ recomputed: false }),
  };
});

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_USER = {
  id: "user-targets-1",
  username: "marc",
  role: "USER" as const,
  timezone: "Europe/Berlin",
  heightCm: 180,
  dateOfBirth: new Date("1985-01-01"),
  locale: "en",
};

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: SESSION_USER as never,
};

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/insights/targets");
}

interface TargetsBody {
  data: {
    targets: Array<{
      type: string;
      current: number | null;
      average30: number | null;
      daysInRange7d: number;
      daysLogged7d: number;
      insufficientData: boolean;
    }>;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetAllCachesForTests();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK);
  (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    heightCm: 180,
    dateOfBirth: new Date("1985-01-01"),
    gender: "MALE",
    glucoseUnit: "mg/dL",
    thresholdsJson: null,
  });
  (prisma.measurement.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );
  (prisma.medication.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );
  (
    prisma.medicationIntakeEvent.findMany as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
  (prisma.moodEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.moodEntry.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
    null,
  );
  (
    prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
  ).mockResolvedValue([]);
});

describe("GET /api/insights/targets — mood-rollup tier swap", () => {
  it("returns a mood target driven by the rollup DAY tier without touching the raw findMany", async () => {
    // Five DAY-rollup rows over the trailing 30 days. The route reads
    // them directly to drive `MOOD_SCORE.current/average30/consistency`
    // — no raw `moodEntry.findMany` on the fast path.
    const today = new Date();
    const day = (offset: number) => {
      const d = new Date(today);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - offset);
      return d;
    };
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      { userId: SESSION_USER.id, granularity: "DAY", bucketStart: day(0), count: 1, mean: 4, minScore: 4, maxScore: 4, sd: null, computedAt: new Date() },
      { userId: SESSION_USER.id, granularity: "DAY", bucketStart: day(1), count: 1, mean: 4, minScore: 4, maxScore: 4, sd: null, computedAt: new Date() },
      { userId: SESSION_USER.id, granularity: "DAY", bucketStart: day(2), count: 1, mean: 5, minScore: 5, maxScore: 5, sd: null, computedAt: new Date() },
      { userId: SESSION_USER.id, granularity: "DAY", bucketStart: day(3), count: 1, mean: 4, minScore: 4, maxScore: 4, sd: null, computedAt: new Date() },
      { userId: SESSION_USER.id, granularity: "DAY", bucketStart: day(4), count: 1, mean: 4.5, minScore: 4, maxScore: 5, sd: 0.5, computedAt: new Date() },
    ]);
    // Latest score read — one bounded row.
    (prisma.moodEntry.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      score: 4,
      moodLoggedAt: day(0),
    });

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);

    // The unbounded raw `moodEntry.findMany` must not fire on the
    // rollup-tier fast path.
    expect(prisma.moodEntry.findMany).not.toHaveBeenCalled();

    const body = (await res.json()) as TargetsBody;
    const moodTarget = body.data.targets.find((t) => t.type === "MOOD_SCORE");
    expect(moodTarget).toBeDefined();
    expect(moodTarget?.current).toBe(4);
    // Average over 5 daily means: (4+4+5+4+4.5)/5 = 4.3
    expect(moodTarget?.average30).toBeCloseTo(4.3, 1);
  });

  it("falls back to the bounded raw walk when the rollup tier is empty but raw mood entries exist", async () => {
    // Rollup empty → coverage-fallback fires the legacy live walk
    // once. The fallback is bounded by the 30-day window — not the
    // legacy unbounded scan over every mood the user ever wrote.
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);
    const today = new Date();
    (prisma.moodEntry.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      score: 4,
      moodLoggedAt: today,
    });
    (prisma.moodEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { score: 4, moodLoggedAt: new Date(today.getTime() - 2 * 86_400_000) },
      { score: 5, moodLoggedAt: new Date(today.getTime() - 1 * 86_400_000) },
      { score: 4, moodLoggedAt: today },
    ]);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);

    // Live fallback fired exactly once. The fallback `findMany` call
    // must carry a 30-day `moodLoggedAt: { gte: ... }` floor — i.e. a
    // `where` clause with a timestamp filter, not the legacy
    // unbounded `where: { userId }` shape.
    expect(prisma.moodEntry.findMany).toHaveBeenCalledTimes(1);
    const fallbackCall = (prisma.moodEntry.findMany as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(fallbackCall.where).toHaveProperty("moodLoggedAt");
    expect(fallbackCall.where.moodLoggedAt).toHaveProperty("gte");

    const body = (await res.json()) as TargetsBody;
    const moodTarget = body.data.targets.find((t) => t.type === "MOOD_SCORE");
    expect(moodTarget).toBeDefined();
    expect(moodTarget?.current).toBe(4);
  });

  it("emits no mood target when neither rollup nor raw entries exist", async () => {
    (
      prisma.moodEntryRollup.findMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);
    (prisma.moodEntry.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as TargetsBody;
    const moodTarget = body.data.targets.find((t) => t.type === "MOOD_SCORE");
    expect(moodTarget).toBeUndefined();
  });

  it("floors the `findMany distinct` latest-ever-per-type read at one year", async () => {
    // Audit High finding 3: the `findMany({orderBy: measuredAt desc,
    // distinct: ["type"]})` for "absolute latest measurement per type"
    // used to run WITHOUT a `measuredAt >=` floor. On a 347 k-row
    // tenant Postgres still has to sort the full set before applying
    // DISTINCT ON because Prisma's `distinct` does not compile to PG's
    // `DISTINCT ON` — it dedups in the driver. v1.4.40 adds a
    // 365-day floor so the planner-side walk is bounded.
    (prisma.measurement.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
    );

    await callGet(makeReq());

    // Find the `distinct: ["type"]` call.
    const calls = (
      prisma.measurement.findMany as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0]);
    const distinctCall = calls.find(
      (c) =>
        c &&
        Array.isArray(c.distinct) &&
        c.distinct[0] === "type" &&
        c.orderBy?.measuredAt === "desc",
    );
    expect(distinctCall).toBeDefined();
    // The `measuredAt >= oneYearAgo` floor must be present.
    expect(distinctCall?.where?.measuredAt).toBeDefined();
    expect(distinctCall?.where?.measuredAt?.gte).toBeInstanceOf(Date);
    const flooredAt = distinctCall?.where?.measuredAt?.gte as Date;
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    const ageMs = Date.now() - flooredAt.getTime();
    // Floor is somewhere around one year ago — give a ±1-hour window
    // for clock drift between the route's `Date.now()` and the test
    // assertion.
    expect(ageMs).toBeGreaterThan(oneYearMs - 3_600_000);
    expect(ageMs).toBeLessThan(oneYearMs + 3_600_000);
  });
});
