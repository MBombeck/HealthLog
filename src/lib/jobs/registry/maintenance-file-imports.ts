/**
 * File imports of the maintenance group that came after `maintenance.ts`
 * reached the size ratchet, kept beside it. Registered in place, right after
 * the Health Connect import.
 */
import {
  FIT_IMPORT_CONCURRENCY,
  FIT_IMPORT_QUEUE,
} from "@/lib/jobs/fit-import-queue";

import {
  RECORD_FILE_IMPORT_CONCURRENCY,
  RECORD_FILE_IMPORT_QUEUE,
} from "@/lib/jobs/record-file-import-queue";

import { defineJob, type JobDefinition } from "./define-job";

export const MAINTENANCE_FILE_IMPORT_JOBS: readonly JobDefinition[] = [
  // One activity FIT file per job, decoded in the worker.
  defineJob({
    queue: FIT_IMPORT_QUEUE,
    work: { localConcurrency: FIT_IMPORT_CONCURRENCY },
    load: async () =>
      (await import("@/lib/jobs/fit-import-worker")).handleFitImport,
  }),
  // A Gadgetbridge database export or a FHIR R4 Bundle, one file per job.
  defineJob({
    queue: RECORD_FILE_IMPORT_QUEUE,
    work: { localConcurrency: RECORD_FILE_IMPORT_CONCURRENCY },
    load: async () =>
      (await import("@/lib/jobs/record-file-import-worker"))
        .handleRecordFileImport,
  }),
];
