/**
 * `oldestSeenAt` on `GET /api/integrations/healthkit` costs two index probes
 * per type, not a scan of the account's history.
 *
 * The iPhone app's history walk jumps to the oldest Apple Health reading the
 * server holds of a type (iOS #191), so the read answers it on every config
 * read. It rides the statement that already finds the newest reading of each
 * type: one `LIMIT 1` probe from each end of the live `(user_id, type,
 * measured_at …)` index. A probe reads past the rows of other sources at its
 * end of the range, the same as the newest-reading probe always has, and
 * never another account's rows or the middle of a dense stream.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getSourceFreshness } from "@/lib/integrations/metric-freshness";

import { getPrismaClient, truncateAllTables } from "./setup";
import { describeLedger, explainStatements } from "./statement-plans";

const prisma = () => getPrismaClient();
const ACCOUNT = "oldest-seen-account";
const NEIGHBOUR = "oldest-seen-neighbour";
const PULSE_ROWS = 20_000;
/** Hand-entered weights older than the first one from Apple Health. */
const MANUAL_WEIGHTS = 50;
const START = Date.UTC(2023, 0, 1);

async function seed(userId: string): Promise<void> {
  await prisma().user.create({
    data: { id: userId, username: userId, email: `${userId}@example.test` },
  });
  // A dense Apple Health heart-rate stream, one reading a minute.
  await prisma().$executeRawUnsafe(
    `INSERT INTO measurements
       (id, user_id, type, value, unit, source, measured_at, updated_at)
     SELECT $1 || '-p' || i, $1, 'PULSE'::measurement_type, 60 + (i % 25),
            'bpm', 'APPLE_HEALTH'::measurement_source,
            to_timestamp($2::double precision / 1000) + i * interval '1 minute',
            now()
       FROM generate_series(1, $3::int) AS i`,
    userId,
    START,
    PULSE_ROWS,
  );
  // Weights: the oldest by hand, then a few from Apple Health.
  await prisma().measurement.createMany({
    data: [
      ...Array.from({ length: MANUAL_WEIGHTS }, (_, i) => ({
        userId,
        type: "WEIGHT" as const,
        value: 80,
        unit: "kg",
        source: "MANUAL" as const,
        measuredAt: new Date(START - (MANUAL_WEIGHTS - i) * 86_400_000),
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        userId,
        type: "WEIGHT" as const,
        value: 79,
        unit: "kg",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(START + (i + 1) * 86_400_000),
      })),
    ],
  });
  // An older Apple Health reading that was deleted does not count.
  await prisma().measurement.create({
    data: {
      userId,
      type: "PULSE",
      value: 70,
      unit: "bpm",
      source: "APPLE_HEALTH",
      measuredAt: new Date(START - 400 * 86_400_000),
      deletedAt: new Date(),
    },
  });
}

beforeAll(async () => {
  await truncateAllTables(prisma());
  await seed(ACCOUNT);
  await seed(NEIGHBOUR);
  await prisma().$executeRawUnsafe("ANALYZE measurements");
});

afterAll(async () => {
  await truncateAllTables(prisma());
});

describe("oldestSeenAt", () => {
  it("is the oldest live Apple Health reading of each type", async () => {
    const samples = await getSourceFreshness(ACCOUNT, "APPLE_HEALTH");
    const byType = Object.fromEntries(samples.map((s) => [s.type, s]));
    expect(byType.PULSE?.oldestSeenAt).toBe(
      new Date(START + 60_000).toISOString(),
    );
    expect(byType.WEIGHT?.oldestSeenAt).toBe(
      new Date(START + 86_400_000).toISOString(),
    );
  });

  it("probes the index from both ends instead of reading the history", async () => {
    const ledger = await explainStatements(() =>
      getSourceFreshness(ACCOUNT, "APPLE_HEALTH"),
    );
    const probe = ledger.plans.find((p) =>
      p.text.startsWith('SELECT live."type"'),
    );
    expect(probe, describeLedger(ledger)).toBeDefined();
    expect(probe!.seqScan, describeLedger(ledger)).toBe(false);
    // Per type one row from each end, plus the hand-entered weights the
    // oldest-weight probe passes on its way to the first Apple Health one;
    // never the twenty thousand heart-rate rows between the ends.
    expect(probe!.rowVisits, describeLedger(ledger)).toBeLessThanOrEqual(
      2 * 2 + MANUAL_WEIGHTS + 2,
    );
    // Either `(user_id, type, measured_at …)` index serves: the live one, or
    // the natural-identity one, which skips to the source within a type.
    expect(JSON.stringify(probe!.plan)).toMatch(
      /measurements_live_covering_idx|measurements_user_id_type_measured_at_source_sleep_stage_key/,
    );
  });
});
