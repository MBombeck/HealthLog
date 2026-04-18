/**
 * Map WebAuthn / SimpleWebAuthn errors to actionable i18n keys.
 *
 * The browser rejects passkey prompts for several reasons that feel
 * indistinguishable to the user. We preserve the real reason so
 * "registration cancelled" no longer masks "your origin isn't HTTPS" or
 * "this device is already registered".
 */

export interface PasskeyErrorMessage {
  /** i18n key for a user-facing explanation. */
  key: string;
  /** Params for interpolation (e.g. {message} for the unknown-error case). */
  params?: Record<string, string>;
}

export function describePasskeyError(error: unknown): PasskeyErrorMessage {
  if (!(error instanceof Error)) {
    return { key: "settings.passkeyRegistrationFailed" };
  }

  // SimpleWebAuthn wraps DOMException into WebAuthnError with a `code`
  // property, but the underlying DOMException name is the stable signal.
  switch (error.name) {
    case "NotAllowedError":
      // The user cancelled, or the OS-level prompt timed out. Prefer the
      // cancelled copy — it matches what the user did in the common case.
      return { key: "settings.passkeyRegistrationCancelled" };
    case "InvalidStateError":
      return { key: "settings.passkeyAlreadyRegistered" };
    case "NotSupportedError":
      return { key: "settings.passkeyNotSupported" };
    case "SecurityError":
      return { key: "settings.passkeySecurityBlocked" };
    case "AbortError":
      return { key: "settings.passkeyTimeout" };
  }

  // SimpleWebAuthn WebAuthnError surfaces a `code`, e.g. "ERROR_INVALID_RP_ID"
  const code = (error as { code?: string }).code;
  if (code === "ERROR_INVALID_RP_ID" || code === "ERROR_INVALID_DOMAIN") {
    return { key: "settings.passkeySecurityBlocked" };
  }

  return {
    key: "settings.passkeyUnknownError",
    params: { message: error.message || "unknown" },
  };
}
