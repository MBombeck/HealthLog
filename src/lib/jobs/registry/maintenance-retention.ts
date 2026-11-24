/**
 * Retention jobs of the maintenance group, kept beside `maintenance.ts` so
 * that file stays under the size ratchet. Each is a daily keyless prune:
 * bounded, idempotent deletes, single-flight, and the next night's tick is the
 * retry (`cronIsTheRetry`).
 */
import {
  LEDGER_RETENTION_CLEANUP_CRON,
  LEDGER_RETENTION_CLEANUP_QUEUE,
} from "@/lib/jobs/ledger-retention-cleanup";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";

import { defineJob, type JobDefinition } from "./define-job";
import { MAINTENANCE_WALLET_JOBS } from "./maintenance-wallet";

export const MAINTENANCE_RETENTION_JOBS: readonly JobDefinition[] = [
  // The Telegram reminder and Coach usage ledgers.
  defineJob({
    queue: LEDGER_RETENTION_CLEANUP_QUEUE,
    cron: LEDGER_RETENTION_CLEANUP_CRON,
    scheduleOptions: cronIsTheRetry,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/ledger-retention-cleanup"))
        .handleLedgerRetentionCleanup,
  }),
  // The Apple Wallet pass queues, which carry their withdrawn passes' retention.
  ...MAINTENANCE_WALLET_JOBS,
];
