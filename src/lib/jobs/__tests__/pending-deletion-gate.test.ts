/**
 * A job queued for an account before its deletion was asked for does not run
 * once the account is pending deletion: the binding drops it before the
 * handler is even loaded, and the rest of its batch runs.
 *
 * Mutation that turns this red: bind the loaded handler directly again
 * (`bindableHandler` without the gate); the pending account's job reaches the
 * handler.
 */
import { describe, expect, it, vi } from "vitest";
import type { Job, PgBoss } from "pg-boss";

const pending = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => pending.has(id)).map((id) => ({ id })),
      ),
    },
  },
}));

const { dropJobsOfPendingAccounts, accountOfJob } =
  await import("@/lib/jobs/pending-deletion-gate");
const { bindableHandler } = await import("@/lib/jobs/registry/register");
type JobDefinition = import("@/lib/jobs/registry/define-job").JobDefinition;
const { prisma } = await import("@/lib/db");

const job = (id: string, data: unknown): Job<unknown> => ({
  id,
  name: "rollup-rebuild",
  data,
  expireInSeconds: 900,
  heartbeatSeconds: null,
  retryCount: 0,
  signal: new AbortController().signal,
});

/** A queue declaration around `handler`, as the registry holds one. */
function definition(
  queue: string,
  handler: (
    jobs: Job<unknown>[],
  ) => Promise<{ ok: true; did: Record<string, never> }>,
  extra: { actsForPendingAccounts?: true } = {},
): JobDefinition {
  return { queue, work: {}, load: async () => handler, ...extra };
}

describe("the pending-deletion gate on queued jobs", () => {
  it("reads the account a payload names, and nothing else", () => {
    expect(accountOfJob(job("1", { userId: "u1", days: 3 }))).toBe("u1");
    expect(accountOfJob(job("2", { restoreJobId: "r" }))).toBeNull();
    expect(accountOfJob(job("3", null))).toBeNull();
    expect(accountOfJob(job("4", { userId: 42 }))).toBeNull();
  });

  it("drops the jobs of accounts pending deletion and keeps the rest", async () => {
    pending.clear();
    pending.add("frozen");
    const batch = [
      job("a", { userId: "frozen" }),
      job("b", { userId: "active" }),
      job("c", {}),
    ];
    const { live, dropped } = await dropJobsOfPendingAccounts(batch);
    expect(live.map((j) => j.id)).toEqual(["b", "c"]);
    expect(dropped).toBe(1);
  });

  it("asks nothing for a batch that names no account", async () => {
    vi.mocked(prisma.user.findMany).mockClear();
    await dropJobsOfPendingAccounts([job("x", { sweep: true })]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("keeps a bound handler from running a job queued before the deletion", async () => {
    pending.clear();
    pending.add("frozen");
    const handler = vi.fn(async (_jobs: Job<unknown>[]) => ({
      ok: true as const,
      did: {},
    }));
    const declared = definition("rollup-rebuild", handler);
    const load = vi.spyOn(declared, "load");
    const bound = bindableHandler(declared, { boss: {} as PgBoss });

    const outcome = await bound([job("1", { userId: "frozen" })]);
    expect(outcome).toMatchObject({
      ok: true,
      did: { jobs_skipped_deletion_pending: 1 },
    });
    expect(load).not.toHaveBeenCalled();

    await bound([job("2", { userId: "frozen" }), job("3", { userId: "u" })]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0].map((j) => j.id)).toEqual(["3"]);
  });

  it("lets a queue that only changes how rows are stored run for it", async () => {
    pending.clear();
    pending.add("frozen");
    const handler = vi.fn(async (_jobs: Job<unknown>[]) => ({
      ok: true as const,
      did: {},
    }));
    const bound = bindableHandler(
      definition("free-text-encryption-backfill", handler, {
        actsForPendingAccounts: true,
      }),
      { boss: {} as PgBoss },
    );
    await bound([job("1", { userId: "frozen" })]);
    expect(handler.mock.calls[0]?.[0].map((j) => j.id)).toEqual(["1"]);
  });
});
