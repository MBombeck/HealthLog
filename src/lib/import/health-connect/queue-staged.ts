/**
 * The Health Connect import as a staged import (`../staged-upload.ts`): its
 * job kind, queue and payload.
 *
 * Shared by the upload route (`POST /api/import/health-connect-export`) and
 * the scheduled fetch from a WebDAV or Nextcloud folder (`./remote-fetch.ts`),
 * so a file that arrives either way is imported by the same importer exactly
 * once.
 */
import {
  queueStagedImport,
  type QueueStagedResult,
  type StagedImportSpec,
} from "@/lib/import/staged-upload";
import { HEALTH_CONNECT_IMPORT_QUEUE } from "@/lib/jobs/health-connect-import-queue";
import {
  HEALTH_CONNECT_IMPORT_KIND,
  HEALTH_CONNECT_IMPORT_PARSER_REVISION,
  HEALTH_CONNECT_IMPORT_SEND_OPTIONS,
  type HealthConnectImportPayload,
} from "@/lib/jobs/health-connect-import-worker";

export const HEALTH_CONNECT_STAGED_IMPORT: StagedImportSpec = {
  kind: HEALTH_CONNECT_IMPORT_KIND,
  parserRevision: HEALTH_CONNECT_IMPORT_PARSER_REVISION,
  queue: HEALTH_CONNECT_IMPORT_QUEUE,
  sendOptions: HEALTH_CONNECT_IMPORT_SEND_OPTIONS,
  payload: ({
    userId,
    importJobId,
    uploadPath,
  }): HealthConnectImportPayload => ({ userId, importJobId, uploadPath }),
};

export function queueStagedHealthConnectImport(input: {
  userId: string;
  filePath: string;
  bytes: number;
  sha256: string;
}): Promise<QueueStagedResult> {
  return queueStagedImport(HEALTH_CONNECT_STAGED_IMPORT, input);
}
