/**
 * Hand a staged Health Connect export to the import queue: the same-bytes
 * dedupe, the one-import-per-account rule, the job row and the queue send.
 *
 * Shared by the upload route (`POST /api/import/health-connect-export`) and
 * the scheduled fetch from a WebDAV or Nextcloud folder
 * (`src/lib/import/health-connect/remote-fetch.ts`), so a file that arrives
 * either way is imported by the same importer exactly once. The staged file
 * is consumed on every way out except `queued`, where the worker owns it.
 */
import { unlink } from "node:fs/promises";

import { prisma } from "@/lib/db";
import {
  createImportJobUnlessBusy,
  discardStagedUpload,
} from "@/lib/import/apple-health-staging";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { HEALTH_CONNECT_IMPORT_QUEUE } from "@/lib/jobs/health-connect-import-queue";
import {
  HEALTH_CONNECT_IMPORT_KIND,
  HEALTH_CONNECT_IMPORT_PARSER_REVISION,
  HEALTH_CONNECT_IMPORT_SEND_OPTIONS,
  type HealthConnectImportPayload,
} from "@/lib/jobs/health-connect-import-worker";

export type QueueStagedResult =
  | { outcome: "queued"; jobId: string }
  | { outcome: "idempotent"; jobId: string; status: string }
  | { outcome: "busy"; jobId: string }
  | { outcome: "no_worker" }
  | { outcome: "not_queued" };

export async function queueStagedHealthConnectImport(input: {
  userId: string;
  filePath: string;
  bytes: number;
  sha256: string;
}): Promise<QueueStagedResult> {
  const existing = await prisma.importJob.findFirst({
    where: {
      userId: input.userId,
      kind: HEALTH_CONNECT_IMPORT_KIND,
      uploadSha256: input.sha256,
      parserRevision: HEALTH_CONNECT_IMPORT_PARSER_REVISION,
      status: { not: "failed" },
    },
    orderBy: { startedAt: "desc" },
  });
  if (existing) {
    await unlink(input.filePath).catch(() => {});
    return {
      outcome: "idempotent",
      jobId: existing.id,
      status: existing.status,
    };
  }

  const boss = getGlobalBoss();
  if (!boss) {
    await discardStagedUpload(input.filePath);
    return { outcome: "no_worker" };
  }

  const staged = await createImportJobUnlessBusy(prisma, {
    userId: input.userId,
    kind: HEALTH_CONNECT_IMPORT_KIND,
    status: "queued",
    uploadBytes: input.bytes,
    uploadSha256: input.sha256,
    parserRevision: HEALTH_CONNECT_IMPORT_PARSER_REVISION,
  });
  if ("busy" in staged) {
    await discardStagedUpload(input.filePath);
    return { outcome: "busy", jobId: staged.busy.id };
  }
  const importJob = staged.created;

  const payload: HealthConnectImportPayload = {
    userId: input.userId,
    importJobId: importJob.id,
    uploadPath: input.filePath,
  };
  const bossJobId = await boss.send(
    HEALTH_CONNECT_IMPORT_QUEUE,
    payload,
    HEALTH_CONNECT_IMPORT_SEND_OPTIONS,
  );
  if (!bossJobId) {
    await prisma.importJob.update({
      where: { id: importJob.id },
      data: {
        status: "failed",
        failureReason:
          "The import could not be queued. Upload the export again.",
        completedAt: new Date(),
      },
    });
    await discardStagedUpload(input.filePath);
    return { outcome: "not_queued" };
  }
  await prisma.importJob.update({
    where: { id: importJob.id },
    data: { pgBossJobId: bossJobId },
  });
  return { outcome: "queued", jobId: importJob.id };
}
