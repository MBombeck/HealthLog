/**
 * Migration 0504 (the seizure diary) run a second time.
 *
 * A host that ran a beta image already holds the diary's tables, types and
 * foreign keys under a different migration record, and a lock-timeout retry
 * re-runs the file from the top. Every statement in the file must then
 * change nothing instead of failing the boot: the types and tables were
 * guarded from the start, and the foreign keys must be too.
 *
 * The container this suite runs on has every migration applied already, so
 * running the file once more is exactly that second run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getPrismaClient } from "./setup";

const MIGRATION = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "0504_seizure_diary",
    "migration.sql",
  ),
  "utf8",
);

async function foreignKeys(): Promise<string[]> {
  const rows = await getPrismaClient().$queryRaw<Array<{ conname: string }>>`
    SELECT conname FROM pg_constraint
    WHERE contype = 'f' AND conname LIKE 'seizure_%'
    ORDER BY conname
  `;
  return rows.map((r) => r.conname);
}

describe("migration 0504 replayed", () => {
  it("runs again on a database that already holds the diary", async () => {
    const before = await foreignKeys();
    // Nine foreign keys: a guard that matched nothing would agree with an
    // empty schema.
    expect(before).toHaveLength(9);

    await getPrismaClient().$executeRawUnsafe(MIGRATION);

    expect(await foreignKeys()).toEqual(before);
  });
});
