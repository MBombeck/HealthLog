/**
 * Waiting out the upload route's busy signal.
 *
 * The inbound route admits a bounded number of uploads per person and per
 * process (`acquireDocumentUploadSlot` in `src/lib/documents/upload-policy.ts`)
 * and answers anything beyond that with 429, `meta.reason: "uploadBusy"` and
 * `Retry-After: 1`. That is "a slot frees up in a second", not a quota, so the
 * client retries the same file on its own instead of showing an error: a
 * person dropping several files, or uploading from two tabs, should never see
 * one. Only after the budget below runs out does the row turn into an error.
 *
 * The hourly upload limit (`documents.inbound.rateLimited`) is a different
 * 429 and is never retried here.
 */
import type { UploadResult } from "./vault-utils";

/** Attempts per file, the first one included. */
export const UPLOAD_BUSY_MAX_ATTEMPTS = 6;

/** Longest a file keeps retrying before it gives up, measured from the first attempt. */
export const UPLOAD_BUSY_BUDGET_MS = 30_000;

const MIN_WAIT_SECONDS = 1;
const MAX_WAIT_SECONDS = 10;
/** Spread two waiting files apart so they do not collide again on the same tick. */
const MAX_JITTER_MS = 500;

/** `Retry-After` as whole seconds; anything else (HTTP-date, junk, absent) is undefined. */
export function parseRetryAfterSeconds(
  header: string | null | undefined,
): number | undefined {
  if (!header || !/^\s*\d+\s*$/u.test(header)) return undefined;
  return Number.parseInt(header, 10);
}

/** How long to wait before the next attempt: `Retry-After` clamped to 1–10 s, plus jitter. */
export function busyRetryDelayMs(
  retryAfterSeconds: number | undefined,
  random: () => number = Math.random,
): number {
  const seconds = Math.min(
    MAX_WAIT_SECONDS,
    Math.max(MIN_WAIT_SECONDS, retryAfterSeconds ?? MIN_WAIT_SECONDS),
  );
  return seconds * 1000 + Math.floor(random() * MAX_JITTER_MS);
}

/** Resolves true after `ms`, or false as soon as `signal` aborts (the timer is cleared). */
function waitUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface BusyRetryOptions {
  /** Aborting stops any further attempt; the last result is returned as is. */
  signal?: AbortSignal;
  /** Called before every attempt after the first. */
  onRetry?: () => void;
  random?: () => number;
  now?: () => number;
}

/**
 * Run `attempt` and repeat it while the server answers `uploadBusy`, within
 * {@link UPLOAD_BUSY_MAX_ATTEMPTS} and {@link UPLOAD_BUSY_BUDGET_MS}. Every
 * other result, success or failure, comes back after the attempt that
 * produced it.
 */
export async function uploadWithBusyRetry(
  attempt: () => Promise<UploadResult>,
  options: BusyRetryOptions = {},
): Promise<UploadResult> {
  const now = options.now ?? Date.now;
  const started = now();
  for (let made = 1; ; made += 1) {
    const result = await attempt();
    if (result.ok || result.reason !== "uploadBusy") return result;
    if (made >= UPLOAD_BUSY_MAX_ATTEMPTS) return result;
    const delay = busyRetryDelayMs(result.retryAfterSeconds, options.random);
    if (now() - started + delay > UPLOAD_BUSY_BUDGET_MS) return result;
    if (!(await waitUnlessAborted(delay, options.signal))) return result;
    options.onRetry?.();
  }
}
