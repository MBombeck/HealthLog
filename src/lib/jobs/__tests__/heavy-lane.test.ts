/**
 * The heavy lane runs one heavy job at a time per process. A job that finds
 * the lane taken goes back to its queue at once instead of waiting in the
 * handler, where its expiry would run down while it stood in line.
 */
import { describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logging/signal", () => ({ emitSignal: vi.fn() }));
const memory = vi.hoisted(() => ({ pressure: false }));
vi.mock("@/lib/observability/container-memory", () => ({
  memoryPressureActive: () => memory.pressure,
}));

import { emitSignal } from "@/lib/logging/signal";
import {
  heavyLane,
  LANE_HOLD_GRACE_SECONDS,
  LANE_WAIT_WARN_MS,
  laneWanted,
} from "../heavy-lane";
import { jobDone } from "../job-outcome";

type TestJob = Job<{ force?: boolean }>;

function job(id = "j", data: { force?: boolean } = {}): TestJob {
  return { id, data } as unknown as TestJob;
}

/** A handler that runs until `finish` is called, recording the overlap. */
function gate(log: string[], name: string) {
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const handler = vi.fn(async () => {
    log.push(`start:${name}`);
    await done;
    log.push(`end:${name}`);
    return jobDone({ jobs: 1 });
  });
  return { handler, finish };
}

/** A stand-in for the way back to the queue, recording what went back. */
function deferrals() {
  const back: Array<{ queue: string; ids: string[] }> = [];
  const defer = vi.fn(async (queue: string, jobs: readonly TestJob[]) => {
    back.push({ queue, ids: jobs.map((j) => j.id) });
    return { deferred: jobs.length, oldestCreatedOn: null };
  });
  return { back, defer };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("heavyLane", () => {
  it("sends a heavy job back to its queue while another holds the lane", async () => {
    const log: string[] = [];
    const a = gate(log, "import");
    const b = gate(log, "backup");
    const { back, defer } = deferrals();
    const running = heavyLane(
      "apple-health-import-v2",
      a.handler,
      undefined,
      defer,
    )([job("upload")]);
    await tick();
    const outcome = await heavyLane(
      "data-backup",
      b.handler,
      undefined,
      defer,
    )([job("weekly")]);
    // It returned at once, without running and without waiting.
    expect(outcome).toMatchObject({ ok: true, did: { lane_deferred: 1 } });
    expect(b.handler).not.toHaveBeenCalled();
    expect(back).toEqual([{ queue: "data-backup", ids: ["weekly"] }]);
    a.finish();
    await running;
    // Once the lane is free the redelivered job runs.
    const again = heavyLane(
      "data-backup",
      b.handler,
      undefined,
      defer,
    )([job("weekly")]);
    await tick();
    b.finish();
    await again;
    expect(log).toEqual([
      "start:import",
      "end:import",
      "start:backup",
      "end:backup",
    ]);
    expect(defer).toHaveBeenCalledTimes(1);
  });

  it("lets a light job of a heavy queue pass the lane", async () => {
    const log: string[] = [];
    const a = gate(log, "walk");
    const b = gate(log, "warm");
    const { defer } = deferrals();
    const notForced = (j: TestJob) => !j.data.force;
    const walk = heavyLane(
      "insight-pregenerate",
      a.handler,
      notForced,
      defer,
    )([job()]);
    const warm = heavyLane(
      "insight-pregenerate",
      b.handler,
      notForced,
      defer,
    )([job("w", { force: true })]);
    await tick();
    b.finish();
    a.finish();
    await Promise.all([walk, warm]);
    expect(log.indexOf("start:warm")).toBeLessThan(log.indexOf("end:walk"));
    expect(defer).not.toHaveBeenCalled();
  });

  it("frees the lane when a handler throws", async () => {
    const { defer } = deferrals();
    const failing = heavyLane(
      "rollup-full-backfill",
      async () => {
        throw new Error("boom");
      },
      undefined,
      defer,
    );
    await expect(failing([job()])).rejects.toThrow("boom");
    const next = vi.fn(async () => jobDone({ jobs: 1 }));
    await expect(
      heavyLane("data-backup", next, undefined, defer)([job()]),
    ).resolves.toMatchObject({ ok: true });
    expect(next).toHaveBeenCalledTimes(1);
    expect(defer).not.toHaveBeenCalled();
  });

  it("fails the delivery when the way back to the queue fails", async () => {
    const log: string[] = [];
    const holder = gate(log, "holder");
    const { defer } = deferrals();
    const held = heavyLane(
      "data-backup-offhost",
      holder.handler,
      undefined,
      defer,
    )([job()]);
    await tick();
    const broken = vi.fn(async () => {
      throw new Error("db down");
    });
    // pg-boss then retries it, rather than completing a job that never ran.
    await expect(
      heavyLane("data-backup", vi.fn(), undefined, broken)([job()]),
    ).rejects.toThrow("db down");
    holder.finish();
    await held;
  });

  it("refuses a queue that is not declared heavy", () => {
    expect(() =>
      heavyLane("host-metric-sample", async () => jobDone()),
    ).toThrow(/not in HEAVY_QUEUES/);
  });
});

describe("laneWanted", () => {
  it("tells the holder, and only the holder, that another queue is waiting", async () => {
    const seen: Record<string, boolean[]> = { holder: [], beside: [] };
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const { defer } = deferrals();
    expect(laneWanted()).toBe(false);
    const held = heavyLane(
      "integration-backfill-admission",
      async () => {
        seen.holder.push(laneWanted());
        await released;
        seen.holder.push(laneWanted());
        return jobDone({ jobs: 1 });
      },
      undefined,
      defer,
    )([job("slice")]);
    await tick();
    // A job of the same queue going back is not a reason to give way.
    await heavyLane(
      "integration-backfill-admission",
      vi.fn(),
      undefined,
      defer,
    )([job("next-slice")]);
    expect(laneWanted()).toBe(false);
    await heavyLane(
      "insights-general-status",
      vi.fn(),
      undefined,
      defer,
    )([job("nightly")]);
    // A light job of a heavy queue running beside the lane is never asked, even now.
    await heavyLane(
      "insight-pregenerate",
      async () => {
        seen.beside.push(laneWanted());
        return jobDone({ jobs: 1 });
      },
      () => false,
      defer,
    )([job("warm")]);
    release();
    await held;
    expect(seen.holder).toEqual([false, true]);
    expect(seen.beside).toEqual([false]);
    // The next holder starts with a clean slate.
    await heavyLane(
      "data-backup",
      async () => {
        seen.holder.push(laneWanted());
        return jobDone({ jobs: 1 });
      },
      undefined,
      defer,
    )([job("weekly")]);
    expect(seen.holder).toEqual([false, true, false]);
  });
});

describe("a long wait for the lane", () => {
  it("is reported at warn once per holder when a job has waited past the limit", async () => {
    vi.mocked(emitSignal).mockClear();
    const now = Date.parse("2026-10-20T06:00:00Z");
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const queuedAt = (ms: number) => async () => ({
      deferred: 1,
      oldestCreatedOn: new Date(now - ms),
    });
    const held = heavyLane("integration-backfill-admission", async () => {
      await released;
      return jobDone({ jobs: 1 });
    })([job("import")]);
    await tick();
    const wait = (ms: number) =>
      heavyLane(
        "insights-general-status",
        vi.fn(),
        undefined,
        queuedAt(ms),
        () => now,
      )([job("nightly")]);

    await wait(LANE_WAIT_WARN_MS - 60_000);
    expect(emitSignal).not.toHaveBeenCalled();
    await wait(LANE_WAIT_WARN_MS + 60_000);
    await wait(LANE_WAIT_WARN_MS + 120_000);
    expect(emitSignal).toHaveBeenCalledTimes(1);
    expect(emitSignal).toHaveBeenCalledWith({
      action: "job.heavy_lane.waiting_long",
      level: "warn",
      meta: {
        queue: "insights-general-status",
        holder: "integration-backfill-admission",
        waited_minutes: 121,
      },
    });
    release();
    await held;
  });
});

describe("a holder that never finishes", () => {
  it("loses the lane once it has outlived its own expiry, and the overrun is reported", async () => {
    vi.mocked(emitSignal).mockClear();
    const start = Date.parse("2026-10-20T02:00:00Z");
    let clock = start;
    const now = () => clock;
    const { back, defer } = deferrals();
    // A backup whose handler never settles: pg-boss failed it at its expiry,
    // but the handler is still awaiting.
    let unstick!: () => void;
    const stuck = new Promise<void>((r) => (unstick = r));
    const backup = heavyLane(
      "data-backup",
      async () => {
        await stuck;
        return jobDone({ jobs: 1 });
      },
      undefined,
      defer,
      now,
    )([{ ...job("nightly"), expireInSeconds: 7200 } as TestJob]);
    await tick();

    const restore = vi.fn(async () => jobDone({ jobs: 1 }));
    const tryRestore = () =>
      heavyLane(
        "backup-restore",
        restore,
        undefined,
        defer,
        now,
      )([{ ...job("restore"), expireInSeconds: 21600 } as TestJob]);

    // Inside the backup's expiry and grace, the restore waits its turn.
    clock = start + (7200 + LANE_HOLD_GRACE_SECONDS) * 1000;
    await tryRestore();
    expect(restore).not.toHaveBeenCalled();
    expect(back.map((b) => b.queue)).toEqual(["backup-restore"]);
    expect(emitSignal).not.toHaveBeenCalled();

    // Past it, the lane is the restore's, and the overrun is an error.
    clock += 60_000;
    await tryRestore();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(emitSignal).toHaveBeenCalledWith({
      action: "job.heavy_lane.holder_expired",
      level: "error",
      meta: {
        holder: "data-backup",
        queue: "backup-restore",
        overran_minutes: 1,
      },
    });

    // The stuck handler settling later does not free a lane it no longer
    // holds: a job that arrives while the next holder runs still waits.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const next = heavyLane(
      "rollup-full-backfill",
      async () => {
        await released;
        return jobDone({ jobs: 1 });
      },
      undefined,
      defer,
      now,
    )([{ ...job("fold"), expireInSeconds: 3600 } as TestJob]);
    await tick();
    unstick();
    await backup;
    const waiting = vi.fn(async () => jobDone({ jobs: 1 }));
    await heavyLane(
      "data-backup",
      waiting,
      undefined,
      defer,
      now,
    )([{ ...job("weekly"), expireInSeconds: 7200 } as TestJob]);
    expect(waiting).not.toHaveBeenCalled();
    release();
    await next;
  });
});

describe("the lane under container memory pressure", () => {
  it("sends a heavy job back while the container is near its limit", async () => {
    const log: string[] = [];
    const a = gate(log, "import");
    const { back, defer } = deferrals();
    memory.pressure = true;
    try {
      const outcome = await heavyLane(
        "apple-health-import-v2",
        a.handler,
        undefined,
        defer,
      )([job("upload")]);
      expect(outcome).toMatchObject({ ok: true, did: { lane_deferred: 1 } });
      expect(a.handler).not.toHaveBeenCalled();
      expect(back).toEqual([
        { queue: "apple-health-import-v2", ids: ["upload"] },
      ]);
    } finally {
      memory.pressure = false;
    }
  });

  it("asks a holder to give way at its next boundary", async () => {
    let seen: boolean[] = [];
    const { defer } = deferrals();
    let release!: () => void;
    const gateDone = new Promise<void>((r) => (release = r));
    const running = heavyLane(
      "apple-health-import-v2",
      async () => {
        seen.push(laneWanted());
        await gateDone;
        seen.push(laneWanted());
        return jobDone({ jobs: 1 });
      },
      undefined,
      defer,
    )([job("upload")]);
    await tick();
    memory.pressure = true;
    release();
    await running;
    memory.pressure = false;
    expect(seen).toEqual([false, true]);
    seen = [];
  });
});
