/**
 * v1.43 — the Dawarich movement context, fetched once a night.
 *
 * The daily tick (empty payload) fans out one job per account with a stored
 * connection and the `environment` module on. A per-account job fetches the
 * last seven days ending yesterday, so a phone that uploaded late fills in the
 * days it missed; the connect route and the settings card send an explicit
 * `fromDate` for the 30-day backfill and for a longer catch-up (up to 365
 * days). Without a connection, or with the module off, nothing leaves the host.
 *
 * Every run is its own background event (`job.dawarich_sync`), so its lines
 * and its failure carry the action they belong to.
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import type { Job, PgBoss } from "pg-boss";

import { loadDawarichConnection } from "@/lib/dawarich/connection";
import { syncDawarichRange, yesterdayKey } from "@/lib/dawarich/sync";
import { prisma } from "@/lib/db";
import { isReauthRequired } from "@/lib/integrations/status";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { annotate } from "@/lib/logging/context";
import {
  getOperatorModuleAvailability,
  isModuleEnabled,
  normalisePrefs,
  resolveModuleEnabled,
} from "@/lib/modules/gate";
import { daysBetweenDateKeys, shiftDateKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { DAWARICH_SYNC_MAX_DAYS } from "@/lib/validations/dawarich";
import { DAWARICH_SYNC_QUEUE } from "./dawarich-sync-queue";

/** The nightly window: yesterday and the six days before it. */
const NIGHTLY_WINDOW_DAYS = 7;

/** The backfill a fresh connection starts with. */
export const DAWARICH_CONNECT_BACKFILL_DAYS = 30;

/** One account has at most one requested run per slot. */
const REQUEST_SINGLETON_SECONDS = 5 * 60;

export interface DawarichSyncPayload {
  userId?: string;
  /** First day to fetch (`YYYY-MM-DD`); the nightly window when absent. */
  fromDate?: string;
}

/**
 * Queue one account's run from a request (connect, the settings card). One run
 * per account per five minutes; a send inside the slot is refused and says so.
 */
export async function enqueueDawarichSync(payload: {
  userId: string;
  fromDate?: string;
}): Promise<"enqueued" | "no_worker" | "already_queued"> {
  const boss = getGlobalBoss();
  if (!boss) return "no_worker";
  const id = await boss.send(DAWARICH_SYNC_QUEUE, payload, {
    singletonKey: `dawarich-sync:${payload.userId}`,
    singletonSeconds: REQUEST_SINGLETON_SECONDS,
  });
  return id ? "enqueued" : "already_queued";
}

async function discover(boss: PgBoss): Promise<JobOutcome> {
  const [candidates, operatorAvailability] = await Promise.all([
    prisma.user.findMany({
      where: { dawarichUrlEncrypted: { not: null }, ...ACTIVE_ACCOUNT },
      select: { id: true, modulePreferencesJson: true },
    }),
    getOperatorModuleAvailability(),
  ]);
  let enqueued = 0;
  let skipped = 0;
  for (const { id, modulePreferencesJson } of candidates) {
    const enabled = resolveModuleEnabled(
      "environment",
      {
        gender: null,
        disableCoach: false,
        modulePreferences: normalisePrefs(modulePreferencesJson),
        cycleTrackingEnabled: null,
      },
      false,
      operatorAvailability,
    );
    // A connection waiting for a new key or paused after a day of failures
    // is not retried every night; reconnecting starts it again.
    if (!enabled || (await isReauthRequired(id, "dawarich"))) {
      skipped += 1;
      continue;
    }
    await boss.send(
      DAWARICH_SYNC_QUEUE,
      { userId: id } satisfies DawarichSyncPayload,
      { singletonKey: `dawarich-sync:${id}` },
    );
    enqueued += 1;
  }
  annotate({
    action: { name: "dawarich.sync.discover" },
    meta: { users_enqueued: enqueued, users_skipped: skipped },
  });
  return jobDone({ users_enqueued: enqueued, users_skipped: skipped });
}

async function runForUser(
  userId: string,
  fromDate: string | undefined,
): Promise<JobOutcome> {
  annotate({ action: { name: "dawarich.sync.run" } });
  if (!(await isModuleEnabled(userId, "environment"))) {
    return jobDone({ skipped: "environment_module_disabled" });
  }
  if (!(await loadDawarichConnection(userId))) {
    return jobDone({ skipped: "not_connected" });
  }
  const tz = await resolveUserTimezone(userId);
  const toDate = yesterdayKey(tz);
  const from = fromDate ?? shiftDateKey(toDate, -(NIGHTLY_WINDOW_DAYS - 1));
  // Clamp so a crafted payload cannot fan out an unbounded range.
  const span = daysBetweenDateKeys(from, toDate) + 1;
  const start =
    Number.isFinite(span) && span <= DAWARICH_SYNC_MAX_DAYS
      ? from
      : shiftDateKey(toDate, -(DAWARICH_SYNC_MAX_DAYS - 1));
  try {
    const result = await syncDawarichRange(userId, start, toDate);
    annotate({ meta: { dawarich_days_stored: result.daysStored } });
    return jobDone({ days_stored: result.daysStored });
  } catch (error) {
    // Already on the ledger, classified; the job fails so the retry policy
    // applies to a transient outage.
    return jobFailed("dawarich fetch failed", error);
  }
}

/** The queue handler: discovery on an empty payload, one account otherwise. */
export async function handleDawarichSync(
  boss: PgBoss,
  jobs: Job<DawarichSyncPayload>[],
): Promise<JobOutcome> {
  let failure: JobOutcome | null = null;
  for (const job of jobs) {
    const outcome = await withBackgroundEvent("job.dawarich_sync", () =>
      job.data?.userId
        ? runForUser(job.data.userId, job.data.fromDate)
        : discover(boss),
    );
    if (!outcome.ok && failure === null) failure = outcome;
  }
  return failure ?? jobDone({ jobs: jobs.length });
}
