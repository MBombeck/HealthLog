/**
 * One-shot data repairs of the maintenance group, kept beside
 * `maintenance.ts` so that file stays under the size ratchet. Each is sent
 * by its boot discovery in `maintenance-discovery.ts` only while it has
 * something to repair.
 */
import { LAB_DOCUMENT_DATE_REPAIR_QUEUE } from "@/lib/jobs/lab-document-date-repair-queue";
import { WEARABLE_CYCLE_REPAIR_QUEUE } from "@/lib/jobs/wearable-cycle-repair-queue";

import { defineJob, type JobDefinition } from "./define-job";

export const MAINTENANCE_REPAIR_JOBS: readonly JobDefinition[] = [
  // Document lab values filed under their confirmation moment.
  defineJob({
    queue: LAB_DOCUMENT_DATE_REPAIR_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Fixed singleton key; collapse queued duplicates only, so a boot during a run can queue the next one.",
    },
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/lab-document-date-repair"))
        .handleLabDocumentDateRepair,
  }),
  // Wearable period days imported without the cycles they open.
  defineJob({
    queue: WEARABLE_CYCLE_REPAIR_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Fixed singleton key; collapse queued duplicates only, so a boot during a run can queue the next one.",
    },
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/wearable-cycle-repair"))
        .handleWearableCycleRepair,
  }),
];
