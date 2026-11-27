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
const createDatabaseDump = vi.fn<() => Promise<unknown>>(async () => ({
  dumpPath: "/b/healthlog-20261025T013000Z-pre-migration.dump",
  manifest: { dump: { bytes: 1024 }, rowCounts: { "public.users": 1 } },
}));
const assertClientServesServer = vi.fn<() => Promise<unknown>>(async () => ({
  clientMajor: 19,
  serverMajor: 18,
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
  assertClientServesServer: () => assertClientServesServer(),
  applyRetention: async () => [],
}));

import {
  ClientTooOldError,
  clientServerMismatch,
} from "../../src/lib/database-backup/dump-core.mjs";
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
  assertClientServesServer.mockClear();
});

/** What `pg_dump` 19 against a server on 20 is refused with. */
function tooOld() {
  const pair = { tool: "pg_dump", clientMajor: 19, serverMajor: 20 };
  return new ClientTooOldError(clientServerMismatch(pair) ?? "", pair);
}

function errorLines(): string {
  return vi
    .mocked(console.error)
    .mock.calls.map((c) => String(c[0]))
    .join("\n");
}
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

  // #1431: a server newer than the image's client stopped the boot with
  // pg_dump's own mismatch line. It stops the boot still, with its own exit
  // code, so the entrypoint does not restart it in a hot loop, and with one
  // message that names both majors.
  it("stops with its own exit code and one clear message when the server is newer than the client", async () => {
    pendingMigrations.mockResolvedValue(["0489_database_backup_run_key"]);
    createDatabaseDump.mockRejectedValueOnce(tooOld());
    expect(await preMigrationDump(env, { directoryStatus: kept })).toBe(3);
    const errors = errorLines();
    expect(errors).toMatch(
      /This image's PostgreSQL client \(pg_dump\) is 19; your server is 20\./,
    );
    expect(errors.match(/your server is 20/g)).toHaveLength(1);
    expect(errors).not.toContain("the database dump before migrating failed");
  });

  it("keeps exit 1 for any other failed dump", async () => {
    pendingMigrations.mockResolvedValue(["0489_database_backup_run_key"]);
    createDatabaseDump.mockRejectedValueOnce(new Error("No space left"));
    expect(await preMigrationDump(env, { directoryStatus: kept })).toBe(1);
  });

  it("warns at a boot with nothing to migrate that the nightly dump cannot work", async () => {
    pendingMigrations.mockResolvedValue([]);
    assertClientServesServer.mockRejectedValueOnce(tooOld());
    expect(await preMigrationDump(env, { directoryStatus: kept })).toBe(0);
    expect(createDatabaseDump).not.toHaveBeenCalled();
    expect(errorLines()).toMatch(
      /WARNING .*client \(pg_dump\) is 19; your server is 20\..*nightly database dump/,
    );
  });

  it("says nothing at such a boot when the client serves the server", async () => {
    pendingMigrations.mockResolvedValue([]);
    expect(await preMigrationDump(env, { directoryStatus: kept })).toBe(0);
    expect(assertClientServesServer).toHaveBeenCalledTimes(1);
    expect(errorLines()).toBe("");
  });
});
