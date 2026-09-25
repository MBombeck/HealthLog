/**
 * Drive a queued restore to its end, the way the worker does, in one call.
 *
 * `POST /api/admin/backups/[id]/restore` answers 202 and leaves the restore to
 * the `backup-restore` queue. The tests that pin what a restore checks and
 * writes are about the restore, not the queue, so they call this instead of
 * the route: it POSTs through the real route, runs the job the route queued
 * with the real handler body, and answers the way the synchronous route did
 * (200 with the report, or the refusal's status and message), read back from
 * the job's row. Every hop in between is production code; only the pg-boss
 * delivery is replaced by a direct call.
 *
 * The asynchronous contract itself (202, the status route, 409, resuming) is
 * pinned by `backup-restore-job.test.ts`, which does not use this.
 */
import type { PgBoss } from "pg-boss";

import { POST as queueRestore } from "@/app/api/admin/backups/[id]/restore/route";
import { getGlobalBoss, setGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  readBackupRestoreJob,
  runBackupRestoreJob,
} from "@/lib/jobs/backup-restore";

/** The status the synchronous route answered each refusal with. */
const LEGACY_STATUS: Record<string, number> = {
  backup_not_found: 404,
  backup_changed: 409,
  "backup.payload.undecryptable": 422,
  schema_invalid: 422,
  incompatible_schema_version: 422,
  owner_mismatch: 409,
  owner_not_found: 422,
  "backup.section.missing": 422,
  document_ciphertext_missing: 422,
  time_budget: 503,
  transaction_failed: 500,
};

/** A queue that accepts every send, for a test with no worker. */
export const acceptingBoss = {
  send: async () => "test-boss-job",
  complete: async () => ({}),
} as unknown as PgBoss;

export async function POST(
  request: Parameters<typeof queueRestore>[0],
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // A file that mocks the queue already has one; otherwise stand one in for
  // the duration of the request only, so nothing else in the file sees it.
  const previous = getGlobalBoss();
  if (!previous) setGlobalBoss(acceptingBoss);
  let queued: Response;
  try {
    queued = await queueRestore(request, context);
  } finally {
    if (!previous) setGlobalBoss(null);
  }
  if (queued.status !== 202) return queued;

  const { data } = (await queued.json()) as { data: { jobId: string } };
  try {
    await runBackupRestoreJob(data.jobId);
  } catch {
    // The job recorded the failure on its row before rethrowing; the
    // synchronous route turned the same throw into a 500 envelope.
  }
  const job = await readBackupRestoreJob(data.jobId);
  if (!job) throw new Error(`restore job ${data.jobId} vanished`);

  if (job.status === "succeeded" && job.result) {
    return Response.json(
      { data: { restored: true, ...job.result }, error: null },
      { status: 200 },
    );
  }
  const failure = job.failure ?? { code: "unexpected", message: "failed" };
  return Response.json(
    {
      data: null,
      error: failure.message,
      meta: {
        errorCode: failure.code,
        ...(failure.sections ? { sections: failure.sections } : {}),
      },
    },
    { status: LEGACY_STATUS[failure.code] ?? 500 },
  );
}
