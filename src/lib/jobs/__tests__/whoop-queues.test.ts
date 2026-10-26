/**
 * pg-boss queue registration for the WHOOP sync layer.
 *
 * Reads the worker registry instead of booting the worker: every WHOOP queue
 * is declared in the integration-sync group with its cron and handler, the
 * backfill forwards to the shared admission lane, and the boot discovery
 * offers it again. This is the fast guard for the dead-queue class (a queue
 * declared but never registered, which silently never drains).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INTEGRATION_BACKFILL_ADMISSION_QUEUE } from "@/lib/jobs/integration-backfill-admission";
import {
  WHOOP_CYCLE_SYNC_CRON,
  WHOOP_CYCLE_SYNC_QUEUE,
  WHOOP_OAUTH_STATE_CLEANUP_CRON,
  WHOOP_OAUTH_STATE_CLEANUP_QUEUE,
  WHOOP_RECOVERY_SYNC_CRON,
  WHOOP_RECOVERY_SYNC_QUEUE,
  WHOOP_SLEEP_SYNC_CRON,
  WHOOP_SLEEP_SYNC_QUEUE,
  WHOOP_WORKOUT_SYNC_CRON,
  WHOOP_WORKOUT_SYNC_QUEUE,
} from "@/lib/jobs/integration-poll-queues";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";
import {
  handleWhoopCycleSync,
  handleWhoopRecoverySync,
  handleWhoopSleepSync,
  handleWhoopWorkoutSync,
} from "@/lib/jobs/reminder/whoop-sync";
import {
  discoveryOf,
  groupOf,
  jobOf,
  loadedHandler,
  recordingBoss,
} from "@/lib/jobs/registry/__tests__/registry-helpers";
import { WHOOP_BACKFILL_QUEUE } from "@/lib/jobs/whoop-backfill-queue";

const handlerSource = readFileSync(
  join(__dirname, "..", "reminder", "whoop-sync.ts"),
  "utf8",
);

const WHOOP_QUEUES = [
  WHOOP_RECOVERY_SYNC_QUEUE,
  WHOOP_SLEEP_SYNC_QUEUE,
  WHOOP_WORKOUT_SYNC_QUEUE,
  WHOOP_CYCLE_SYNC_QUEUE,
  WHOOP_BACKFILL_QUEUE,
  WHOOP_OAUTH_STATE_CLEANUP_QUEUE,
] as const;

describe("WHOOP sync queues", () => {
  it("declares every WHOOP sync queue constant", () => {
    expect(WHOOP_RECOVERY_SYNC_QUEUE).toBe("whoop-recovery-sync");
    expect(WHOOP_SLEEP_SYNC_QUEUE).toBe("whoop-sleep-sync");
    expect(WHOOP_WORKOUT_SYNC_QUEUE).toBe("whoop-workout-sync");
    expect(WHOOP_CYCLE_SYNC_QUEUE).toBe("whoop-cycle-sync");
  });

  it("declares EVERY WHOOP queue in the integration-sync group", () => {
    for (const q of WHOOP_QUEUES) {
      expect(groupOf(q).name).toBe("integration_sync");
    }
  });

  it("schedules the four poll crons + the daily oauth-state sweep", () => {
    expect(jobOf(WHOOP_RECOVERY_SYNC_QUEUE).cron).toBe(
      WHOOP_RECOVERY_SYNC_CRON,
    );
    expect(jobOf(WHOOP_SLEEP_SYNC_QUEUE).cron).toBe(WHOOP_SLEEP_SYNC_CRON);
    expect(jobOf(WHOOP_WORKOUT_SYNC_QUEUE).cron).toBe(WHOOP_WORKOUT_SYNC_CRON);
    expect(jobOf(WHOOP_CYCLE_SYNC_QUEUE).cron).toBe(WHOOP_CYCLE_SYNC_CRON);
    const sweep = jobOf(WHOOP_OAUTH_STATE_CLEANUP_QUEUE);
    expect(sweep.cron).toBe(WHOOP_OAUTH_STATE_CLEANUP_CRON);
    expect(sweep.scheduleOptions).toBe(cronIsTheRetry);
  });

  it("binds a handler for every WHOOP sync queue", async () => {
    expect(await loadedHandler(WHOOP_RECOVERY_SYNC_QUEUE)).toBe(
      handleWhoopRecoverySync,
    );
    expect(await loadedHandler(WHOOP_SLEEP_SYNC_QUEUE)).toBe(
      handleWhoopSleepSync,
    );
    expect(await loadedHandler(WHOOP_WORKOUT_SYNC_QUEUE)).toBe(
      handleWhoopWorkoutSync,
    );
    expect(await loadedHandler(WHOOP_CYCLE_SYNC_QUEUE)).toBe(
      handleWhoopCycleSync,
    );
    const { boss, sends } = recordingBoss();
    const backfill = await jobOf(WHOOP_BACKFILL_QUEUE).load({ boss });
    await backfill([
      {
        id: "j1",
        name: WHOOP_BACKFILL_QUEUE,
        data: { userId: "u1" },
        expireInSeconds: 60,
        heartbeatSeconds: null,
        retryCount: 0,
        signal: new AbortController().signal,
      },
    ]);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.queue).toBe(INTEGRATION_BACKFILL_ADMISSION_QUEUE);
    expect(sends[0]!.data).toMatchObject({ kind: "whoop-backfill" });
  });

  it("wires the self-converging WHOOP backfill boot discovery", () => {
    expect(discoveryOf("integration_sync")).toContain("whoop-backfill");
  });

  it("imports the WHOOP per-resource sync routines", () => {
    expect(handlerSource).toMatch(
      /from\s*["']@\/lib\/whoop\/sync-recovery["']/,
    );
    expect(handlerSource).toMatch(/from\s*["']@\/lib\/whoop\/sync-cycle["']/);
    expect(handlerSource).toMatch(/from\s*["']@\/lib\/whoop\/sync-workout["']/);
  });
});
