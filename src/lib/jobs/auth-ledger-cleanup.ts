/**
 * Nightly cleanup of the dead rows of the sign-in ledgers.
 *
 * Every sign-in writes a session, every native sign-in and refresh writes a
 * refresh token and an access token, every second-factor prompt and passkey
 * ceremony writes a challenge, and "remember this device" writes a trusted
 * device. Nothing removed them once they expired, so the tables were mostly
 * dead rows: on a long-running instance nine in ten sessions and access
 * tokens had expired.
 *
 * What still reads a dead row decides how long it stays:
 *
 * - Sessions and refresh tokens: the login throttle recognises a source by a
 *   session or refresh token created from the same address in the last 30
 *   days (`KNOWN_ADDRESS_WINDOW_MS`), and by any refresh token of the device.
 *   Reuse detection reads a consumed refresh token until it expires (an
 *   expired one is refused before reuse is considered). So a row goes 30 days
 *   after it expired: it was created before that, so the address window
 *   cannot reach it, and a device that has not signed in for that long is a
 *   new source again. A revoked token waits for its expiry like any other.
 * - Access tokens (`api_tokens`): the token list shows revoked and expired
 *   tokens so their owner can see what ended. One goes 30 days after it
 *   expired; a revoked token without an expiry stays, since nothing records
 *   when it was revoked. Connector tokens have their own sweep
 *   (`mcp-token-cleanup`).
 * - Second-factor and passkey challenges: nothing reads one past its expiry.
 *   A day of slack keeps a ceremony in flight at midnight out of the way.
 * - Trusted devices: an expired one no longer skips the second factor and is
 *   not listed; it goes 30 days after it expired.
 *
 * Security activity is read from the audit log, never from these tables, so
 * it loses nothing. Each table is deleted in bounded batches.
 */
import type { Job } from "pg-boss";

import type { PrismaClient } from "@/generated/prisma/client";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { PURGE_BATCH_SIZE, PURGE_MAX_BATCHES } from "@/lib/jobs/purge-batch";
import { getWorkerPrisma } from "@/lib/jobs/reminder/shared";
import { withBackgroundEvent } from "@/lib/logging/background";

export const AUTH_LEDGER_CLEANUP_QUEUE = "auth-ledger-cleanup";
/** Daily at 03:35 Europe/Berlin, inside the 03:xx maintenance window. */
export const AUTH_LEDGER_CLEANUP_CRON = "35 3 * * *";

const DAY_MS = 86_400_000;

/** Days an expired session, token or trusted device is kept. */
export const AUTH_LEDGER_EXPIRED_GRACE_DAYS = 30;
/** Days an expired challenge is kept. */
export const AUTH_CHALLENGE_GRACE_DAYS = 1;

export interface AuthLedgerCleanupPayload {
  triggeredAt?: string;
}

/**
 * The tables and the column each one expires by. Literals, spliced into the
 * delete; `api_tokens.expires_at` is nullable and a null never matches.
 */
const LEDGERS = [
  {
    key: "sessions",
    table: "sessions",
    graceDays: AUTH_LEDGER_EXPIRED_GRACE_DAYS,
  },
  {
    key: "refresh_tokens",
    table: "refresh_tokens",
    graceDays: AUTH_LEDGER_EXPIRED_GRACE_DAYS,
  },
  {
    key: "api_tokens",
    table: "api_tokens",
    graceDays: AUTH_LEDGER_EXPIRED_GRACE_DAYS,
  },
  {
    key: "trusted_devices",
    table: "trusted_devices",
    graceDays: AUTH_LEDGER_EXPIRED_GRACE_DAYS,
  },
  {
    key: "mfa_challenges",
    table: "mfa_challenges",
    graceDays: AUTH_CHALLENGE_GRACE_DAYS,
  },
  {
    key: "auth_challenges",
    table: "auth_challenges",
    graceDays: AUTH_CHALLENGE_GRACE_DAYS,
  },
] as const;

export type AuthLedger = (typeof LEDGERS)[number]["key"];

export interface AuthLedgerCleanupResult {
  deleted: Record<AuthLedger, number>;
  /** Accounts whose signed-out devices lost their push credentials. */
  signedOutAccounts: number;
  /** False when a table stopped at the batch cap with rows left. */
  drained: boolean;
}

export async function cleanupAuthLedgers(
  prisma: PrismaClient,
  now: Date = new Date(),
  { batchSize = PURGE_BATCH_SIZE, maxBatches = PURGE_MAX_BATCHES } = {},
): Promise<AuthLedgerCleanupResult> {
  // Before the expired refresh rows go: they are what tells a signed-out
  // device from one that never signed in (`signed-out-push.ts`). Loaded here,
  // not at the top: the worker registry imports this module for its queue
  // name and must not pull the push relay with it.
  const { sweepSignedOutDevices } =
    await import("@/lib/devices/signed-out-push");
  const signedOutAccounts = await sweepSignedOutDevices(prisma, now);
  const deleted = {} as Record<AuthLedger, number>;
  let drained = true;
  for (const ledger of LEDGERS) {
    const cutoff = new Date(now.getTime() - ledger.graceDays * DAY_MS);
    let total = 0;
    let finished = false;
    for (let batch = 0; batch < maxBatches; batch++) {
      // `ledger.table` is one of the literals above, never input.
      const removed = await prisma.$executeRawUnsafe(
        `DELETE FROM "${ledger.table}" WHERE "id" IN (
           SELECT "id" FROM "${ledger.table}"
            WHERE "expires_at" < $1 LIMIT $2)`,
        cutoff,
        batchSize,
      );
      total += removed;
      if (removed < batchSize) {
        finished = true;
        break;
      }
    }
    deleted[ledger.key] = total;
    if (!finished) drained = false;
  }
  return { deleted, signedOutAccounts, drained };
}

export async function handleAuthLedgerCleanup(
  jobs: Job<AuthLedgerCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.auth_ledger_cleanup", async (evt) => {
    try {
      const { deleted, signedOutAccounts, drained } =
        await cleanupAuthLedgers(getWorkerPrisma());
      for (const [key, count] of Object.entries(deleted)) {
        evt.addMeta(`auth_ledger_cleanup_${key}`, count);
      }
      evt.addMeta("auth_ledger_cleanup_drained", drained);
      evt.addMeta("auth_ledger_cleanup_signed_out_accounts", signedOutAccounts);
      if (!drained) {
        evt.addWarning(
          "auth-ledger-cleanup stopped at the batch cap; a backlog remains for the next run",
        );
      }
      return jobDone({
        sessions_deleted: deleted.sessions,
        refresh_tokens_deleted: deleted.refresh_tokens,
        access_tokens_deleted: deleted.api_tokens,
        trusted_devices_deleted: deleted.trusted_devices,
        challenges_deleted: deleted.mfa_challenges + deleted.auth_challenges,
        drained,
      });
    } catch (err) {
      evt.addWarning(`auth-ledger-cleanup failed: ${err}`);
      throw err;
    }
  });
}
