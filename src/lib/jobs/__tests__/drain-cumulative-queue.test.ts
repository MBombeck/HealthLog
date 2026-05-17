/**
 * v1.4.37 W7c — pg-boss queue registration for the nightly drain of
 * per-sample APPLE_HEALTH cumulative rows. The drain helper exists
 * since v1.4.30 but only ran via the admin endpoint / CLI; the
 * scheduled wrapper closes the loop so the list view stops painting
 * hundreds of step chunks per day.
 *
 * Same source-text-grep approach as the Withings queue regression
 * guard so we never have to boot pg-boss + Prisma to assert the
 * scheduler wiring stays intact.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REMINDER_WORKER_PATH = join(__dirname, "..", "reminder-worker.ts");
const source = readFileSync(REMINDER_WORKER_PATH, "utf8");

describe("reminder-worker — drainPerSampleCumulative nightly schedule", () => {
  it("declares the drain queue at the documented Berlin cadence", () => {
    expect(source).toMatch(
      /DRAIN_CUMULATIVE_QUEUE\s*=\s*["']drain-per-sample-cumulative["']/,
    );
    // 03:45 Europe/Berlin — between audit-log cleanup (03:15) and the
    // feedback aggregator (04:00). Keep the slot stable so an operator
    // staring at the cron table can find the job easily.
    expect(source).toMatch(/DRAIN_CUMULATIVE_CRON\s*=\s*["']45 3 \* \* \*["']/);
  });

  it("passes the 36 hour grace window into the drain helper", () => {
    // v1.4.38 — the literal `36` lives in the helper module so the
    // worker, the admin route, and the CLI all read one source of
    // truth. The worker still references the constant by name in the
    // cutoffHours slot so the cron's behaviour is unchanged.
    expect(source).toMatch(/cutoffHours:\s*DRAIN_CUMULATIVE_CUTOFF_HOURS/);
  });

  it("imports the cutoff constant and the helper from the drain module", () => {
    // v1.4.38 — the import is now a multi-symbol form. Match the helper
    // and the constant separately so a future contributor who adds a
    // third symbol does not break the assertion.
    expect(source).toMatch(
      /from\s*["']@\/lib\/measurements\/drain-per-sample-cumulative["']/,
    );
    expect(source).toMatch(/\bdrainPerSampleCumulative\b/);
    expect(source).toMatch(/\bDRAIN_CUMULATIVE_CUTOFF_HOURS\b/);
  });

  it("registers a boss.work handler against the drain queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}DRAIN_CUMULATIVE_QUEUE[\s\S]{0,400}drainPerSampleCumulative/,
    );
  });

  it("schedules the drain cron via boss.schedule (allQueues + schedules)", () => {
    expect(source).toMatch(
      /\[DRAIN_CUMULATIVE_QUEUE,\s*DRAIN_CUMULATIVE_CRON\]/,
    );
  });

  it("registers the drain queue in the allQueues createQueue loop", () => {
    // pg-boss v12 requires explicit createQueue before scheduling. The
    // allQueues array drives the boot-time `for (const q of allQueues)`
    // loop; missing the entry silently no-ops the schedule below.
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bDRAIN_CUMULATIVE_QUEUE\b/);
  });
});
