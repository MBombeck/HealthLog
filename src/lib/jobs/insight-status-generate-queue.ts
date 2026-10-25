/**
 * The queue facts of `insight-status-generate-shared.ts`: its name and, where it has them, its
 * schedule, concurrency and send options. They live apart from the job so the
 * worker registry and every sender can read them without loading it.
 */
import {
  COMPLETION_CEILING_MS,
  expireAboveModelTime,
} from "@/lib/jobs/model-time";

export const INSIGHT_STATUS_GENERATE_QUEUE = "insight-status-generate";

/**
 * The job's expiry: one status run at the largest response timeout (the call
 * and its one reasoning repeat), plus headroom. Two ten-minute calls outlive
 * pg-boss's fifteen-minute default, which then failed the job and queued a
 * retry beside the generation still running (#1274).
 */
export const INSIGHT_STATUS_GENERATE_EXPIRE_SECONDS = expireAboveModelTime(
  COMPLETION_CEILING_MS,
);

/**
 * Low concurrency keeps the on-demand warm pass from saturating the
 * Prisma pool or fanning out an unbounded number of concurrent provider
 * calls when several cards request generation on the same first visit.
 */
export const INSIGHT_STATUS_GENERATE_CONCURRENCY = 2;
