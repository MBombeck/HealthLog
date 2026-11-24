/**
 * The reads a dense account's MCP and insight calls make stay bounded by what
 * they answer, not by how long the account has been recording.
 *
 * A watch that writes heart rate every few seconds leaves millions of rows
 * over a few years. Every read below used to visit all of them on each call:
 * the full-history figures checked the rollup tier against a per-day count of
 * every live reading, the Coach availability probe aggregated the whole
 * history of a lapsed stream, and `list_metrics` / `search` built the whole
 * Coach snapshot to learn which domains exist. On a real account that added
 * up to MCP calls past the client's timeout.
 *
 * The fixture is one account with a dense pulse stream, a dense oxygen
 * stream that stopped syncing six weeks ago, a dense stress stream, and the
 * sparse daily types around them, about 260,000 rows with its DAY rollup
 * tier folded. Each read is run under `EXPLAIN (ANALYZE, BUFFERS)`, every
 * statement it sends included (`statement-plans.ts`), and held to a bound on
 * the measurement rows its scans visit that is a small fraction of the
 * history. The bound has to hold in each statistics state a dense account
 * passes through (see `newest-per-type-plans.test.ts` for why each one
 * matters): no statistics at all, statistics gathered before the account's
 * rows arrived, and analysed with the account in them.
 *
 * The account's rows and rollups are seeded once and copied back for each
 * state, so a state costs a copy rather than a fold. Autovacuum is off for
 * the file so no state drifts into another mid-test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { describeLedger, explainStatements } from "./statement-plans";
import { readAllTimeExtremes } from "@/lib/insights/feature-blocks";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { probeCoachAvailability } from "@/lib/ai/coach/tools/availability";
import { listMetricsTool } from "@/lib/mcp/tools/list-metrics";
import { searchTool } from "@/lib/mcp/tools/search";
import { metricStatusDiscoveryRows } from "@/lib/mcp/rich-reads";
import { __resetCoachSnapshotCacheForTests } from "@/lib/ai/coach/snapshot-cache";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { computeStatusInputFingerprint } from "@/lib/insights/status-cache";
import {
  countLiveMeasurements,
  countTombstonedMeasurements,
} from "@/lib/sync/measurement-counts";
import type { McpAuthContext } from "@/lib/mcp/auth";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const prisma = getPrismaClient();
const ACCOUNT = "dense-plans";
/** Pulse every two minutes for about 280 days. */
const PULSE_ROWS = 200_000;
/** Oxygen every ten minutes, ending 45 days ago. */
const SPO2_ROWS = 30_000;
/** Stress every three minutes for 60 days. */
const STRESS_ROWS = 28_800;
const SPARSE_DAYS = 400;
const OTHER_ACCOUNTS = 20;
const OTHER_ROWS = 1_000;
/** Pulse older than the five-year fold window: every two minutes for 28 days. */
const OLD_PULSE_ROWS = 20_000;
const HISTORY_ROWS = PULSE_ROWS + OLD_PULSE_ROWS + SPO2_ROWS + STRESS_ROWS;

/** Rows the availability probe samples per type (its own cap). */
const SAMPLE_CAP = 5_000;
/** Pulse readings in one UTC day, and oxygen readings. */
const PULSE_DAY = 720;
const SPO2_DAY = 144;
const DAY_MS = 86_400_000;
const STRESS_DAY = 480;

type StatisticsState = "none" | "predate" | "analysed";

const ctx: McpAuthContext = {
  userId: ACCOUNT,
  tokenId: "dense-plans-token",
  scopes: ["health:read"],
  binding: `${ACCOUNT}:dense-plans-token`,
  canRead: true,
  canWrite: false,
};

interface InventoryRow {
  tool: string;
  metric?: string;
  domain: string;
  present: boolean;
  count?: number;
  availability?: { state: string; count?: number };
}

/** Rows one seed or copy statement writes, well inside the statement timeout. */
const SEED_CHUNK = 25_000;

/** One stream of the account: `rows` readings `step` apart, back from `from`. */
async function seedStream(
  prefix: string,
  type: string,
  rows: number,
  value: string,
  unit: string,
  source: string,
  from: string,
  step: string,
  anchor: Date,
): Promise<void> {
  for (let start = 0; start < rows; start += SEED_CHUNK) {
    const end = Math.min(rows, start + SEED_CHUNK) - 1;
    await prisma.$executeRawUnsafe(
      `INSERT INTO measurements
         (id, user_id, type, value, unit, source, measured_at, updated_at)
       SELECT '${prefix}' || i, $1, '${type}'::measurement_type, ${value},
              '${unit}', '${source}'::measurement_source,
              $2::timestamp - interval '${from}' - i * interval '${step}', now()
         FROM generate_series(${start}, ${end}) i`,
      ACCOUNT,
      anchor,
    );
  }
}

async function seedAccount(): Promise<void> {
  const anchor = new Date();
  await seedStream(
    "q",
    "PULSE",
    OLD_PULSE_ROWS,
    "30 + (i % 10)",
    "bpm",
    "APPLE_HEALTH",
    "2000 days",
    "2 minutes",
    anchor,
  );
  await seedStream(
    "p",
    "PULSE",
    PULSE_ROWS,
    "55 + (i % 40)",
    "bpm",
    "APPLE_HEALTH",
    "1 minute",
    "2 minutes",
    anchor,
  );
  await seedStream(
    "o",
    "OXYGEN_SATURATION",
    SPO2_ROWS,
    "95 + (i % 4)",
    "%",
    "APPLE_HEALTH",
    "45 days",
    "10 minutes",
    anchor,
  );
  await seedStream(
    "s",
    "STRESS_LEVEL",
    STRESS_ROWS,
    "i % 100",
    "score",
    "GARMIN",
    "2 minutes",
    "3 minutes",
    anchor,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements
       (id, user_id, type, value, unit, source, measured_at, updated_at)
     SELECT t || d, $1, t::measurement_type, 70 + (d % 9), 'x',
            'WITHINGS'::measurement_source,
            $2::timestamp - d * interval '1 day' - interval '7 hours', now()
       FROM generate_series(0, ${SPARSE_DAYS - 1}) d,
            unnest(ARRAY['WEIGHT', 'BLOOD_PRESSURE_SYS', 'BLOOD_PRESSURE_DIA',
                         'RESTING_HEART_RATE', 'SLEEP_DURATION',
                         'ACTIVITY_STEPS']) t`,
    ACCOUNT,
    anchor,
  );
}

async function seedOthers(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements
       (id, user_id, type, value, unit, source, measured_at, updated_at)
     SELECT 'x' || u || '-' || i, 'other-' || u,
            (enum_range(NULL::measurement_type))[1 + (i % 20)],
            1, 'x', 'MANUAL', now() - i * interval '1 hour', now()
       FROM generate_series(1, ${OTHER_ACCOUNTS}) u,
            generate_series(0, ${OTHER_ROWS - 1}) i`,
  );
}

async function restoreAccount(): Promise<void> {
  const parts = Math.ceil((HISTORY_ROWS + SPARSE_DAYS * 6) / SEED_CHUNK);
  for (let part = 0; part < parts; part++) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO measurements SELECT * FROM dense_plans_stage
        WHERE abs(hashtext(id)) % ${parts} = ${part}`,
    );
  }
}

async function dropStatistics(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM pg_statistic
      WHERE starelid IN ('measurements'::regclass,
                         'measurement_rollups'::regclass)`,
  );
}

async function buildState(state: StatisticsState): Promise<void> {
  await prisma.$executeRawUnsafe("TRUNCATE measurements CASCADE");
  await dropStatistics();
  switch (state) {
    case "none":
      await restoreAccount();
      return;
    case "predate":
      await seedOthers();
      await prisma.$executeRawUnsafe("ANALYZE measurements");
      await prisma.$executeRawUnsafe("ANALYZE measurement_rollups");
      await restoreAccount();
      return;
    case "analysed":
      await seedOthers();
      await restoreAccount();
      await prisma.$executeRawUnsafe("ANALYZE measurements");
      await prisma.$executeRawUnsafe("ANALYZE measurement_rollups");
      return;
  }
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  for (const table of ["measurements", "measurement_rollups"]) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE ${table} SET (autovacuum_enabled = false)`,
    );
  }
  await prisma.user.createMany({
    data: [
      { id: ACCOUNT, username: ACCOUNT, timezone: "UTC" },
      ...Array.from({ length: OTHER_ACCOUNTS }, (_, i) => ({
        id: `other-${i + 1}`,
        username: `other-${i + 1}`,
      })),
    ],
  });
  await seedAccount();
  await prisma.$executeRawUnsafe("ANALYZE measurements");
  await recomputeUserRollups(ACCOUNT);
  await prisma.$executeRawUnsafe("DROP TABLE IF EXISTS dense_plans_stage");
  await prisma.$executeRawUnsafe(
    "CREATE TABLE dense_plans_stage AS SELECT * FROM measurements",
  );
}, 600_000);

afterAll(async () => {
  await prisma.$executeRawUnsafe("DROP TABLE IF EXISTS dense_plans_stage");
  for (const table of ["measurements", "measurement_rollups"]) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE ${table} RESET (autovacuum_enabled)`,
    );
  }
});

/** Live readings of a type from `since` on, counted the plain way. */
async function liveCount(type: string, since: Date): Promise<number> {
  const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM measurements
      WHERE user_id = $1 AND type = $2::measurement_type
        AND deleted_at IS NULL AND measured_at >= $3`,
    ACCOUNT,
    type,
    since,
  );
  return n;
}

/**
 * No sequential scan of the measurements, and the rows their scans visit
 * within `bound`. A window that read no measurement at all fails too, so a
 * bound cannot pass on a read that went somewhere else.
 */
function expectBounded(
  ledger: Awaited<ReturnType<typeof explainStatements>>,
  bound: number,
): void {
  const detail = describeLedger(ledger);
  expect(
    ledger.plans.some((p) => p.rowVisits > 0),
    detail,
  ).toBe(true);
  expect(
    ledger.plans.filter((p) => p.seqScan).map((p) => p.text),
    detail,
  ).toEqual([]);
  expect(
    ledger.rowVisits,
    `${ledger.rowVisits} measurement rows visited against a bound of ${bound}:\n${detail}`,
  ).toBeLessThanOrEqual(bound);
}

/**
 * Explain `read` after one untimed call of its own. The readings older than
 * the fold window are counted once into a closed block that the first read
 * of a type folds and every later read takes; the bounds below are the cost
 * of a later read. A case that left the fold to whichever case ran before it
 * measured the fold instead whenever the order changed.
 */
async function explainWarm<T>(
  read: () => Promise<T>,
): ReturnType<typeof explainStatements<T>> {
  await read();
  return explainStatements(read);
}

describe.each<StatisticsState>(["none", "predate", "analysed"])(
  "dense account reads with statistics: %s",
  (state) => {
    beforeAll(async () => {
      await buildState(state);
    }, 600_000);

    it("the fixture holds the history the bounds are measured against", async () => {
      const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM measurements WHERE user_id = $1`,
        ACCOUNT,
      );
      expect(n).toBe(HISTORY_ROWS + SPARSE_DAYS * 6);
    });

    it("folds the history older than the fold window once, not per read", async () => {
      __resetAllCachesForTests();
      const cold = await explainStatements(() =>
        readAllTimeExtremes(ACCOUNT, ["PULSE"]),
      );
      // The first read folds the readings the tier never holds...
      expect(cold.rowVisits).toBeGreaterThanOrEqual(OLD_PULSE_ROWS);
      expect(cold.result.get("PULSE")?.min).toBe(30);
      // ...and the next one takes them from the closed block.
      const warm = await explainStatements(() =>
        readAllTimeExtremes(ACCOUNT, ["PULSE"]),
      );
      expect(warm.result.get("PULSE")).toEqual(cold.result.get("PULSE"));
      expectBounded(warm, 2 * PULSE_DAY + 64);
    });

    it("reads the full-history figures from the tier, checking it at its ends", async () => {
      const ledger = await explainWarm(() =>
        readAllTimeExtremes(ACCOUNT, [
          "WEIGHT",
          "BLOOD_PRESSURE_SYS",
          "BLOOD_PRESSURE_DIA",
          "PULSE",
        ]),
      );
      const pulse = ledger.result.get("PULSE");
      // The oldest pulse, five and a half years back, reads 30 to 39.
      expect(pulse?.min).toBe(30);
      expect(pulse?.max).toBe(94);
      expect(ledger.result.get("WEIGHT")?.max).toBe(78);
      // Two days of pulse at most (the oldest and the newest, each counted
      // against its bucket) and one row per sparse day. The history is 200,000.
      expectBounded(ledger, 2 * PULSE_DAY + 64);
    });

    it("probes a lapsed dense stream without aggregating its history", async () => {
      const ledger = await explainStatements(() =>
        probeCoachAvailability(
          ACCOUNT,
          new Map([
            ["spo2", { kind: "measurement", types: ["OXYGEN_SATURATION"] }],
            ["weight", { kind: "measurement", types: ["WEIGHT"] }],
          ]),
        ),
      );
      const spo2 = ledger.result.get("spo2");
      expect(spo2?.count).toBe(SPO2_ROWS);
      expect(spo2?.series).toEqual([
        expect.objectContaining({ unit: "%", min: 95, max: 98 }),
      ]);
      expect(spo2?.reachableWithWindow).toBe("last90days");
      expect(ledger.result.get("weight")?.count).toBe(SPARSE_DAYS);
      // A capped sample of each type, one oldest row each, and the two days
      // the tier is checked on for the dense one. The history is 30,000.
      expectBounded(ledger, 2 * (SAMPLE_CAP + 1) + 2 + 2 * SPO2_DAY + 2 + 64);
    });

    it("lists the metrics from presence probes, not the Coach snapshot", async () => {
      // The readings older than the fold window are counted once into a
      // closed block; the first call folds it, every later one reads it.
      await listMetricsTool.run(ctx, {});
      __resetCoachSnapshotCacheForTests();
      const windowFrom = () => new Date(Date.now() - 30 * DAY_MS);
      const before = windowFrom();
      const ledger = await explainStatements(() =>
        listMetricsTool.run(ctx, {}),
      );
      const after = windowFrom();
      const result = ledger.result as { metrics: InventoryRow[] };
      const row = (metric: string) =>
        result.metrics.find((m) => m.metric === metric);
      // The true count of the window, every reading, not a cap: between the
      // counts at the window's start just before and just after the call.
      expect(row("pulse")?.present).toBe(true);
      expect(row("pulse")?.count).toBeGreaterThanOrEqual(
        await liveCount("PULSE", after),
      );
      expect(row("pulse")?.count).toBeLessThanOrEqual(
        await liveCount("PULSE", before),
      );
      expect(row("weight")).toMatchObject({ present: true, count: 30 });
      expect(row("spo2")).toMatchObject({
        present: false,
        availability: { state: "outside_window", count: SPO2_ROWS },
      });
      expect(row("STRESS_LEVEL")).toMatchObject({
        present: true,
        count: STRESS_ROWS,
      });
      // Three days of pulse and of stress at most (the part of the first day
      // the window cuts, and the two days the tier is checked on), the oxygen
      // history's sample and tier ends, and the sparse types' month. The
      // history is 258,800.
      expectBounded(
        ledger,
        3 * PULSE_DAY +
          3 * STRESS_DAY +
          (SAMPLE_CAP + 1) +
          2 * SPO2_DAY +
          1_000,
      );
    });

    it("searches the domains without the Coach snapshot", async () => {
      // The first call folds the closed block (see `explainWarm`); the
      // snapshot cache is emptied after it so the measured call cannot be
      // answered from a snapshot the first one built.
      await searchTool.run(ctx, { query: "pulse" });
      __resetCoachSnapshotCacheForTests();
      const ledger = await explainStatements(() =>
        searchTool.run(ctx, { query: "pulse" }),
      );
      const result = ledger.result as { results: Array<{ id: string }> };
      expect(result.results.map((r) => r.id)).toContain("metric:pulse");
      expectBounded(ledger, 3 * PULSE_DAY + 1_000);
    });

    it("stamps the status gate's inputs from the tier, not the readings", async () => {
      const read = () =>
        computeStatusInputFingerprint({
          userId: ACCOUNT,
          types: ["PULSE"],
          includeCorrelationChannels: true,
        });
      // The readings older than the fold window are a closed block, folded
      // on the first read and kept.
      await read();
      const ledger = await explainStatements(read);
      expect(typeof ledger.result).toBe("string");
      // The tier's two end days of pulse and stress, and the sparse types'.
      expectBounded(ledger, 2 * PULSE_DAY + 2 * STRESS_DAY + 1_000);
    });

    it("counts the sync handshake's measurements exactly, from the tier and the tombstones", async () => {
      await countLiveMeasurements(ACCOUNT);
      const ledger = await explainStatements(async () => ({
        live: await countLiveMeasurements(ACCOUNT),
        tombstoned: await countTombstonedMeasurements(ACCOUNT),
      }));
      expect(ledger.result).toEqual({
        live: HISTORY_ROWS + SPARSE_DAYS * 6,
        tombstoned: 0,
      });
      expectBounded(
        ledger,
        2 * PULSE_DAY + 2 * STRESS_DAY + 2 * SPO2_DAY + 1_000,
      );
    });

    it("counts the discovery rows exactly from the tier", async () => {
      const ledger = await explainWarm(() =>
        metricStatusDiscoveryRows(ACCOUNT),
      );
      expect(
        ledger.result.find((r) => r.metric === "STRESS_LEVEL"),
      ).toMatchObject({ present: true, count: STRESS_ROWS });
      // The tier's two end days of stress; no reading predates the window.
      expectBounded(ledger, 2 * STRESS_DAY + 64);
    });
  },
);
