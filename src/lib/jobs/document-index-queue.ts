/**
 * The queue facts of `document-index.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
import {
  COMPLETION_CEILING_MS,
  expireAboveModelTime,
} from "@/lib/jobs/model-time";

export const DOCUMENT_INDEX_QUEUE = "document-index";

/**
 * The completions that run before the job's deadline can turn a read away:
 * the transcription, and the first lab-staging read with its corrective
 * retry (`1 + OCR_EXTRACT_MODEL_CALLS`; the staging plans at least one read).
 * Every further read is planned against the deadline.
 */
export const DOCUMENT_INDEX_UNPLANNED_COMPLETIONS = 3;

/**
 * The job's expiry. Since the lab staging reads a long report in parts, one
 * index could make the transcription plus up to twenty reads of two calls
 * each at the person's timeout, hours past pg-boss's fifteen-minute default,
 * which then failed the job and retried it beside the reads still running
 * (#1274). The staging now plans its reads to end before three quarters of
 * this (`jobDeadline`); what runs before that plan, at the largest setting,
 * still ends below it.
 */
export const DOCUMENT_INDEX_EXPIRE_SECONDS = expireAboveModelTime(
  DOCUMENT_INDEX_UNPLANNED_COMPLETIONS * COMPLETION_CEILING_MS,
);

/** Serial concurrency — provider calls + PDF parse, kept off the request pool. */
export const DOCUMENT_INDEX_CONCURRENCY = 1;
