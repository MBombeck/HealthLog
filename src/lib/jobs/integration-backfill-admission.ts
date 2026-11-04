import type { SendOptions } from "pg-boss";

export const INTEGRATION_BACKFILL_ADMISSION_QUEUE =
  "integration-backfill-admission";
export const INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY = 1;
export const INTEGRATION_BACKFILL_STAGGER_SECONDS = 30;
export const INTEGRATION_BACKFILL_ADMISSION_GROUP = {
  id: "integration-full-history-backfill",
} as const;

export const INTEGRATION_BACKFILL_BOOT_ORDER = [
  "whoop-backfill",
  "fitbit-backfill",
  "google-health-backfill",
  "google-health-sleep-repair",
  "sleep-timeline-backfill",
  "lab-biomarker-backfill",
  "strava-backfill",
  // Appended, not slotted next to `fitbit-backfill`, so every existing
  // provider's boot stagger stays exactly where it was.
  "fitbit-sleep-repair",
  "oura-backfill",
  "garmin-backfill",
] as const;

export type IntegrationBackfillKind =
  (typeof INTEGRATION_BACKFILL_BOOT_ORDER)[number];

export type IntegrationBackfillData = {
  userId: string;
  enqueuedAt: string;
  provider?: "WHOOP" | "WITHINGS";
  /**
   * The continuation number of an import that runs in slices: absent (0) for
   * the job discovery or a connect sends, 1, 2, ... for each follow-up a
   * slice that made progress sent for the rest. Part of the job's singleton
   * key, so the follow-up is not swallowed by the `exclusive` policy while the
   * slice that sends it is still active; never part of the import identity.
   */
  slice?: number;
};

export interface IntegrationBackfillAdmissionPayload {
  kind: IntegrationBackfillKind;
  data: IntegrationBackfillData;
}

interface BossSender {
  send(
    name: string,
    data: object,
    options?: SendOptions,
  ): Promise<string | null>;
}

const RETRY_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
} as const;

/**
 * The admission job's expiry: sixteen hours, so a legitimately long import
 * is never declared dead underneath itself.
 *
 * Without it every admission job took pg-boss's default of fifteen minutes.
 * A full-history import of a per-minute heart-rate stream is thousands of
 * pages (a page is 1 000 readings, about seventeen hours of a watch's
 * history, so five years is some 2 600 pages), and at a few seconds a page on
 * a slow link that is hours. Past the expiry pg-boss fails the job and retries
 * it while the handler keeps running (`integration-backfill-lock.ts`), and the
 * import that could not finish in fifteen minutes started over beside itself.
 *
 * The runs that honour the job's budget (`jobBudget`, three quarters of this)
 * stop on their own at twelve hours, which is still some 8 000 pages at five
 * seconds each, and are retried or re-offered at the next boot. The expiry is
 * also what ends a run that hangs: the lane is freed for the next import, and
 * the import lock keeps a retry from starting beside the stuck run. pg-boss
 * refuses an expiry of 24 hours or more.
 */
export const INTEGRATION_BACKFILL_EXPIRE_SECONDS = 16 * 60 * 60;

export function bootStaggerSecondsFor(kind: IntegrationBackfillKind): number {
  return (
    (INTEGRATION_BACKFILL_BOOT_ORDER.indexOf(kind) + 1) *
    INTEGRATION_BACKFILL_STAGGER_SECONDS
  );
}

export function integrationBackfillSourceOptions(
  singletonKey: string,
  startAfterSeconds: number = 0,
): SendOptions {
  return {
    ...RETRY_OPTIONS,
    singletonKey,
    ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {}),
  };
}

/**
 * The import a job belongs to: one kind for one account (and provider). The
 * import lock keys on it, so no two slices or deliveries of one import ever
 * run at once.
 */
export function integrationBackfillIdentity(
  payload: IntegrationBackfillAdmissionPayload,
): string {
  if (payload.kind === "sleep-timeline-backfill") {
    if (!payload.data.provider) {
      throw new Error("sleep-timeline backfill admission requires a provider");
    }
    return `${payload.kind}|${payload.data.provider}|${payload.data.userId}`;
  }
  return `${payload.kind}|${payload.data.userId}`;
}

/** The job's singleton key: the import identity, plus its slice number. */
export function integrationBackfillAdmissionSingletonKey(
  payload: IntegrationBackfillAdmissionPayload,
): string {
  const identity = integrationBackfillIdentity(payload);
  const slice = payload.data.slice ?? 0;
  return slice > 0 ? `${identity}|slice-${slice}` : identity;
}

export async function enqueueIntegrationBackfillAdmission(
  boss: BossSender,
  payload: IntegrationBackfillAdmissionPayload,
  startAfterSeconds: number = 0,
): Promise<string | null> {
  return boss.send(INTEGRATION_BACKFILL_ADMISSION_QUEUE, payload, {
    ...integrationBackfillAdmissionSendOptions(payload),
    ...(startAfterSeconds > 0 ? { startAfter: startAfterSeconds } : {}),
  });
}

/** Breathing room between one slice of an import and the next. */
export const INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS = 60;

/**
 * The send options of one admission job. The options ride on the send, not on
 * `createQueue`, whose `ON CONFLICT DO NOTHING` leaves an existing queue's
 * defaults as they were.
 */
export function integrationBackfillAdmissionSendOptions(
  payload: IntegrationBackfillAdmissionPayload,
): SendOptions {
  return {
    ...RETRY_OPTIONS,
    expireInSeconds: INTEGRATION_BACKFILL_EXPIRE_SECONDS,
    singletonKey: integrationBackfillAdmissionSingletonKey(payload),
    group: INTEGRATION_BACKFILL_ADMISSION_GROUP,
  };
}
