/**
 * The chokepoint every queued job for one account passes before it runs.
 *
 * Background passes that enumerate accounts skip one pending deletion
 * (`ACTIVE_ACCOUNT`, held by the enumeration guard). A job queued for an
 * account before its deletion was asked for (a provider backfill, an import,
 * a rollup rebuild, a document index, a record detection) was decided before
 * the account was frozen, and its handler acts on the `userId` it carries
 * without asking again. So the binding asks for it: a job whose payload names
 * an account pending deletion is completed without running, and the rest of
 * its batch runs as before. An account that no longer exists is not this
 * gate's business; the handler finds nothing to act on.
 */
import type { Job } from "pg-boss";

/** The account a job's payload names, when it names one. */
export function accountOfJob(job: Pick<Job<unknown>, "data">): string | null {
  const data = job.data as { userId?: unknown } | null | undefined;
  return data && typeof data === "object" && typeof data.userId === "string"
    ? data.userId
    : null;
}

/** Which of `ids` are pending deletion. */
export type PendingReader = (ids: string[]) => Promise<Set<string>>;

const readPending: PendingReader = async (ids) => {
  const { prisma } = await import("@/lib/db");
  const rows = await prisma.user.findMany({
    where: { id: { in: ids }, deletionRequestedAt: { not: null } },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
};

/**
 * Split a batch into the jobs that may run and the number dropped because
 * their account is pending deletion. A batch with no account in it costs no
 * query.
 */
export async function dropJobsOfPendingAccounts<
  J extends Pick<Job<unknown>, "data">,
>(
  jobs: J[],
  pendingOf: PendingReader = readPending,
): Promise<{ live: J[]; dropped: number }> {
  const ids = [
    ...new Set(jobs.map(accountOfJob).filter((id) => id !== null)),
  ] as string[];
  if (ids.length === 0) return { live: jobs, dropped: 0 };
  const pending = await pendingOf(ids);
  if (pending.size === 0) return { live: jobs, dropped: 0 };
  const live = jobs.filter((job) => {
    const id = accountOfJob(job);
    return id === null || !pending.has(id);
  });
  return { live, dropped: jobs.length - live.length };
}
