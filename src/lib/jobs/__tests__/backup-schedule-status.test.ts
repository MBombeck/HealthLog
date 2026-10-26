/**
 * What the backups page has to be able to say out loud.
 *
 * The weekly snapshot stopped producing a new copy and nothing surfaced it: the
 * page listed the rows it had, each with a perfectly ordinary timestamp, and a
 * copy that was a month and a half old looked exactly like one made on Sunday.
 * The two facts that would have shown it are the age of the newest scheduled
 * copy and the terminal state of the last scheduled run.
 */
import { describe, expect, it } from "vitest";

import {
  BACKUP_STALE_AFTER_DAYS,
  summariseBackupSchedule,
} from "../backup-schedule-status";

const NOW = new Date("2026-09-03T09:00:00.000Z");
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

describe("summariseBackupSchedule", () => {
  it("reports a fresh weekly copy as neither stale nor failed", () => {
    const status = summariseBackupSchedule({
      scheduledCreatedAt: [daysAgo(2), daysAgo(9)],
      lastRun: {
        at: daysAgo(2).toISOString(),
        state: "completed",
        error: null,
      },
      now: NOW,
    });

    expect(status.lastSuccessAt).toBe(daysAgo(2).toISOString());
    expect(status.lastSuccessAgeDays).toBe(2);
    expect(status.stale).toBe(false);
    expect(status.lastRunFailed).toBe(false);
    expect(status.staleAfterDays).toBe(BACKUP_STALE_AFTER_DAYS);
  });

  it("calls a copy older than the window stale", () => {
    const status = summariseBackupSchedule({
      scheduledCreatedAt: [daysAgo(46)],
      lastRun: null,
      now: NOW,
    });

    expect(status.lastSuccessAgeDays).toBe(46);
    expect(status.stale).toBe(true);
    // No run row survives that long — the age is the durable signal.
    expect(status.lastRunFailed).toBe(false);
  });

  it("draws the line where the readiness model does: past nine days", () => {
    const at = (ms: number) =>
      summariseBackupSchedule({
        scheduledCreatedAt: [new Date(NOW.getTime() - ms)],
        lastRun: null,
        now: NOW,
      }).stale;
    const DAY = 24 * 60 * 60 * 1000;
    expect(BACKUP_STALE_AFTER_DAYS).toBe(9);
    expect(at(9 * DAY)).toBe(false);
    expect(at(9 * DAY + 1)).toBe(true);
  });

  it("surfaces a failed last run even while the copy is still in window", () => {
    const status = summariseBackupSchedule({
      scheduledCreatedAt: [daysAgo(3)],
      lastRun: {
        at: daysAgo(1).toISOString(),
        state: "failed",
        error: "job timed out",
      },
      now: NOW,
    });

    expect(status.stale).toBe(false);
    expect(status.lastRunFailed).toBe(true);
    expect(status.lastRun?.error).toBe("job timed out");
  });

  it("does not call a brand-new instance stale", () => {
    const status = summariseBackupSchedule({
      scheduledCreatedAt: [],
      lastRun: null,
      now: NOW,
    });

    expect(status.lastSuccessAt).toBeNull();
    expect(status.lastSuccessAgeDays).toBeNull();
    expect(status.stale).toBe(false);
  });

  it("ignores manual uploads when judging the scheduled cadence", () => {
    // The caller passes only WEEKLY_AUTO rows; a manual upload made today must
    // not make a dead cron look alive. Proven here by the shape of the input:
    // the summary knows nothing but scheduled copies.
    const status = summariseBackupSchedule({
      scheduledCreatedAt: [daysAgo(30)],
      lastRun: null,
      now: NOW,
    });
    expect(status.stale).toBe(true);
  });
});
