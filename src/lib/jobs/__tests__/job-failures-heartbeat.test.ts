/**
 * A backup job whose process died is failed by pg-boss's heartbeat monitor
 * with three bare words. The backups page shows the run's error, so the words
 * have to say what happened and where to look.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) },
}));

import { readLastQueueRun, readQueueRunningSince } from "../job-failures";

beforeEach(() => queryRaw.mockReset());

describe("a backup run the process died under", () => {
  it("explains a heartbeat timeout instead of repeating it", async () => {
    queryRaw.mockResolvedValue([
      {
        state: "failed",
        completed_on: new Date("2026-10-04T02:40:00Z"),
        output: "job heartbeat timeout",
        expire_seconds: 7200,
      },
    ]);
    const run = await readLastQueueRun("data-backup");
    expect(run?.state).toBe("failed");
    expect(run?.error).toMatch(/^job heartbeat timeout: /);
    expect(run?.error).toMatch(/restarted or ran out of memory/);
  });

  it("says since when a run is in progress, and nothing when none is", async () => {
    queryRaw.mockResolvedValueOnce([
      { started_on: new Date("2026-10-04T02:30:00Z") },
    ]);
    expect(await readQueueRunningSince("data-backup")).toBe(
      "2026-10-04T02:30:00.000Z",
    );
    queryRaw.mockResolvedValueOnce([]);
    expect(await readQueueRunningSince("data-backup")).toBeNull();
    queryRaw.mockRejectedValueOnce(new Error('schema "pgboss" does not exist'));
    expect(await readQueueRunningSince("data-backup")).toBeNull();
  });
});
