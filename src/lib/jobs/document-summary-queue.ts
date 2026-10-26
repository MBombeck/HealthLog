/**
 * The queue facts of `document-summary.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
import {
  COMPLETION_CEILING_MS,
  expireAboveModelTime,
} from "@/lib/jobs/model-time";

export const DOCUMENT_SUMMARY_QUEUE = "document-summary";

/**
 * The job's expiry: one summary call (`DOCUMENT_SUMMARY_MODEL_CALLS`) and its
 * reasoning repeat at the largest response timeout, plus headroom. Two
 * ten-minute attempts outlived pg-boss's fifteen-minute default (#1274).
 */
export const DOCUMENT_SUMMARY_EXPIRE_SECONDS = expireAboveModelTime(
  COMPLETION_CEILING_MS,
);

/** Serial concurrency — provider calls, kept off the request pool. */
export const DOCUMENT_SUMMARY_CONCURRENCY = 1;
