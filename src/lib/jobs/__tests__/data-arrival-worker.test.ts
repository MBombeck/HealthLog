/**
 * The `data-arrival` worker's contract.
 *
 * Two properties carry real risk and are pinned here:
 *
 *   - The marker is claimed BEFORE any fan-out. The S4 morning-refresh trigger
 *     stamps its debounce marker only after a non-failed run, so a persistently
 *     failing downstream let every subsequent sleep batch re-enqueue — an
 *     unbounded chain. Claiming up front bounds a downstream failure to the
 *     retries of one job.
 *   - A refusal returns `skipped`; it does not throw. pg-boss retries a failed
 *     job, and retrying against a ceiling that will not move until the local
 *     day rolls over is a loop.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (evt: { addMeta: () => void }) => Promise<void>,
  ) => fn({ addMeta: () => {} }),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardSnapshot: vi.fn(),
}));
vi.mock("@/lib/jobs/reminder/shared", () => ({
  getWorkerPrisma: () => fakePrisma,
  workerLog: vi.fn(),
}));
// The spine reaches the Activity Insight only through the generator-free
// enqueue module — importing the worker here would make its provider clients
// reachable from the spine and break the zero-spend module-graph guard.
vi.mock("@/lib/jobs/workout-insight-generate-shared", () => ({
  enqueueWorkoutInsight: vi.fn(async () => ({ enqueued: true })),
}));
vi.mock("@/lib/arrivals/reaction-line-shared", () => ({
  enqueueReactionLine: vi.fn(async () => undefined),
}));

type ExistingReaction = {
  id: string;
  occurredAt: Date;
  generationReservedTokens: number | null;
  generationBudgetDateKey: string | null;
  generationProviderInvokedAt: Date | null;
};

const createMany: Mock<(args: unknown) => Promise<{ count: number }>> = vi.fn(
  async () => ({ count: 1 }),
);
const updateMany: Mock<(args: unknown) => Promise<{ count: number }>> = vi.fn(
  async () => ({ count: 1 }),
);
const queryRaw: Mock<(...args: unknown[]) => Promise<ExistingReaction[]>> =
  vi.fn(async () => [
    {
      id: "reaction-1",
      occurredAt: new Date("2026-07-14T06:15:00.000Z"),
      generationReservedTokens: null,
      generationBudgetDateKey: null,
      generationProviderInvokedAt: null,
    },
  ]);
const executeRaw: Mock<(...args: unknown[]) => Promise<number>> = vi.fn(
  async () => 1,
);
const transactionPrisma = {
  arrivalReaction: { updateMany },
  $queryRaw: queryRaw,
  $executeRaw: executeRaw,
};
const transaction: Mock<
  (fn: (tx: typeof transactionPrisma) => Promise<unknown>) => Promise<unknown>
> = vi.fn(async (fn) => fn(transactionPrisma));
const fakePrisma = {
  arrivalReaction: { createMany },
  $transaction: transaction,
};

const { runDataArrival } = await import("../data-arrival");
const { enqueueWorkoutInsight } =
  await import("@/lib/jobs/workout-insight-generate-shared");
const { enqueueReactionLine } =
  await import("@/lib/arrivals/reaction-line-shared");

type Runnable = Parameters<typeof runDataArrival>[1];

function arrival(overrides: Partial<Runnable> = {}): Runnable {
  return {
    userId: "user-1",
    kind: "weight",
    salience: "salient",
    localDate: "2026-07-14",
    occurredAt: "2026-07-14T06:15:00.000Z",
    count: 1,
    source: "withings",
    ...overrides,
  } as Runnable;
}

beforeEach(() => {
  createMany.mockClear().mockResolvedValue({ count: 1 });
  updateMany.mockClear().mockResolvedValue({ count: 1 });
  queryRaw.mockClear().mockResolvedValue([
    {
      id: "reaction-1",
      occurredAt: new Date("2026-07-14T06:15:00.000Z"),
      generationReservedTokens: null,
      generationBudgetDateKey: null,
      generationProviderInvokedAt: null,
    },
  ]);
  executeRaw.mockClear().mockResolvedValue(1);
  transaction.mockClear();
  vi.mocked(enqueueReactionLine).mockClear();
  vi.mocked(enqueueWorkoutInsight).mockClear();
});

describe("data-arrival worker", () => {
  it("claims the day's marker before any fan-out", async () => {
    const result = await runDataArrival(
      fakePrisma as never,
      arrival({ kind: "workout", refId: "w-1" }),
    );
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
    expect(result).toMatchObject({ status: "processed", dedup: false });
  });

  it("a lost claim de-duplicates instead of writing a second line", async () => {
    createMany.mockResolvedValue({ count: 0 });
    const result = await runDataArrival(fakePrisma as never, arrival());
    expect(result).toMatchObject({ status: "processed", dedup: true });
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.actions).not.toContain("line_pending");
  });

  it("only a fresh claim schedules the day's reaction line", async () => {
    const first = await runDataArrival(fakePrisma as never, arrival());
    if (first.status !== "processed") throw new Error("unreachable");
    expect(first.actions).toContain("line_pending");
  });

  it("replaces and re-enqueues a strictly newer same-day arrival", async () => {
    createMany.mockResolvedValue({ count: 0 });
    queryRaw.mockResolvedValue([
      {
        id: "reaction-1",
        occurredAt: new Date("2026-07-14T06:00:00.000Z"),
        generationReservedTokens: null,
        generationBudgetDateKey: null,
        generationProviderInvokedAt: null,
      },
    ]);

    const result = await runDataArrival(
      fakePrisma as never,
      arrival({ refId: "weight-new" }),
    );

    expect(result).toMatchObject({ status: "processed", dedup: false });
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.actions).toContain("marker_replaced");
    expect(result.actions).toContain("line_pending");
    expect(enqueueReactionLine).toHaveBeenCalledWith({
      userId: "user-1",
      kind: "weight",
      localDate: "2026-07-14",
      revision: "2026-07-14T06:15:00.000Z",
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lineEncrypted: null,
          generatedAt: null,
          generationClaimId: null,
          generationClaimedAt: null,
          generationReservedTokens: null,
          generationBudgetDateKey: null,
          generationProviderInvokedAt: null,
        }),
      }),
    );
  });

  it("does not re-enqueue an equal or older same-day arrival", async () => {
    createMany.mockResolvedValue({ count: 0 });

    const result = await runDataArrival(fakePrisma as never, arrival());

    expect(result).toMatchObject({ status: "processed", dedup: true });
    expect(enqueueReactionLine).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("a second workout the same day still fans out, despite the day marker", async () => {
    // The day-scoped marker can only be claimed once, but two sessions are two
    // events. Gating the workout fan-out on the claim would silently drop the
    // second one.
    createMany.mockResolvedValue({ count: 0 });
    const result = await runDataArrival(
      fakePrisma as never,
      arrival({ kind: "workout", refId: "w-2" }),
    );
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.actions).toContain("workout_insight_enqueued");
    // The action name is a label; the dispatch is the contract.
    expect(enqueueWorkoutInsight).toHaveBeenCalledWith({
      userId: "user-1",
      workoutId: "w-2",
    });
  });

  it("retries the arrival when workout insight enqueueing fails", async () => {
    vi.mocked(enqueueWorkoutInsight).mockResolvedValueOnce({ enqueued: false });

    await expect(
      runDataArrival(
        fakePrisma as never,
        arrival({ kind: "workout", refId: "w-1" }),
      ),
    ).rejects.toThrow("Workout insight enqueue failed");
  });

  it("does not dispatch a workout arrival that carries no referent", async () => {
    // A paragraph is addressed by workout id. A seam that forgot to carry one
    // must be visible rather than silently generating against nothing.
    const result = await runDataArrival(
      fakePrisma as never,
      arrival({ kind: "workout", refId: undefined }),
    );
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.actions).toContain("workout_no_ref");
    expect(enqueueWorkoutInsight).not.toHaveBeenCalled();
  });

  it("never dispatches the workout insight for a non-workout arrival", async () => {
    await runDataArrival(fakePrisma as never, arrival({ kind: "sleep_night" }));
    await runDataArrival(fakePrisma as never, arrival({ kind: "weight" }));
    await runDataArrival(fakePrisma as never, arrival({ kind: "labs_panel" }));
    expect(enqueueWorkoutInsight).not.toHaveBeenCalled();
  });

  it("moves the marker and referent forward together, never backwards", async () => {
    createMany.mockResolvedValue({ count: 0 });
    queryRaw.mockResolvedValue([
      {
        id: "reaction-1",
        occurredAt: new Date("2026-07-14T06:00:00.000Z"),
        generationReservedTokens: null,
        generationBudgetDateKey: null,
        generationProviderInvokedAt: null,
      },
    ]);
    await runDataArrival(
      fakePrisma as never,
      arrival({ kind: "workout", refId: "w-new" }),
    );
    const update = updateMany.mock.calls[0][0] as {
      where: { occurredAt?: { lt?: Date } };
      data: { occurredAt?: Date; arrivedAt?: Date; refId?: string | null };
    };
    expect(update.where.occurredAt?.lt).toBeInstanceOf(Date);
    expect(update.data).toMatchObject({
      occurredAt: expect.any(Date),
      arrivedAt: expect.any(Date),
      refId: "w-new",
    });
  });

  it("refuses an unknown kind as SKIPPED, not FAILED", async () => {
    const result = await runDataArrival(
      fakePrisma as never,
      arrival({ kind: "not_a_kind" as never }),
    );
    // A throw here would earn two pointless retries against a payload that can
    // never succeed.
    expect(result).toEqual({ status: "skipped", reason: "unknown_kind" });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("a genuine transient fault DOES propagate, so the retry policy applies", async () => {
    createMany.mockRejectedValue(new Error("connection terminated"));
    await expect(
      runDataArrival(fakePrisma as never, arrival()),
    ).rejects.toThrow("connection terminated");
  });
});
