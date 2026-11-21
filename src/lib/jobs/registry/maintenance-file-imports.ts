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

import {
  HEALTH_CONNECT_REMOTE_FETCH_CRON,
  HEALTH_CONNECT_REMOTE_FETCH_QUEUE,
} from "@/lib/jobs/health-connect-remote-queue";

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
  // The scheduled Health Connect export, fetched from a WebDAV or Nextcloud
  // folder; each pass reads only the folders that are due.
  defineJob({
    queue: HEALTH_CONNECT_REMOTE_FETCH_QUEUE,
    cron: HEALTH_CONNECT_REMOTE_FETCH_CRON,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/health-connect-remote-worker"))
        .handleHealthConnectRemoteFetch,
  }),
];
