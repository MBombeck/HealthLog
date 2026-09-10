import { describe, expect, it } from "vitest";
import {
  classifyOffhostBackup,
  OFFHOST_BACKUP_GRACE_HOURS,
  OFFHOST_BACKUP_PERIOD_HOURS,
} from "@/lib/jobs/offhost-backup-freshness";

const NOW = new Date("2026-09-10T09:00:00.000Z");
const HOUR = 3_600_000;
const PERIOD = OFFHOST_BACKUP_PERIOD_HOURS * HOUR;
const GRACE = OFFHOST_BACKUP_GRACE_HOURS * HOUR;

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

  it("is fresh right up to one period plus the grace and due one millisecond past it", () => {
    expect(
      classifyOffhostBackup({ lastSuccessAt: ago(PERIOD + GRACE), now: NOW })
        .freshness,
    ).toBe("fresh");
    expect(
      classifyOffhostBackup({
        lastSuccessAt: ago(PERIOD + GRACE + 1),
        now: NOW,
      }).freshness,
    ).toBe("due");
  });

  it("is due right up to two periods plus the grace and stale one millisecond past it", () => {
    expect(
      classifyOffhostBackup({
        lastSuccessAt: ago(PERIOD * 2 + GRACE),
        now: NOW,
      }).freshness,
    ).toBe("due");
    expect(
      classifyOffhostBackup({
        lastSuccessAt: ago(PERIOD * 2 + GRACE + 1),
        now: NOW,
      }).freshness,
    ).toBe("stale");
  });

  it("keeps the whole cohort fresh across the Berlin DST fall-back night", () => {
    // 2026-10-25 is the fall-back Sunday in Europe/Berlin: the clocks go back
    // at 03:00 CEST, so 02:30 local happens 25 hours after the previous
    // 02:30 local. Both instants are pinned in UTC because that is what the
    // ledger stores, and the test must not depend on the runner's own zone.
    const beforeTheChange = new Date("2026-10-24T00:30:00.000Z"); // 02:30 CEST
    const afterTheChange = new Date("2026-10-25T01:30:00.000Z"); // 02:30 CET
    const gapHours =
      (afterTheChange.getTime() - beforeTheChange.getTime()) / HOUR;
    expect(gapHours).toBe(25);

    // Without slack the whole cohort would read `due` on that one morning,
    // on every host, with nothing wrong anywhere.
    expect(
      classifyOffhostBackup({
        lastSuccessAt: beforeTheChange,
        now: afterTheChange,
      }).freshness,
    ).toBe("fresh");
  });

  it("still calls a genuinely missed night due", () => {
    // 31 hours: past one period even with six hours of slack, so a run that
    // produced nothing for this account still shows.
    expect(
      classifyOffhostBackup({ lastSuccessAt: ago(31 * HOUR), now: NOW })
        .freshness,
    ).toBe("due");
  });

  it("reports whole hours of age", () => {
    expect(
      classifyOffhostBackup({ lastSuccessAt: ago(90 * 60_000), now: NOW }),
    ).toEqual({ freshness: "fresh", ageHours: 1 });
  });

  it("honours a caller's own period rather than the nightly default", () => {
    // A six-hour schedule: the same 12-hour-old object that is fresh under the
    // nightly cron is two periods behind under this one. The grace is passed
    // as zero so the thresholds under test are the caller's period alone.
    const twelveHours = ago(12 * HOUR);
    expect(
      classifyOffhostBackup({ lastSuccessAt: twelveHours, now: NOW }).freshness,
    ).toBe("fresh");
    expect(
      classifyOffhostBackup({
        lastSuccessAt: twelveHours,
        now: NOW,
        periodHours: 6,
        graceHours: 0,
      }).freshness,
    ).toBe("due");
    expect(
      classifyOffhostBackup({
        lastSuccessAt: twelveHours,
        now: NOW,
        periodHours: 5,
        graceHours: 0,
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
