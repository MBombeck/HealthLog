/**
 * The pre-migration dump decides whether to take a dump from the count of
 * pending migrations. A count that fails (a connect or statement timeout, a
 * database still starting up) used to read as "nothing pending": the step
 * exited 0 with no dump, and the migration a second later ran without its
 * way back. "Cannot tell" now takes the dump.
 *
 * The database is a stand-in: `createDatabaseDump` is a spy, `connect`
 * answers the two facts the step reads (an applied migration, some tables).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pendingMigrations = vi.fn<() => Promise<string[]>>();
const createDatabaseDump = vi.fn(async () => ({
  dumpPath: "/b/healthlog-20261025T013000Z-pre-migration.dump",
  manifest: { dump: { bytes: 1024 }, rowCounts: { "public.users": 1 } },
}));

vi.mock("../pending-migrations.mjs", () => ({
  pendingMigrations: () => pendingMigrations(),
}));
vi.mock("../../src/lib/database-backup/dump-core.mjs", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  connect: async () => ({
    query: async () => ({ rows: [] }),
    end: async () => {},
  }),
  latestMigration: async () => "0488_account_deletion_grace",
  listUserTables: async () => ["public.users"],
  createDatabaseDump: () => createDatabaseDump(),
  applyRetention: async () => [],
}));

import { preMigrationDump } from "../db-dump.mjs";

const env = {
  DATABASE_URL: "postgresql://u:p@db:5432/healthlog",
  DB_BACKUP_DIR: "/b",
};
const kept = () =>
  ({ writable: true, persistent: true, reason: "volume" }) as const;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  createDatabaseDump.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("the dump before migrating", () => {
  it("takes the dump when the pending migrations cannot be counted", async () => {
    pendingMigrations.mockRejectedValue(
      new Error("the database system is starting up"),
    );
    expect(await preMigrationDump(env, { directoryStatus: kept })).toBe(0);
    expect(createDatabaseDump).toHaveBeenCalledTimes(1);
  });

  it("takes none when nothing is pending", async () => {
    pendingMigrations.mockResolvedValue([]);
    expect(await preMigrationDump(env, { directoryStatus: kept })).toBe(0);
    expect(createDatabaseDump).not.toHaveBeenCalled();
  });

  it("takes one before pending migrations", async () => {
    pendingMigrations.mockResolvedValue(["0489_database_backup_run_key"]);
    expect(await preMigrationDump(env, { directoryStatus: kept })).toBe(0);
    expect(createDatabaseDump).toHaveBeenCalledTimes(1);
  });
});
