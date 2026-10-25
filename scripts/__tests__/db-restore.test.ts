/**
 * The restore's refusals, which all come before it writes anything.
 *
 * The database is a stand-in here: `connect` answers a client whose only use
 * is to be asked which tables exist, and `runTool` (which would run
 * `pg_restore`) is a spy that must never be called on a refusal. The real
 * restore into a real empty database, and its refusal of a real database with
 * tables, are in `tests/integration/database-backup.test.ts` and in the
 * compose drill (`scripts/compose-dr-drill.sh`).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tablesInTarget = vi.fn(async (): Promise<string[]> => []);
const runTool = vi.fn(async () => "");
const end = vi.fn(async () => {});

vi.mock("../../src/lib/database-backup/dump-core.mjs", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  connect: async () => ({ query: async () => ({ rows: [] }), end }),
  listUserTables: () => tablesInTarget(),
  runTool: (...args: unknown[]) => runTool(...(args as [])),
}));

import { buildManifest } from "../../src/lib/database-backup/dump-core.mjs";
import { main } from "../db-restore.mjs";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const BASE = "healthlog-20261025T013000Z-daily";

let dir: string;
let errors: string[];
let lines: string[];

function env(extra: Record<string, string> = {}) {
  return {
    DATABASE_URL: "postgresql://healthlog:pw@db:5432/healthlog?schema=public",
    DB_BACKUP_DIR: dir,
    ENCRYPTION_KEY: KEY_A,
    API_TOKEN_HMAC_KEY: "hmac",
    ...extra,
  };
}

/** A dump file and a manifest that describes it, written with KEY_A. */
function writeDump(body = Buffer.from("PGDMP not really an archive")) {
  writeFileSync(join(dir, `${BASE}.dump`), body);
  const manifest = buildManifest({
    kind: "daily",
    file: `${BASE}.dump`,
    createdAt: new Date("2026-10-25T01:30:00Z"),
    appVersion: "1.46.0",
    buildSha: null,
    latestMigration: "0486_database_backup_runs",
    server: { version: "18.6", versionNum: 180006 },
    pgDump: null,
    archive: {
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      entries: 1,
    },
    rowCounts: { "public.users": 2 },
    env: { ENCRYPTION_KEY: KEY_A, API_TOKEN_HMAC_KEY: "hmac" },
  });
  writeFileSync(
    join(dir, `${BASE}.manifest.json`),
    JSON.stringify(manifest, null, 2),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hl-db-restore-"));
  errors = [];
  lines = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    errors.push(String(line));
  });
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(String(line));
  });
  tablesInTarget.mockResolvedValue([]);
  runTool.mockClear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("db-restore refuses before it writes", () => {
  it("refuses a target database that already holds tables", async () => {
    writeDump();
    tablesInTarget.mockResolvedValue(["public.users", "public.sessions"]);
    expect(await main(["latest"], env())).toBe(1);
    expect(errors.join("\n")).toMatch(
      /already holds 2 tables .*only into an empty database/,
    );
    expect(runTool).not.toHaveBeenCalled();
  });

  it("refuses when the active encryption key is not the dump's, and names it", async () => {
    writeDump();
    expect(await main(["latest"], env({ ENCRYPTION_KEY: KEY_B }))).toBe(1);
    expect(lines.join("\n")).toMatch(/KEY MISMATCH: ENCRYPTION_KEYS\[v1\]/);
    expect(errors.join("\n")).toMatch(/refusing to restore/);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("goes past the key check with --ignore-key-mismatch, and still refuses a full database", async () => {
    writeDump();
    tablesInTarget.mockResolvedValue(["public.users"]);
    expect(
      await main(
        ["latest", "--ignore-key-mismatch"],
        env({ ENCRYPTION_KEY: KEY_B }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/already holds 1 table /);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("refuses a dump that does not match its manifest", async () => {
    writeDump();
    writeFileSync(join(dir, `${BASE}.dump`), "PGDMP altered");
    expect(await main(["latest"], env())).toBe(1);
    expect(errors.join("\n")).toMatch(/does not match its manifest/);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("refuses a dump without its manifest, and a file it did not write", async () => {
    writeFileSync(join(dir, `${BASE}.dump`), "x");
    expect(await main([`${BASE}.dump`], env())).toBe(1);
    expect(errors.join("\n")).toMatch(/manifest.json is missing/);
    writeFileSync(join(dir, "other.dump"), "x");
    expect(await main(["other.dump"], env())).toBe(1);
    expect(errors.join("\n")).toMatch(/not a HealthLog database dump/);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("says when there is nothing to restore, and how it is used", async () => {
    expect(await main(["latest"], env())).toBe(1);
    expect(errors.join("\n")).toMatch(/no restorable dump/);
    expect(await main([], env())).toBe(2);
  });

  it("lists what is there", async () => {
    writeDump();
    expect(await main(["list"], env())).toBe(0);
    expect(lines.join("\n")).toContain(`${BASE}.dump  daily`);
  });
});
