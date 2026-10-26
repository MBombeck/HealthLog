/**
 * #1023 — a full-history Google Health backfill over a dense heart-rate
 * stream, with its live memory measured rather than assumed.
 *
 * What this pins. The backfill read every heart-rate point of the account's
 * history into one array, mapped all of it into a second array, and wrote the
 * lot in one call, so the raw points, the readings and the write's working
 * sets were resident together and all of them scaled with the history. A
 * watch that records a reading a minute passes a million points in two years:
 * reproduced on 1.3 M readings under `--max-old-space-size=1024`, the backfill
 * reaches `FATAL ERROR: Reached heap limit` within seconds, and because the
 * backfill lane shares the app process, the whole instance restarts. The walk
 * now writes each page as it arrives, and the cycle's deferred-rollup ledger
 * keeps one key per touched day instead of one per reading.
 *
 * How it measures. Every heap reading is taken after a forced collection, so
 * what is compared is what the code HOLDS, not how much garbage V8 chose to
 * leave lying about. And what is compared is GROWTH: the heap once a quarter
 * of the pages have been read, against the most it reaches afterwards. The
 * first pages carry a fixed cost that has nothing to do with the stream
 * (modules loaded on first use, the ORM's compiled queries), and that cost is
 * about the size of this fixture, so an absolute figure could not tell a
 * streaming walk from one that holds everything. Growth can: a walk that
 * holds one page stays flat, a walk that holds what it has read climbs with
 * every page.
 *
 * The two halves are the point: the backfill stays inside the budget, and
 * collecting the same collection into one array (what the backfill used to do
 * before anything else) does not. Without the second half the budget could
 * be any number and the first would still pass.
 *
 * Google's API is replaced at the `safeFetch` seam by a generator that builds
 * each page on request, so the fixture itself never sits in memory.
 */
import v8 from "node:v8";
import vm from "node:vm";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "gh-dense-backfill-owner";
const POINTS = 300_000;
const NOW = Date.parse("2026-09-27T17:00:00.000Z");

/**
 * How much the heap may grow between the first quarter of the walk and its
 * end. Measured, not chosen: the paged walk grows by a few MB on this fixture
 * (noise around a flat line), and collecting the same pages into one array
 * grows by about 80 MB over the same stretch.
 */
const GROWTH_BUDGET_BYTES = 24 * 1024 * 1024;

const fake = vi.hoisted(() => ({
  total: 0,
  now: 0,
  heartRatePages: 0,
  /** Called as each heart-rate page is requested (the sampler's hook). */
  onPage: null as (() => void) | null,
}));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    // A plain function, not `vi.fn`: a mock records every call's result, and
    // here each result is a whole page's response, so the recorder alone
    // would hold the collection this file exists to keep out of memory.
    safeFetch: async (url: string) => {
      const u = new URL(url);
      let body: unknown = {};
      if (u.pathname.endsWith("/dataTypes/heart-rate/dataPoints")) {
        const pageSize = Number(u.searchParams.get("pageSize") ?? 1000);
        const page = Number(u.searchParams.get("pageToken") ?? 0);
        const end = Math.min(fake.total, (page + 1) * pageSize);
        const dataPoints = [];
        for (let g = page * pageSize; g < end; g++) {
          dataPoints.push({
            name: `users/me/dataTypes/heart-rate/dataPoints/${9_000_000_000_000 + g}`,
            dataSource: {
              recordingMethod: "PASSIVE_MEASUREMENT",
              device: { manufacturer: "Google", displayName: "Watch" },
              platform: "FITBIT",
            },
            heartRate: {
              beatsPerMinute: String(55 + (g % 50)),
              sampleTime: {
                physicalTime: new Date(fake.now - g * 60_000).toISOString(),
              },
            },
          });
        }
        fake.heartRatePages++;
        fake.onPage?.();
        body = {
          dataPoints,
          ...(end < fake.total ? { nextPageToken: String(page + 1) } : {}),
        };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const forceGc = ((): (() => void) => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return gc;
})();

function liveHeapBytes(): number {
  forceGc();
  forceGc();
  return process.memoryUsage().heapUsed;
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

function report(line: string): void {
  process.stderr.write(`[gh-dense-backfill] ${line}\n`);
}

/**
 * Run `fn` while sampling the collected heap every few pages, from inside the
 * page request, so each sample lands between two pages of the work being
 * measured: exactly where anything it holds across a page is visible. (A
 * timer is not enough; a walk whose pages resolve without touching the event
 * loop never lets it fire.) Returns how far the heap rose after the walk
 * passed a quarter of its pages.
 */
async function growthPastFirstQuarter<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; growth: number; samples: number }> {
  const quarter = Math.ceil(POINTS / 1000 / 4);
  const startPages = fake.heartRatePages;
  let anchor: number | null = null;
  let peak = 0;
  let samples = 0;
  const sample = (): void => {
    const live = liveHeapBytes();
    if (anchor === null) {
      if (fake.heartRatePages - startPages >= quarter) anchor = peak = live;
      return;
    }
    samples++;
    peak = Math.max(peak, live);
  };
  fake.onPage = () => {
    if ((fake.heartRatePages - startPages) % 5 === 0) sample();
  };
  try {
    const result = await fn();
    sample();
    return {
      result,
      growth: anchor === null ? Number.NaN : peak - anchor,
      samples,
    };
  } finally {
    fake.onPage = null;
  }
}

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const { encrypt } = await import("@/lib/crypto");
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "Europe/Berlin" },
  });
  await prisma.googleHealthConnection.create({
    data: {
      userId: USER,
      googleUserId: `google-${USER}`,
      accessToken: encrypt("access"),
      refreshToken: encrypt("refresh"),
      tokenExpiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  fake.total = POINTS;
  fake.now = NOW;
}, 120_000);

afterAll(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("Google Health backfill over a dense heart-rate stream (#1023)", () => {
  it("writes the whole history without growing with it", async () => {
    const { runGoogleHealthBackfillForUser } =
      await import("@/lib/jobs/google-health-backfill");

    const { result, growth, samples } = await growthPastFirstQuarter(() =>
      runGoogleHealthBackfillForUser(USER),
    );
    report(
      `backfill: imported=${result.imported} growth=${mb(growth)} MB ` +
        `over ${samples} samples (budget ${mb(GROWTH_BUDGET_BYTES)} MB)`,
    );

    const prisma = getPrismaClient();
    expect(
      await prisma.measurement.count({
        where: { userId: USER, type: "PULSE", source: "GOOGLE_HEALTH" },
      }),
    ).toBe(POINTS);
    const connection = await prisma.googleHealthConnection.findUniqueOrThrow({
      where: { userId: USER },
      select: { backfillCompletedAt: true },
    });
    expect(connection.backfillCompletedAt).not.toBeNull();
    // The deferred fold reached the rollup tier for the whole span.
    const days = await prisma.measurementRollup.count({
      where: { userId: USER, type: "PULSE", granularity: "DAY" },
    });
    expect(days).toBeGreaterThanOrEqual(Math.floor(POINTS / 1440));

    expect(samples).toBeGreaterThan(5);
    expect(growth).toBeLessThan(GROWTH_BUDGET_BYTES);
  }, 900_000);

  it("the same pages collected into one array outgrow the budget", async () => {
    const { fetchDataPoints } = await import("@/lib/google-health/data-points");
    const { GOOGLE_HEALTH_DATA_TYPES } =
      await import("@/lib/google-health/mappers");
    let held: unknown[] = [];
    const { growth, samples } = await growthPastFirstQuarter(async () => {
      held = await fetchDataPoints(
        GOOGLE_HEALTH_DATA_TYPES.heartRate,
        "access",
        "fetchHeartRate",
      );
    });
    report(
      `collected: points=${held.length} growth=${mb(growth)} MB over ${samples} samples`,
    );
    expect(held).toHaveLength(POINTS);
    expect(growth).toBeGreaterThan(GROWTH_BUDGET_BYTES);
  }, 900_000);
});
