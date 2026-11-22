/**
 * #1404 — the recorded background AI failures, as the routes serve them.
 *
 * Only rows still inside the retention window, only closed codes and kinds
 * (an unknown value on disk is skipped rather than served), and a document's
 * rows only while the document is live in the record.
 */
import { prisma } from "@/lib/db";

import {
  AI_JOB_FAILURE_RETENTION_MS,
  DOCUMENT_AI_JOB_KINDS,
  isAiJobFailureCode,
  isAiJobKind,
  type AiJobFailureDto,
} from "./types";

/** At most this many rows in the settings list. */
export const AI_JOB_FAILURE_LIST_LIMIT = 50;

interface FailureRow {
  job: string;
  subjectId: string;
  code: string;
  providerType: string | null;
  failCount: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
}

const ROW_SELECT = {
  job: true,
  subjectId: true,
  code: true,
  providerType: true,
  failCount: true,
  firstFailedAt: true,
  lastFailedAt: true,
} as const;

function toDto(row: FailureRow): AiJobFailureDto | null {
  if (!isAiJobKind(row.job) || !isAiJobFailureCode(row.code)) return null;
  return {
    job: row.job,
    code: row.code,
    documentId: row.subjectId === "" ? null : row.subjectId,
    providerType: row.providerType,
    failCount: row.failCount,
    firstFailedAt: row.firstFailedAt.toISOString(),
    lastFailedAt: row.lastFailedAt.toISOString(),
  };
}

function since(): Date {
  return new Date(Date.now() - AI_JOB_FAILURE_RETENTION_MS);
}

/** The record's recorded failures, newest first. */
export async function listAiJobFailures(
  userId: string,
): Promise<AiJobFailureDto[]> {
  const rows = await prisma.aiJobFailure.findMany({
    where: { userId, lastFailedAt: { gte: since() } },
    select: ROW_SELECT,
    orderBy: [{ lastFailedAt: "desc" }, { id: "asc" }],
    take: AI_JOB_FAILURE_LIST_LIMIT,
  });
  const documentIds = [
    ...new Set(
      rows
        .filter((row) => row.subjectId !== "" && isAiJobKind(row.job))
        .filter((row) => DOCUMENT_AI_JOB_KINDS.has(row.job as never))
        .map((row) => row.subjectId),
    ),
  ];
  const live =
    documentIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await prisma.inboundDocument.findMany({
              where: { userId, id: { in: documentIds }, deletedAt: null },
              select: { id: true },
            })
          ).map((doc) => doc.id),
        );
  return rows
    .filter((row) => row.subjectId === "" || live.has(row.subjectId))
    .map(toDto)
    .filter((dto): dto is AiJobFailureDto => dto !== null);
}

/** One document's recorded failures, newest first. */
export async function documentAiJobFailures(
  userId: string,
  documentId: string,
): Promise<AiJobFailureDto[]> {
  const rows = await prisma.aiJobFailure.findMany({
    where: { userId, subjectId: documentId, lastFailedAt: { gte: since() } },
    select: ROW_SELECT,
    orderBy: [{ lastFailedAt: "desc" }, { id: "asc" }],
  });
  return rows.map(toDto).filter((dto): dto is AiJobFailureDto => dto !== null);
}
