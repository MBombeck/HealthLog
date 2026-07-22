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
] as const;

export type IntegrationBackfillKind =
  (typeof INTEGRATION_BACKFILL_BOOT_ORDER)[number];

export type IntegrationBackfillData = {
  userId: string;
  enqueuedAt: string;
  provider?: "WHOOP" | "WITHINGS";
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

export function integrationBackfillAdmissionSingletonKey(
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

export async function enqueueIntegrationBackfillAdmission(
  boss: BossSender,
  payload: IntegrationBackfillAdmissionPayload,
): Promise<string | null> {
  return boss.send(INTEGRATION_BACKFILL_ADMISSION_QUEUE, payload, {
    ...RETRY_OPTIONS,
    singletonKey: integrationBackfillAdmissionSingletonKey(payload),
    group: INTEGRATION_BACKFILL_ADMISSION_GROUP,
  });
}
