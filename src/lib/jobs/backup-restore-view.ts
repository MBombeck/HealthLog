/**
 * The read side of a restore job: its row as the status routes answer it.
 *
 * The row's JSON columns are parsed defensively (a row written by an older
 * build reads as nothing rather than as a malformed object), and a queued job
 * says what it waits for (`backup-restore-wait.ts`). The worker and the
 * admission check live in `backup-restore.ts`.
 */
// account-deletion(file): reads restore jobs for the admin view; restores are started by an admin, not for an account by the schedule.
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import type {
  RestorePhase,
  RestoreProgress,
} from "@/lib/export/restore-backup";
import { RESTORE_FAILURE_CAUSES } from "@/lib/export/restore-failure-cause";

import type {
  BackupRestoreFailure,
  BackupRestoreStatus,
} from "./backup-restore";
import { restoreWaits, type RestoreWait } from "./backup-restore-wait";

const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
  sections: z.array(z.string()).optional(),
  keyIds: z.array(z.string()).optional(),
  cause: z.enum(RESTORE_FAILURE_CAUSES).optional(),
});

const progressSchema = z.object({
  measurementsChecked: z.number().int().nonnegative(),
  measurementsTotal: z.number().int().nonnegative().nullable(),
  measurementsWritten: z.number().int().nonnegative(),
  sectionsDone: z.number().int().nonnegative(),
  sectionsTotal: z.number().int().nonnegative(),
});

const resultSchema = z.object({
  summary: z.record(z.string(), z.unknown()),
  skipped: z.object({
    links: z.number().int(),
    catalogueKeys: z.array(
      z.object({
        catalogue: z.string(),
        key: z.string(),
        links: z.number().int(),
      }),
    ),
  }),
  cleared: z.record(z.string(), z.number()),
});

export type BackupRestoreResult = z.infer<typeof resultSchema>;

/** What the status routes answer with. Counts and codes, never content. */
export interface BackupRestoreJobView {
  id: string;
  userId: string;
  username: string | null;
  backupId: string;
  restoreInstanceSettings: boolean;
  status: BackupRestoreStatus;
  phase: RestorePhase | null;
  progress: RestoreProgress | null;
  result: BackupRestoreResult | null;
  failure: BackupRestoreFailure | null;
  /**
   * Why a queued job has not started: the heavy lane put it back while a
   * backup pass (`backup`) or another large job (`busy`) held it. Null while
   * it only waits for the worker, and on every job that is not queued.
   */
  waiting: RestoreWait | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const PHASES: readonly RestorePhase[] = [
  "validating",
  "clearing",
  "measurements",
  "sections",
  "rebuilding",
];
const STATUSES: readonly BackupRestoreStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
];

const viewSelect = {
  id: true,
  userId: true,
  backupId: true,
  restoreInstanceSettings: true,
  status: true,
  phase: true,
  progress: true,
  result: true,
  failure: true,
  attempts: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  pgBossJobId: true,
  user: { select: { username: true } },
} as const;

type ViewRow = {
  id: string;
  userId: string;
  backupId: string;
  restoreInstanceSettings: boolean;
  status: string;
  phase: string | null;
  progress: unknown;
  result: unknown;
  failure: unknown;
  attempts: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  pgBossJobId: string | null;
  user: { username: string } | null;
};

function toView(
  row: ViewRow,
  waits: ReadonlyMap<string, RestoreWait>,
): BackupRestoreJobView {
  const status = (STATUSES as readonly string[]).includes(row.status)
    ? (row.status as BackupRestoreStatus)
    : "failed";
  const phase =
    row.phase && (PHASES as readonly string[]).includes(row.phase)
      ? (row.phase as RestorePhase)
      : null;
  const progress = progressSchema.safeParse(row.progress);
  const result = resultSchema.safeParse(row.result);
  const failure = failureSchema.safeParse(row.failure);
  return {
    id: row.id,
    userId: row.userId,
    username: row.user?.username ?? null,
    backupId: row.backupId,
    restoreInstanceSettings: row.restoreInstanceSettings,
    status,
    phase: status === "running" ? phase : null,
    progress: progress.success ? progress.data : null,
    result: result.success ? result.data : null,
    failure: failure.success
      ? (failure.data as BackupRestoreFailure)
      : status === "failed"
        ? { code: "unexpected", message: "The restore failed." }
        : null,
    waiting:
      status === "queued" && row.pgBossJobId
        ? (waits.get(row.pgBossJobId) ?? null)
        : null,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** What the queued ones among `rows` wait for. */
function waitsOf(rows: readonly ViewRow[]) {
  return restoreWaits(
    rows.flatMap((row) =>
      row.status === "queued" && row.pgBossJobId ? [row.pgBossJobId] : [],
    ),
  );
}

/** One job, for the status route. Null when the id is unknown. */
export async function readBackupRestoreJob(
  id: string,
): Promise<BackupRestoreJobView | null> {
  const row = await prisma.backupRestoreJob.findUnique({
    where: { id },
    select: viewSelect,
  });
  if (!row) return null;
  return toView(row, await waitsOf([row]));
}

/**
 * The jobs the console shows: every queued or running one, and the finished
 * ones of the last day, newest first. What a reload of the page needs to pick
 * up a restore it was watching, and to show how the last one ended.
 */
export async function listRecentBackupRestoreJobs(
  now: Date = new Date(),
): Promise<BackupRestoreJobView[]> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await prisma.backupRestoreJob.findMany({
    where: {
      OR: [
        { status: { in: ["queued", "running"] } },
        { createdAt: { gte: since } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: viewSelect,
  });
  const waits = await waitsOf(rows);
  return rows.map((row) => toView(row, waits));
}
