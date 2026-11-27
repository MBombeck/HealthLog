/**
 * The hourly bucket every buffered import shares: the JSON import, the
 * measurements CSV, the labs and medications CSV and the dose-history import
 * all spend `import:<account>`. The staged file uploads (Apple Health, Health
 * Connect, FIT, Gadgetbridge, FHIR Bundle) keep their own per-kind bucket in
 * `staged-upload.ts`.
 *
 * The ceiling is `IMPORT_RATE_LIMIT_PER_HOUR`: a whole number from 1 to 1000,
 * default 5. It exists to stop a runaway script from filling the database,
 * not to make a household wait, so an operator can raise it. A value that is
 * not a whole number inside the bounds is not guessed at: the default is used
 * and the log says so once, so a typo can neither switch the limit off nor
 * lock every import out.
 *
 * This file is the one source of the number. It stays free of the database
 * so the OpenAPI registry can read it; `import-rate-limit.ts` spends the
 * bucket. `import-rate-limit-guard.test.ts` refuses an import route that
 * spends the bucket with a number of its own.
 */
import { envValue } from "@/lib/env";

export const IMPORT_RATE_LIMIT_ENV = "IMPORT_RATE_LIMIT_PER_HOUR";
export const IMPORT_RATE_LIMIT_DEFAULT = 5;
export const IMPORT_RATE_LIMIT_MIN = 1;
export const IMPORT_RATE_LIMIT_MAX = 1000;
export const IMPORT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

let warned = false;

/** The configured hourly import ceiling, or the default when the value is unusable. */
export function resolveImportRateLimitPerHour(): number {
  const raw = envValue(IMPORT_RATE_LIMIT_ENV);
  if (!raw) return IMPORT_RATE_LIMIT_DEFAULT;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    Number.isSafeInteger(value) &&
    value >= IMPORT_RATE_LIMIT_MIN &&
    value <= IMPORT_RATE_LIMIT_MAX
  ) {
    return value;
  }
  if (!warned) {
    warned = true;
    console.warn(
      `[import] ${IMPORT_RATE_LIMIT_ENV} must be a whole number from ${IMPORT_RATE_LIMIT_MIN} to ${IMPORT_RATE_LIMIT_MAX}; using ${IMPORT_RATE_LIMIT_DEFAULT}.`,
    );
  }
  return IMPORT_RATE_LIMIT_DEFAULT;
}

/** Test seam: lets a test see the one-time warning again. */
export function resetImportRateLimitWarningForTests(): void {
  warned = false;
}

/** The 429 message, naming the ceiling actually in force. */
export function importRateLimitMessage(limit: number): string {
  return `Maximum ${limit} imports per hour`;
}

/**
 * The sentence the OpenAPI descriptions carry. The document is generated
 * once, without the operator's environment, so it names the default and
 * the variable rather than a value it cannot know.
 */
export const IMPORT_RATE_LIMIT_DOC = `${IMPORT_RATE_LIMIT_DEFAULT} an hour by default, set by the operator through \`${IMPORT_RATE_LIMIT_ENV}\` (a whole number from ${IMPORT_RATE_LIMIT_MIN} to ${IMPORT_RATE_LIMIT_MAX}; anything else falls back to ${IMPORT_RATE_LIMIT_DEFAULT}); the 429 message names the value in force`;
