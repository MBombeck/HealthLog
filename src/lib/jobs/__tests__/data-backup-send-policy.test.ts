/**
 * Send-policy pins for the weekly `data-backup` queue.
 *
 * The queue was registered with no send options at all, so every job it minted
 * inherited pg-boss's queue defaults — `expireInSeconds: 900`, `retryLimit: 2`.
 * A full-record snapshot of a large account does not fit in fifteen minutes, so
 * the pass was killed mid-run, redelivered twice against the same record, and
 * gave up roughly 46 minutes after it started. Weekly, silently, for as long as
 * the record stayed large.
 *
 * Three facts have to hold together or the window is not real:
 *
 *   1. the policy names a window well past the 15-minute default,
 *   2. the CRON SCHEDULE carries it — send options ride the schedule because
 *      pg-boss's `create_queue()` ends in ON CONFLICT DO NOTHING, so a
 *      queue-level default would be inert on every already-running instance,
 *   3. the admin "run now" route sends with the same options, or an ad-hoc
 *      snapshot silently keeps the default that broke the cron one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BACKUP_HEARTBEAT_SECONDS,
  DATA_BACKUP_QUEUE,
  DATA_BACKUP_SEND_OPTIONS,
} from "../data-backup-policy";
import {
  OFFHOST_BACKUP_QUEUE,
  OFFHOST_BACKUP_SEND_OPTIONS,
} from "../offhost-backup";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("data-backup — pg-boss send policy", () => {
  it("widens the expiration far past the 15-minute queue default", () => {
    expect(DATA_BACKUP_QUEUE).toBe("data-backup");
    // 900 s is the pg-boss 12.26 queue default (`QUEUE_DEFAULTS.expire_seconds`
    // in `dist/plans.js`); anything at or below it re-opens the bug.
    expect(DATA_BACKUP_SEND_OPTIONS.expireInSeconds).toBeGreaterThan(900);
    expect(DATA_BACKUP_SEND_OPTIONS.expireInSeconds).toBeGreaterThanOrEqual(
      60 * 60,
    );
  });

  it("notices a process that died under either pass within minutes, not hours", () => {
    // pg-boss refuses less than ten seconds; more than a few minutes and a
    // dead pass sits `active` for as long as an operator would look.
    expect(BACKUP_HEARTBEAT_SECONDS).toBeGreaterThanOrEqual(10);
    expect(BACKUP_HEARTBEAT_SECONDS).toBeLessThanOrEqual(10 * 60);
    expect(DATA_BACKUP_SEND_OPTIONS.heartbeatSeconds).toBe(
      BACKUP_HEARTBEAT_SECONDS,
    );
    expect(OFFHOST_BACKUP_QUEUE).toBe("data-backup-offhost");
    expect(OFFHOST_BACKUP_SEND_OPTIONS.heartbeatSeconds).toBe(
      BACKUP_HEARTBEAT_SECONDS,
    );
  });

  it("the weekly and nightly schedules carry the policy", () => {
    const source = read("src/lib/jobs/reminder/register-maintenance.ts");
    expect(source).toMatch(
      /\[\s*DATA_BACKUP_QUEUE,\s*DATA_BACKUP_CRON,\s*DATA_BACKUP_SEND_OPTIONS,?\s*\]/,
    );
    expect(source).toMatch(
      /\[\s*OFFHOST_BACKUP_QUEUE,\s*OFFHOST_BACKUP_CRON,\s*OFFHOST_BACKUP_SEND_OPTIONS,?\s*\]/,
    );
  });

  it("the admin run-now route sends with the same policy", () => {
    const source = read("src/app/api/admin/backups/run/route.ts");
    expect(source).toMatch(
      /boss\.send\(\s*DATA_BACKUP_QUEUE,[\s\S]{0,200}DATA_BACKUP_SEND_OPTIONS,?\s*\)/,
    );
  });
});
