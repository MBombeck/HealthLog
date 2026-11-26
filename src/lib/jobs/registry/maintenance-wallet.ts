/**
 * The Apple Wallet pass queues (v1.50), kept beside `maintenance.ts` so that
 * file stays under the size ratchet. Names, crons and sends live in
 * `emergency-card/wallet-pass/queues.ts`; the handlers in
 * `jobs/wallet-pass.ts`.
 */
import {
  WALLET_PASS_REFRESH_QUEUE,
  WALLET_PASS_SWEEP_CRON,
  WALLET_PASS_SWEEP_QUEUE,
  WALLET_PASS_VOID_PUSH_CRON,
  WALLET_PASS_VOID_PUSH_QUEUE,
  WALLET_READY_PUSH_QUEUE,
} from "@/lib/emergency-card/wallet-pass/queues";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";

import { defineJob, type JobDefinition } from "./define-job";

const handlers = () => import("@/lib/jobs/wallet-pass");

export const MAINTENANCE_WALLET_JOBS: readonly JobDefinition[] = [
  // No cron: sent by the card's writers, a minute late and joined per pass.
  defineJob({
    queue: WALLET_PASS_REFRESH_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Per-pass singleton key; a burst of edits joins the one queued rebuild, and an edit during a run queues the next.",
    },
    work: { localConcurrency: 2 },
    load: async () => (await handlers()).handleWalletPassRefresh,
  }),
  defineJob({
    queue: WALLET_PASS_SWEEP_QUEUE,
    cron: WALLET_PASS_SWEEP_CRON,
    scheduleOptions: cronIsTheRetry,
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleWalletPassSweep,
  }),
  // Sent by every withdrawal this process sees; the cron finds the ones
  // stamped inside another transaction.
  defineJob({
    queue: WALLET_PASS_VOID_PUSH_QUEUE,
    cron: WALLET_PASS_VOID_PUSH_CRON,
    policy: {
      policy: "short",
      reason:
        "One global singleton key; a withdrawal during a queued run joins it, one during a run queues the next.",
    },
    scheduleOptions: cronIsTheRetry,
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleWalletPassVoidPush,
  }),
  // No cron: sent when a pass is made and when the relay starts signing;
  // the sweep runs the same pass for the rest.
  defineJob({
    queue: WALLET_READY_PUSH_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Per-person singleton key, one global key for the relay's start; each send is claimed on its pass row, so a repeat sends nothing.",
    },
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleWalletReadyPush,
  }),
];
