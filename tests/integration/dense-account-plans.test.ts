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
const HISTORY_ROWS = PULSE_ROWS + SPO2_ROWS + STRESS_ROWS;

/** Readings a count or a sample stops at (the readers' own caps). */
const COUNT_CAP = 6_000;
const SAMPLE_CAP = 5_000;
/** Pulse readings in one UTC day, and oxygen readings. */
const PULSE_DAY = 720;
const SPO2_DAY = 144;

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

async function seedAccount(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements
       (id, user_id, type, value, unit, source, measured_at, updated_at)
     SELECT 'p' || i, $1, 'PULSE'::measurement_type, 55 + (i % 40), 'bpm',
            'APPLE_HEALTH'::measurement_source,
            now() - interval '1 minute' - i * interval '2 minutes', now()
       FROM generate_series(0, ${PULSE_ROWS - 1}) i
     UNION ALL
     SELECT 'o' || i, $1, 'OXYGEN_SATURATION'::measurement_type, 95 + (i % 4),
            '%', 'APPLE_HEALTH'::measurement_source,
            now() - interval '45 days' - i * interval '10 minutes', now()
       FROM generate_series(0, ${SPO2_ROWS - 1}) i
     UNION ALL
     SELECT 's' || i, $1, 'STRESS_LEVEL'::measurement_type, i % 100, 'score',
            'GARMIN'::measurement_source,
            now() - interval '2 minutes' - i * interval '3 minutes', now()
       FROM generate_series(0, ${STRESS_ROWS - 1}) i
     UNION ALL
     SELECT t || d, $1, t::measurement_type, 70 + (d % 9), 'x',
            'WITHINGS'::measurement_source,
            now() - d * interval '1 day' - interval '7 hours', now()
       FROM generate_series(0, ${SPARSE_DAYS - 1}) d,
            unnest(ARRAY['WEIGHT', 'BLOOD_PRESSURE_SYS', 'BLOOD_PRESSURE_DIA',
                         'RESTING_HEART_RATE', 'SLEEP_DURATION',
                         'ACTIVITY_STEPS']) t`,
    ACCOUNT,
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
  await prisma.$executeRawUnsafe(
    "INSERT INTO measurements SELECT * FROM dense_plans_stage",
  );
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

    it("reads the full-history figures from the tier, checking it at its ends", async () => {
      const ledger = await explainStatements(() =>
        readAllTimeExtremes(ACCOUNT, [
          "WEIGHT",
          "BLOOD_PRESSURE_SYS",
          "BLOOD_PRESSURE_DIA",
          "PULSE",
        ]),
      );
      const pulse = ledger.result.get("PULSE");
      expect(pulse?.min).toBe(55);
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
      __resetCoachSnapshotCacheForTests();
      const ledger = await explainStatements(() =>
        listMetricsTool.run(ctx, {}),
      );
      const result = ledger.result as { metrics: InventoryRow[] };
      const row = (metric: string) =>
        result.metrics.find((m) => m.metric === metric);
      expect(row("pulse")).toMatchObject({ present: true, count: COUNT_CAP });
      expect(row("weight")).toMatchObject({ present: true, count: 30 });
      expect(row("spo2")).toMatchObject({
        present: false,
        availability: { state: "outside_window", count: SPO2_ROWS },
      });
      expect(row("STRESS_LEVEL")).toMatchObject({
        present: true,
        count: COUNT_CAP,
      });
      // Pulse and stress to the count cap, the oxygen history's sample and
      // tier ends, and the sparse types' month. The history is 258,800.
      expectBounded(
        ledger,
        2 * COUNT_CAP + (SAMPLE_CAP + 1) + 2 * SPO2_DAY + 1_000,
      );
    });

    it("searches the domains without the Coach snapshot", async () => {
      __resetCoachSnapshotCacheForTests();
      const ledger = await explainStatements(() =>
        searchTool.run(ctx, { query: "pulse" }),
      );
      const result = ledger.result as { results: Array<{ id: string }> };
      expect(result.results.map((r) => r.id)).toContain("metric:pulse");
      expectBounded(ledger, COUNT_CAP + 1_000);
    });

    it("counts the discovery rows up to the cap", async () => {
      const ledger = await explainStatements(() =>
        metricStatusDiscoveryRows(ACCOUNT),
      );
      expect(
        ledger.result.find((r) => r.metric === "STRESS_LEVEL"),
      ).toMatchObject({ present: true, count: COUNT_CAP });
      expectBounded(ledger, COUNT_CAP + 64);
    });
  },
);
