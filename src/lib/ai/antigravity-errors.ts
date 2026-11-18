/**
 * Errors and failure reasons for the Antigravity CLI provider.
 *
 * Messages here never carry CLI output or user data. The CLI text, when it is
 * needed for diagnosis, sits on `originalError`.
 */

// ─── Errors ──────────────────────────────────────────────────

export const ANTIGRAVITY_ERRORS = {
  CLI_UNAVAILABLE: "cli_unavailable",
  AUTH_REQUIRED: "auth_required",
  SESSION_FAILED: "session_failed",
  PROMPT_FAILED: "prompt_failed",
  QUOTA_EXCEEDED: "quota_exceeded",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  PROCESS_ERROR: "process_error",
  MODEL_UNAVAILABLE: "model_unavailable",
} as const;

/** Why a probe of the CLI did not pass. */
export type AntigravityFailureReason =
  "cli_unavailable" | "auth_required" | "timeout" | "cli_error";

/** Map a failed call to the reason the settings screen shows. */
export function antigravityReasonOf(error: unknown): AntigravityFailureReason {
  if (!(error instanceof AntigravityError)) return "cli_error";
  switch (error.code) {
    case ANTIGRAVITY_ERRORS.AUTH_REQUIRED:
      return "auth_required";
    case ANTIGRAVITY_ERRORS.CLI_UNAVAILABLE:
      return "cli_unavailable";
    case ANTIGRAVITY_ERRORS.TIMEOUT:
      return "timeout";
    default:
      return "cli_error";
  }
}

export class AntigravityError extends Error {
  /**
   * True when the error means the user's OAuth token is expired or missing.
   * The provider-runner's `hopCause` reads this field to log
   * `cause: "credential_expired"` instead of the generic `"network"`.
   */
  readonly credentialExpired: boolean;

  /**
   * True when the requested model is not in the CLI's current session.
   * `hopCause` reads this field to log `cause: "model_not_served"`.
   */
  readonly modelNotServed: boolean;

  /**
   * A `ProviderFailureKind`-compatible tag so `providerFailureKind` in
   * `failure-kind.ts` can classify this error without knowing the class.
   * Values that match a known kind are used directly; others fall through to
   * `"unknown"`.
   */
  readonly kind: string;

  constructor(
    message: string,
    public readonly code: string,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = "AntigravityError";
    this.credentialExpired = code === ANTIGRAVITY_ERRORS.AUTH_REQUIRED;
    this.modelNotServed = code === ANTIGRAVITY_ERRORS.MODEL_UNAVAILABLE;
    this.kind =
      code === ANTIGRAVITY_ERRORS.TIMEOUT
        ? "timeout"
        : code === ANTIGRAVITY_ERRORS.CANCELLED
          ? "aborted"
          : code === ANTIGRAVITY_ERRORS.PROMPT_FAILED
            ? "empty_response"
            : "unknown";
  }
}
