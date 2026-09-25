/**
 * Issue #1031: three queues failed with `job timed out` night after night and
 * the operator found no line about any of them in the app log. These tests
 * pin the lines `observeJob` now writes — progress while a job runs, a warning
 * at its expiry, and a closing line for a long or expired run — and the boot
 * line naming jobs a previous process was running when it stopped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emitted: [] as Array<{
    level: string;
    background?: { task_name?: string };
    meta?: Record<string, unknown>;
  }>,
  active: vi.fn(),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: (event: (typeof mocks.emitted)[number]) => {
    mocks.emitted.push(event);
  },
}));
vi.mock("@/lib/jobs/job-failures", () => ({
  readActiveJobsStartedBefore: mocks.active,
}));

import {
  JOB_LONG_RUN_MS,
  JOB_PROGRESS_INTERVAL_MS,
  observeJob,
  reportJobProgress,
  reportJobsCutOffAtBoot,
  type JobObserverClock,
} from "@/lib/jobs/job-observer";

/** A manual clock: `advance` fires due timers in order. */
function manualClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<
    number,
    { at: number; every: number | null; fn: () => void }
  >();
  const clock: JobObserverClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, every: null, fn });
      return seq;
    },
    setInterval: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, every: ms, fn });
      return seq;
    },
    clearTimeout: (handle) => timers.delete(handle as number),
    clearInterval: (handle) => timers.delete(handle as number),
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every === null) timers.delete(id);
      else timer.at += timer.every;
      timer.fn();
    }
    now = target;
  };
  return { clock, advance };
}

function lines(task: string) {
  return mocks.emitted.filter((e) => e.background?.task_name === task);
}

beforeEach(() => {
  mocks.emitted.length = 0;
  mocks.active.mockReset();
});

describe("observeJob", () => {
  it("writes progress while a long job runs, a warning at its expiry, and a closing line", async () => {
    const { clock, advance } = manualClock();
    let release!: (value: { ok: true; did: { days: number } }) => void;

    const running = observeJob(
      "dense-intraday-retention",
      [{ id: "job-1", expireInSeconds: 900 }],
      () =>
        new Promise<{ ok: true; did: { days: number } }>((resolve) => {
          reportJobProgress({ consolidation_day: "2024-03-01" });
          release = resolve;
        }),
      clock,
    );

    advance(JOB_PROGRESS_INTERVAL_MS);
    expect(lines("job.progress")).toHaveLength(1);
    expect(lines("job.progress")[0]!.meta).toMatchObject({
      queue: "dense-intraday-retention",
      job_ids: "job-1",
      expire_s: 900,
      consolidation_day: "2024-03-01",
    });
    expect(lines("job.progress")[0]!.meta?.heap_used_mb).toEqual(
      expect.any(Number),
    );

    advance(900 * 1000 - JOB_PROGRESS_INTERVAL_MS);
    const expired = lines("job.expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]!.level).toBe("warn");
    expect(expired[0]!.meta).toMatchObject({
      queue: "dense-intraday-retention",
      elapsed_s: 900,
      consolidation_day: "2024-03-01",
    });

    release({ ok: true, did: { days: 12 } });
    await running;
    const finished = lines("job.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]!.level).toBe("warn");
    expect(finished[0]!.meta).toMatchObject({
      queue: "dense-intraday-retention",
      finished_after_expiry: true,
      outcome: "completed",
      did: { days: 12 },
    });
  });

  it("stays silent for a short job", async () => {
    const { clock } = manualClock();
    await observeJob(
      "host-metric-sample",
      [{ id: "j", expireInSeconds: 900 }],
      async () => ({ ok: true }),
      clock,
    );
    expect(mocks.emitted).toEqual([]);
  });

  it("closes a long job that threw with the error, and rethrows it", async () => {
    const { clock, advance } = manualClock();
    const running = observeJob(
      "data-backup",
      [{ id: "b", expireInSeconds: 7200 }],
      async () => {
        advance(JOB_LONG_RUN_MS);
        throw new Error("write failed");
      },
      clock,
    );
    await expect(running).rejects.toThrow("write failed");
    expect(lines("job.finished")[0]!.meta).toMatchObject({
      queue: "data-backup",
      outcome: "threw",
      error: "write failed",
    });
    expect(lines("job.expired")).toEqual([]);
  });
});

describe("reportJobsCutOffAtBoot", () => {
  it("names each job a previous process was running", async () => {
    mocks.active.mockResolvedValue([
      {
        queue: "data-backup",
        id: "a",
        startedAt: "2026-09-24T09:36:00.000Z",
        expireSeconds: 7200,
      },
    ]);
    await reportJobsCutOffAtBoot(new Date("2026-09-24T10:00:00.000Z"));
    const line = lines("worker.boot.jobs_cut_off");
    expect(line).toHaveLength(1);
    expect(line[0]!.level).toBe("warn");
    expect(line[0]!.meta).toMatchObject({
      jobs_cut_off: 1,
      queues: "data-backup",
    });
    expect(String(line[0]!.meta?.jobs)).toContain(
      "data-backup@2026-09-24T09:36:00.000Z",
    );
  });

  it("stays silent when nothing was cut off, or there is no queue schema", async () => {
    mocks.active.mockResolvedValueOnce([]);
    await reportJobsCutOffAtBoot();
    mocks.active.mockResolvedValueOnce(null);
    await reportJobsCutOffAtBoot();
    expect(mocks.emitted).toEqual([]);
  });
});
