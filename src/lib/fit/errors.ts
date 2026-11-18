/**
 * The refusals of the FIT importer, one code per reason a file is turned
 * away. The code leads the job's `failureReason` (`<code>: <detail>`), and
 * the import card translates it; the detail is for the operator.
 *
 * No message ever carries a value read from the file: a device name, a
 * developer field name or a timestamp from an untrusted upload stays out of
 * the job row and the logs.
 */
export const FIT_FAILURE_CODES = [
  /** Neither a FIT file, a gzip of one, nor a ZIP holding one. */
  "unsupported_file",
  /** A ZIP without exactly one `.fit` member, encrypted, or unreadable. */
  "archive_invalid",
  /** Over the upload cap, or inflates past the decompressed cap. */
  "too_large",
  /** Not a FIT file: the header or its `.FIT` signature is wrong. */
  "not_fit",
  /** The header or file checksum does not match: the file is damaged. */
  "crc_mismatch",
  /** The data ends inside a message, or a message names no definition. */
  "malformed",
  /** More messages, definitions or developer fields than any activity has. */
  "too_complex",
  /** A FIT file, but not an activity (a course, a monitoring file, ...). */
  "not_activity",
  /** An activity file without one usable session. */
  "no_session",
  /** The staged upload is no longer on the worker's disk. */
  "staging_missing",
] as const;

export type FitFailureCode = (typeof FIT_FAILURE_CODES)[number];

export class FitImportError extends Error {
  readonly code: FitFailureCode;

  constructor(code: FitFailureCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "FitImportError";
    this.code = code;
  }
}

/** The code at the front of a stored failure reason, when it is one of ours. */
export function fitFailureCodeOf(
  reason: string | null | undefined,
): FitFailureCode | null {
  if (!reason) return null;
  const head = reason.split(":", 1)[0]!.trim();
  return (FIT_FAILURE_CODES as readonly string[]).includes(head)
    ? (head as FitFailureCode)
    : null;
}
