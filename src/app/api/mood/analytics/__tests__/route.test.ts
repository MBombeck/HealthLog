/**
 * v1.4.39 W-MOOD — integration coverage for the rollup-tier read swap
 * in `/api/mood/analytics`.
 *
 * Pins the parity contract the audit at
 * `.planning/round-v1438-perf-analysis.md` §2.3 calls for: the
 * response shape stays byte-identical when the rollup tier is warm,
 * and falls back to the legacy live walk once when a legacy account
 * has mood entries but no rollup rows yet.
 *
 * The fast path consumes `prisma.moodEntryRollup.findMany`; the
 * coverage fallback consumes `prisma.moodEntry.findMany` (legacy
 * shape). Both branches go through the `cached(caches.moodAnalytics)`
 * LRU so the second read in a test must observe the same response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    moodEntry: {
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    moodEntryRollup: {
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
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

// Stub the warm-up helper so test runs don't fire the real
// `recomputeUserMoodRollups` aggregate. The warm-up is fire-and-
// forget on the route so its return value is irrelevant for parity.
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
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_USER = {
  id: "user-mood-1",
  username: "marc",
  role: "USER" as const,
  timezone: "Europe/Berlin",
  heightCm: 180,
  dateOfBirth: new Date("1980-01-01T00:00:00Z"),
  sourcePriorityJson: null,
};

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: SESSION_USER as never,
};

const callGet = GET as unknown as (...args: never[]) => Promise<Response>;

interface MoodAnalyticsBody {
  data: {
    entries: Array<{ date: string; score: number; samples: number }>;
    summary: {
      count: number;
      latest: number | null;
      min: number | null;
      max: number | null;
      mean: number | null;
    };
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetAllCachesForTests();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.moodEntryRollup.findMany).mockResolvedValue([] as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/mood/analytics", () => {
  it("returns an empty envelope for a brand-new user with zero rollups and zero raw entries", async () => {
    // Both branches return an empty result: rollup tier empty, raw
    // mood-entry table empty. The legacy `entries` array is also
    // empty so the response is identical to the pre-swap shape.
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as MoodAnalyticsBody;
    expect(body.data.entries).toEqual([]);
    expect(body.data.summary.count).toBe(0);
    expect(body.data.summary.latest).toBeNull();
    expect(body.data.summary.min).toBeNull();
    expect(body.data.summary.max).toBeNull();
    expect(body.data.summary.mean).toBeNull();
  });

  it("consumes the rollup tier when DAY rows exist and skips the raw findMany", async () => {
    // One DAY-rollup row per calendar day, three days running.
    vi.mocked(prisma.moodEntryRollup.findMany).mockResolvedValue([
      {
        userId: "user-mood-1",
        granularity: "DAY",
        bucketStart: new Date("2026-05-08T00:00:00.000Z"),
        count: 1,
        mean: 4,
        minScore: 4,
        maxScore: 4,
        sd: null,
        computedAt: new Date(),
      },
      {
        userId: "user-mood-1",
        granularity: "DAY",
        bucketStart: new Date("2026-05-09T00:00:00.000Z"),
        count: 1,
        mean: 5,
        minScore: 5,
        maxScore: 5,
        sd: null,
        computedAt: new Date(),
      },
      {
        userId: "user-mood-1",
        granularity: "DAY",
        bucketStart: new Date("2026-05-10T00:00:00.000Z"),
        count: 2,
        mean: 4.5,
        minScore: 4,
        maxScore: 5,
        sd: 0.5,
        computedAt: new Date(),
      },
    ] as never);

    const res = await callGet();
    expect(res.status).toBe(200);

    // The raw `moodEntry.findMany` must not fire on the fast path.
    expect(prisma.moodEntry.findMany).not.toHaveBeenCalled();

    const body = (await res.json()) as MoodAnalyticsBody;
    expect(body.data.entries).toEqual([
      { date: "2026-05-08", score: 4, samples: 1 },
      { date: "2026-05-09", score: 5, samples: 1 },
      { date: "2026-05-10", score: 4.5, samples: 2 },
    ]);
    expect(body.data.summary.count).toBe(3);
    expect(body.data.summary.latest).toBe(4.5);
    expect(body.data.summary.min).toBe(4);
    expect(body.data.summary.max).toBe(5);
  });

  it("falls back to the live findMany once when the rollup tier is empty but mood entries exist", async () => {
    // Coverage-fallback: legacy account with raw entries but no
    // rollup coverage yet. The route runs the legacy walk once;
    // the warm-up helper is supposed to fire asynchronously
    // (stubbed above).
    vi.mocked(prisma.moodEntryRollup.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      {
        date: "2026-05-08",
        score: 4,
        moodLoggedAt: new Date("2026-05-08T12:00:00.000Z"),
      },
      {
        date: "2026-05-09",
        score: 5,
        moodLoggedAt: new Date("2026-05-09T12:00:00.000Z"),
      },
    ] as never);

    const res = await callGet();
    expect(res.status).toBe(200);

    // Live fallback fired exactly once.
    expect(prisma.moodEntry.findMany).toHaveBeenCalledTimes(1);

    const body = (await res.json()) as MoodAnalyticsBody;
    expect(body.data.entries).toEqual([
      { date: "2026-05-08", score: 4, samples: 1 },
      { date: "2026-05-09", score: 5, samples: 1 },
    ]);
    expect(body.data.summary.count).toBe(2);
    expect(body.data.summary.latest).toBe(5);
  });

  it("pins the DST fall-back Berlin midnight slip — UTC bucket vs local day diverge by one calendar day", async () => {
    // QA Specialist-H1 (v1.4.39): 2025-10-25T23:30:00Z is 00:30 local
    // in Europe/Berlin on 2025-10-26 (one hour AFTER the fall-back
    // transition). The mood rollup writer anchors `bucketStart` on
    // UTC midnight (mirroring the measurement-rollup convention), so
    // a write logged at this instant materialises a rollup row keyed
    // on `2025-10-25T00:00:00Z` — the UTC-anchored day — even though
    // the user's local wall clock reads 2025-10-26. The route's
    // `utcDayLabel` emits the same day-key the rollup row carries.
    //
    // This pins the documented behaviour. The legacy live-fallback
    // path uses `MoodEntry.date` (TZ-anchored) and therefore emits
    // `2025-10-26` for the same instant — a slip we document in the
    // route's header comment as the cost of the cache-tier semantics.
    // The v1.5 per-user-tz bucketing (P7 in the v1.4.38 perf audit)
    // closes the gap by anchoring the rollup table on the same day-
    // key the legacy path uses. Until then this is the contract.
    vi.mocked(prisma.moodEntryRollup.findMany).mockResolvedValue([
      {
        userId: "user-mood-1",
        granularity: "DAY",
        bucketStart: new Date("2025-10-25T00:00:00.000Z"),
        count: 1,
        mean: 4,
        minScore: 4,
        maxScore: 4,
        sd: null,
        computedAt: new Date(),
      },
    ] as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as MoodAnalyticsBody;
    // The rollup tier pins the entry on the UTC-anchored day-key,
    // NOT the user's local 2025-10-26 — same convention as the
    // measurement-rollup tier.
    expect(body.data.entries).toEqual([
      { date: "2025-10-25", score: 4, samples: 1 },
    ]);
  });

  it("serves the cached envelope on a warm read without touching the DB", async () => {
    // First read populates the cache.
    vi.mocked(prisma.moodEntryRollup.findMany).mockResolvedValue([
      {
        userId: "user-mood-1",
        granularity: "DAY",
        bucketStart: new Date("2026-05-10T00:00:00.000Z"),
        count: 1,
        mean: 4,
        minScore: 4,
        maxScore: 4,
        sd: null,
        computedAt: new Date(),
      },
    ] as never);

    const first = await callGet();
    expect(first.status).toBe(200);
    expect(prisma.moodEntryRollup.findMany).toHaveBeenCalledTimes(1);

    // Second read hits the LRU and never touches Prisma again.
    const second = await callGet();
    expect(second.status).toBe(200);
    expect(prisma.moodEntryRollup.findMany).toHaveBeenCalledTimes(1);

    const firstBody = (await first.json()) as MoodAnalyticsBody;
    const secondBody = (await second.json()) as MoodAnalyticsBody;
    expect(secondBody).toEqual(firstBody);
  });

  it("pre-aggregates the live fallback through daily averages so multi-entry days match the rollup-path summarize semantics", async () => {
    // QA UX-H1 (v1.4.39): two entries on the same day (score 3 + 5)
    // must produce identical `summary.count / latest / min / max /
    // mean` on the rollup tier (one DataPoint with mean=4) AND on the
    // live-fallback path (which used to pass per-entry points).
    const moodLoggedAt = new Date("2026-05-10T12:00:00.000Z");

    // Live-fallback first: two entries on the same day.
    vi.mocked(prisma.moodEntryRollup.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      { date: "2026-05-10", score: 3, moodLoggedAt },
      { date: "2026-05-10", score: 5, moodLoggedAt },
    ] as never);
    const liveRes = await callGet();
    const liveBody = (await liveRes.json()) as MoodAnalyticsBody;

    __resetAllCachesForTests();

    // Rollup tier: one DAY row with count=2 / mean=4.
    vi.mocked(prisma.moodEntryRollup.findMany).mockResolvedValue([
      {
        userId: "user-mood-1",
        granularity: "DAY",
        bucketStart: new Date("2026-05-10T00:00:00.000Z"),
        count: 2,
        mean: 4,
        minScore: 3,
        maxScore: 5,
        sd: 1,
        computedAt: new Date(),
      },
    ] as never);
    const rollupRes = await callGet();
    const rollupBody = (await rollupRes.json()) as MoodAnalyticsBody;

    // Both branches emit a single daily-average entry with score=4.
    expect(liveBody.data.entries).toEqual([
      { date: "2026-05-10", score: 4, samples: 2 },
    ]);
    expect(rollupBody.data.entries).toEqual([
      { date: "2026-05-10", score: 4, samples: 2 },
    ]);

    // Summary stats now match across both branches — pre-v1.4.39 the
    // live path passed per-entry points so `count` was 2 (per entry)
    // and `mean` was the unweighted average over entries. After the
    // pre-aggregate the live path emits one DataPoint per day (mean=4)
    // exactly as the rollup tier does.
    expect(liveBody.data.summary.count).toBe(rollupBody.data.summary.count);
    expect(liveBody.data.summary.latest).toBe(rollupBody.data.summary.latest);
    expect(liveBody.data.summary.min).toBe(rollupBody.data.summary.min);
    expect(liveBody.data.summary.max).toBe(rollupBody.data.summary.max);
    expect(liveBody.data.summary.mean).toBe(rollupBody.data.summary.mean);
  });

  it("emits byte-identical entries + summary shape between rollup tier and live fallback for the same canonical data", async () => {
    // Same one-entry-per-day series, surfaced once via the rollup
    // tier and once via the legacy live walk. Response shape is
    // expected to be byte-compatible — the rollup carries the
    // pre-aggregated daily mean which is precisely what
    // aggregateDailyAverages would produce from a single entry
    // per day.
    const canonicalEntries = [
      {
        date: "2026-05-08",
        score: 3,
        moodLoggedAt: new Date("2026-05-08T12:00:00.000Z"),
      },
      {
        date: "2026-05-09",
        score: 4,
        moodLoggedAt: new Date("2026-05-09T12:00:00.000Z"),
      },
      {
        date: "2026-05-10",
        score: 5,
        moodLoggedAt: new Date("2026-05-10T12:00:00.000Z"),
      },
    ];

    // Live-fallback request first (rollup empty + raw populated).
    vi.mocked(prisma.moodEntryRollup.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue(
      canonicalEntries as never,
    );
    const liveRes = await callGet();
    const liveBody = (await liveRes.json()) as MoodAnalyticsBody;

    // Bust the cache before the rollup-tier read so the second call
    // re-evaluates the read path with the rollup populated.
    __resetAllCachesForTests();

    vi.mocked(prisma.moodEntryRollup.findMany).mockResolvedValue([
      {
        userId: "user-mood-1",
        granularity: "DAY",
        bucketStart: new Date("2026-05-08T00:00:00.000Z"),
        count: 1,
        mean: 3,
        minScore: 3,
        maxScore: 3,
        sd: null,
        computedAt: new Date(),
      },
      {
        userId: "user-mood-1",
        granularity: "DAY",
        bucketStart: new Date("2026-05-09T00:00:00.000Z"),
        count: 1,
        mean: 4,
        minScore: 4,
        maxScore: 4,
        sd: null,
        computedAt: new Date(),
      },
      {
        userId: "user-mood-1",
        granularity: "DAY",
        bucketStart: new Date("2026-05-10T00:00:00.000Z"),
        count: 1,
        mean: 5,
        minScore: 5,
        maxScore: 5,
        sd: null,
        computedAt: new Date(),
      },
    ] as never);
    const rollupRes = await callGet();
    const rollupBody = (await rollupRes.json()) as MoodAnalyticsBody;

    // `entries` shape — date / score / samples — must be byte-identical.
    expect(rollupBody.data.entries).toEqual(liveBody.data.entries);
    // Summary core stats must match (count / min / max / mean /
    // latest). Slope windows depend on Date.now() so we don't compare
    // those — they are deterministic for the same input and the
    // input is identical here.
    expect(rollupBody.data.summary.count).toBe(liveBody.data.summary.count);
    expect(rollupBody.data.summary.latest).toBe(liveBody.data.summary.latest);
    expect(rollupBody.data.summary.min).toBe(liveBody.data.summary.min);
    expect(rollupBody.data.summary.max).toBe(liveBody.data.summary.max);
    expect(rollupBody.data.summary.mean).toBe(liveBody.data.summary.mean);
  });
});
