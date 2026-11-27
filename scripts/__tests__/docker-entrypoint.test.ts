/**
 * How `docker-entrypoint.sh` ends when the dump before migrating fails.
 *
 * `node` is a stand-in on PATH: every check the entrypoint runs with it
 * passes, `scripts/db-dump.mjs` exits with the code a case asks for, and
 * `scripts/migrate-deploy.mjs` leaves a mark, so a case can tell whether the
 * boot went on to migrate. The real dump step and its exit codes are in
 * `db-dump.test.ts` and `tests/integration/database-backup.test.ts`.
 *
 * A server newer than the image's `pg_dump` (#1431) is the failure a restart
 * cannot fix. With `restart: unless-stopped` an immediate exit restarted into
 * the same error every few seconds; the entrypoint now says why once and
 * waits before it exits, and `docker stop` still ends it at once.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const ENTRYPOINT = join(process.cwd(), "docker-entrypoint.sh");
const work = mkdtempSync(join(tmpdir(), "hl-entrypoint-"));
const bin = join(work, "bin");

mkdirSync(bin, { recursive: true });
writeFileSync(
  join(bin, "node"),
  `#!/bin/sh
case "$*" in
  *scripts/db-dump.mjs*)
    [ "$DUMP_EXIT" = 3 ] && echo "HealthLog: ERROR — This image's PostgreSQL client (pg_dump) is 19; your server is 20." >&2
    exit "$DUMP_EXIT" ;;
  *scripts/migrate-deploy.mjs*) : > "$MIGRATED_MARK"; exit 0 ;;
  *) exit 0 ;;
esac
`,
);
chmodSync(join(bin, "node"), 0o755);

afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  migrated: boolean;
  ms: number;
}

/**
 * Run the entrypoint with the dump step exiting `dumpExit`. With `stopAfter`,
 * SIGTERM is sent that many ms after the wait message appears, as
 * `docker stop` would.
 */
function boot(dumpExit: number, stopAfter?: number): Promise<Run> {
  const mark = join(work, `migrated-${dumpExit}-${Date.now()}`);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn("sh", [ENTRYPOINT, "true"], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/healthlog",
        API_TOKEN_HMAC_KEY: "hmac",
        ENCRYPTION_KEY: "a".repeat(64),
        DUMP_EXIT: String(dumpExit),
        MIGRATED_MARK: mark,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let stopping = false;
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => {
      stderr += String(c);
      if (stopAfter !== undefined && !stopping && /waiting/i.test(stderr)) {
        stopping = true;
        setTimeout(() => child.kill("SIGTERM"), stopAfter);
      }
    });
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the entrypoint did not end: ${stderr}`));
    }, 15_000);
    child.on("close", (code, signal) => {
      clearTimeout(guard);
      resolve({
        code,
        signal,
        stderr,
        stdout,
        migrated: existsSync(mark),
        ms: Date.now() - started,
      });
    });
  });
}

describe("the entrypoint when the dump before migrating fails", () => {
  it("migrates and starts after a dump that worked", async () => {
    const run = await boot(0);
    expect(run.code, run.stderr).toBe(0);
    expect(run.migrated).toBe(true);
  });

  it("stops at once, without migrating, after a dump that failed", async () => {
    const run = await boot(1);
    expect(run.code).toBe(1);
    expect(run.migrated).toBe(false);
    expect(run.stderr).toContain("not migrating without the dump");
    expect(run.stderr).not.toMatch(/waiting/i);
  });

  it("does not migrate, says why once, and waits instead of restarting into the same error, when the server is newer than the client", async () => {
    const run = await boot(3, 1500);
    // It was still waiting when it was stopped, and the stop ended it with
    // the entrypoint's own failure code rather than a kill.
    expect(run.ms).toBeGreaterThanOrEqual(1500);
    expect(run.signal).toBeNull();
    expect(run.code).toBe(1);
    expect(run.migrated).toBe(false);
    expect(run.stderr.match(/your server is 20/g)).toHaveLength(1);
    expect(run.stderr).toContain("cannot dump this database server");
    expect(run.stderr).toContain("DB_BACKUP_BEFORE_MIGRATE=false");
    expect(run.stderr).not.toContain("Free disk space");
  });
});
