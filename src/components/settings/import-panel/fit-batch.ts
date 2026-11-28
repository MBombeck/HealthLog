/**
 * Several activity files at once, one after the other. Each file goes
 * through the same upload route and the same background job as a single
 * file (`POST /api/import/fit`, one `ImportJob` per file); the next file is
 * sent only once the previous job has finished, because the server runs one
 * import per account at a time.
 *
 * A file already imported is reported as skipped twice over: the same bytes
 * resolve to the earlier job (`idempotent`), and the same session in other
 * bytes (a zipped copy, a re-export) finishes with nothing written and the
 * session counted as already present.
 *
 * No React and no fetch of its own: the card hands in the upload, the status
 * read and the clock, so the whole run is testable without a browser.
 */
import { fitFailureCodeOf } from "@/lib/fit/errors";

/** The most files one selection takes. */
export const FIT_BATCH_MAX_FILES = 100;

/**
 * The upload cap, checked before sending so a file the server would refuse
 * does not spend the account's upload budget. Equal to
 * `FIT_UPLOAD_MAX_BYTES` (`src/lib/fit/container.ts`, server-only); a test
 * holds the two together.
 */
export const FIT_BATCH_FILE_MAX_BYTES = 10 * 1024 * 1024;

export type FitFileFailure =
  | "tooLarge"
  | "unsupported"
  | "damaged"
  | "notActivity"
  | "noWorkout"
  | "busy"
  | "retry";

export type FitFileState =
  | { status: "waiting" }
  | { status: "uploading" }
  | { status: "imported" }
  | { status: "duplicate" }
  | { status: "failed"; reason: FitFileFailure };

/** The job as `GET /api/import/fit/status` answers it, the fields read here. */
export interface FitBatchJob {
  jobId: string;
  status: string;
  result: {
    imported?: number;
    merged?: number;
    alreadyPresent?: number;
  } | null;
  failureReason: string | null;
}

export interface FitBatchDeps {
  upload(file: File): Promise<Response>;
  status(): Promise<{ job: FitBatchJob | null }>;
  sleep(ms: number): Promise<void>;
  /** True once the card is gone; the run stops at the next step. */
  cancelled(): boolean;
}

const POLL_MS = 2000;
/** A job not finished after this long is reported, not waited on forever. */
const POLL_LIMIT = 450;
/** Waits on the rate limit or a running import before giving up on a file. */
const RETRY_LIMIT = 30;
const BUSY_WAIT_MS = 10_000;
const RATE_WAIT_MS = 15_000;

const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

/** The short reason a failed job is shown with. */
export function fitFileFailureOf(reason: string | null): FitFileFailure {
  switch (fitFailureCodeOf(reason)) {
    case "too_large":
      return "tooLarge";
    case "unsupported_file":
    case "not_fit":
      return "unsupported";
    case "archive_invalid":
    case "crc_mismatch":
    case "malformed":
    case "too_complex":
      return "damaged";
    case "not_activity":
      return "notActivity";
    case "no_session":
      return "noWorkout";
    default:
      return "retry";
  }
}

/** What a finished job means for its file. */
export function fitFileOutcome(job: FitBatchJob): FitFileState {
  if (job.status === "failed")
    return { status: "failed", reason: fitFileFailureOf(job.failureReason) };
  const written = count(job.result?.imported) + count(job.result?.merged);
  if (written > 0) return { status: "imported" };
  if (count(job.result?.alreadyPresent) > 0) return { status: "duplicate" };
  return { status: "failed", reason: "noWorkout" };
}

function retryAfterMs(res: Response): number {
  const seconds = Number(res.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds, 60) * 1000
    : RATE_WAIT_MS;
}

async function waitForJob(
  jobId: string,
  deps: FitBatchDeps,
): Promise<FitFileState | null> {
  for (let i = 0; i < POLL_LIMIT; i++) {
    if (deps.cancelled()) return null;
    const { job } = await deps.status();
    if (
      job?.jobId === jobId &&
      (job.status === "done" || job.status === "failed")
    )
      return fitFileOutcome(job);
    await deps.sleep(POLL_MS);
  }
  return { status: "failed", reason: "retry" };
}

/** Upload one file and follow its job. `null` when the run was cancelled. */
export async function importFitFile(
  file: File,
  deps: FitBatchDeps,
): Promise<FitFileState | null> {
  if (file.size > FIT_BATCH_FILE_MAX_BYTES)
    return { status: "failed", reason: "tooLarge" };
  let lastWait: "busy" | "rate" = "rate";
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    if (deps.cancelled()) return null;
    let res: Response;
    try {
      res = await deps.upload(file);
    } catch {
      return { status: "failed", reason: "retry" };
    }
    if (res.status === 429) {
      lastWait = "rate";
      await deps.sleep(retryAfterMs(res));
      continue;
    }
    if (res.status === 409) {
      lastWait = "busy";
      await deps.sleep(BUSY_WAIT_MS);
      continue;
    }
    if (res.status === 413) return { status: "failed", reason: "tooLarge" };
    if (!res.ok) return { status: "failed", reason: "retry" };
    const body = (await res.json().catch(() => null)) as {
      data?: { jobId?: string; status?: string; idempotent?: boolean };
    } | null;
    const data = body?.data;
    if (!data?.jobId) return { status: "failed", reason: "retry" };
    // The same bytes, already imported: nothing is sent to the worker.
    if (data.idempotent && data.status === "done")
      return { status: "duplicate" };
    try {
      return await waitForJob(data.jobId, deps);
    } catch {
      return { status: "failed", reason: "retry" };
    }
  }
  return { status: "failed", reason: lastWait === "busy" ? "busy" : "retry" };
}

/** Run the files in order, reporting each file's state as it changes. */
export async function runFitBatch(
  files: readonly File[],
  deps: FitBatchDeps,
  onState: (index: number, state: FitFileState) => void,
): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    if (deps.cancelled()) return;
    onState(i, { status: "uploading" });
    const state = await importFitFile(files[i]!, deps);
    if (state === null) return;
    onState(i, state);
  }
}
