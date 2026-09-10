import { describe, expect, it } from "vitest";
import {
  classifyOffhostBackup,
  OFFHOST_BACKUP_PERIOD_HOURS,
} from "@/lib/jobs/offhost-backup-freshness";

const NOW = new Date("2026-09-10T09:00:00.000Z");
const HOUR = 3_600_000;
const PERIOD = OFFHOST_BACKUP_PERIOD_HOURS * HOUR;

/** `age` hours before NOW. */
function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe("classifyOffhostBackup", () => {
  it("says never when the worker has put nothing there for this account", () => {
    expect(classifyOffhostBackup({ lastSuccessAt: null, now: NOW })).toEqual({
      freshness: "never",
      ageHours: null,
    });
  });

  it("is fresh right up to the one-period boundary and due one millisecond past it", () => {
    expect(
      classifyOffhostBackup({ lastSuccessAt: ago(PERIOD), now: NOW }).freshness,
    ).toBe("fresh");
    expect(
      classifyOffhostBackup({ lastSuccessAt: ago(PERIOD + 1), now: NOW })
        .freshness,
    ).toBe("due");
  });

  it("is due right up to the two-period boundary and stale one millisecond past it", () => {
    expect(
      classifyOffhostBackup({ lastSuccessAt: ago(PERIOD * 2), now: NOW })
        .freshness,
    ).toBe("due");
    expect(
      classifyOffhostBackup({ lastSuccessAt: ago(PERIOD * 2 + 1), now: NOW })
        .freshness,
    ).toBe("stale");
  });

  it("reports whole hours of age", () => {
    expect(
      classifyOffhostBackup({ lastSuccessAt: ago(90 * 60_000), now: NOW }),
    ).toEqual({ freshness: "fresh", ageHours: 1 });
  });

  it("honours a caller's own period rather than the nightly default", () => {
    // A six-hour schedule: the same 12-hour-old object that is fresh under the
    // nightly cron is two periods behind under this one.
    const twelveHours = ago(12 * HOUR);
    expect(
      classifyOffhostBackup({ lastSuccessAt: twelveHours, now: NOW }).freshness,
    ).toBe("fresh");
    expect(
      classifyOffhostBackup({
        lastSuccessAt: twelveHours,
        now: NOW,
        periodHours: 6,
      }).freshness,
    ).toBe("due");
    expect(
      classifyOffhostBackup({
        lastSuccessAt: twelveHours,
        now: NOW,
        periodHours: 5,
      }).freshness,
    ).toBe("stale");
  });

  it("does not call a copy stale because the host clock ran backwards", () => {
    expect(
      classifyOffhostBackup({
        lastSuccessAt: new Date(NOW.getTime() + 2 * HOUR),
        now: NOW,
      }),
    ).toEqual({ freshness: "fresh", ageHours: 0 });
  });
});
