/**
 * The external-id prefix match the integration deletes and sweeps run
 * (`external_id LIKE '<prefix>%'` for one account and source) has an index
 * that serves it: migration 0518. Without `text_pattern_ops` no B-tree can
 * answer a LIKE under the database's collation, and the read walked every
 * live reading of the account.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

// An account with readings from three sources, so the planner has the
// statistics to tell the indexes apart.
beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$executeRaw`
    INSERT INTO users (id, username, role, created_at, updated_at)
    VALUES ('u', 'prefix-index', 'USER', now(), now())`;
  await prisma.$executeRaw`
    INSERT INTO measurements
      (id, user_id, type, value, unit, measured_at, source, external_id, created_at, updated_at)
    SELECT 'm' || n, 'u', 'PULSE', 60, 'bpm', now() - n * interval '1 minute',
           (ARRAY['WHOOP', 'OURA', 'APPLE_HEALTH'])[1 + n % 3]::measurement_source,
           'r' || (n / 10) || ':f' || n, now(), now()
      FROM generate_series(1, 20000) AS n`;
  await prisma.$executeRawUnsafe("ANALYZE measurements");
});

afterAll(async () => {
  await truncateAllTables(prisma);
});

async function plan(sql: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    // Sequential scans off: the question is whether an index CAN serve the
    // shape, not what the planner picks on an empty table.
    await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
    await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
    const rows = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN ${sql}`,
    );
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  });
}

describe("measurements external-id prefix index", () => {
  it("serves an account's prefix match by source", async () => {
    const text = await plan(
      `SELECT id FROM measurements
        WHERE user_id = 'u' AND source = 'WHOOP' AND deleted_at IS NULL
          AND external_id LIKE 'r123:%'`,
    );
    expect(text).toContain("measurements_user_source_external_id_live_idx");
    expect(text).toMatch(/Index Cond: .*external_id ~>=~/);
  });

  it("serves the equality form too", async () => {
    const text = await plan(
      `SELECT id FROM measurements
        WHERE user_id = 'u' AND source = 'OURA' AND deleted_at IS NULL
          AND external_id = ANY (ARRAY['sleep:1', 'sleep:2'])`,
    );
    expect(text).toMatch(
      /measurements_user_source_external_id_live_idx|measurements_user_id_type_source_external_id_key/,
    );
  });
});
