/**
 * The single-use state blob of an SSO sign-in, as the callback reads it back
 * (`GET /api/auth/oidc/callback`), and the provider error codes it may name
 * in its wide event.
 */
import { decrypt } from "@/lib/crypto";

export interface StoredOidcState {
  state: string;
  nonce: string;
  codeVerifier: string;
  next: string;
  /**
   * Set only when the login GET carried `client=native`. When true the
   * callback mints a handoff code (or MFA ticket) and redirects to the custom
   * scheme instead of minting a session. Both fields live ONLY inside the
   * AES-256-GCM blob, so they are tamper-authenticated: a network attacker or
   * the IdP cannot flip a web login into a native one or swap the app
   * challenge.
   */
  native?: boolean;
  /** The app's S256 PKCE challenge, bound at login; verified at the exchange. */
  appCodeChallenge?: string;
  /**
   * Set only when the login carried `intent=claim` and a valid `hl_claim`
   * cookie (#959). The callback then claims the managed profile the cookie
   * names instead of signing in, and only when the cookie still carries this
   * exact binding. Web only: never together with `native`.
   */
  intent?: "claim" | "reproof";
  claimBinding?: string;
  /**
   * Set only for `intent: "reproof"` (`GET /api/auth/oidc/reproof`): the
   * signed-in account and the session row the round trip confirms. The
   * callback stamps nothing unless the browser still carries exactly this
   * session and the provider names exactly this account's linked identity.
   * Web only, like the claim.
   */
  reproofUserId?: string;
  reproofSessionId?: string;
}

function isStoredOidcState(value: unknown): value is StoredOidcState {
  const v = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof v.state !== "string" ||
    typeof v.nonce !== "string" ||
    typeof v.codeVerifier !== "string" ||
    typeof v.next !== "string"
  ) {
    return false;
  }
  // Optional native fields: when present they must be the right shape, and a
  // native start MUST carry the challenge the exchange verifies against.
  if (v.native !== undefined) {
    if (v.native !== true) return false;
    if (typeof v.appCodeChallenge !== "string") return false;
  }
  if (v.intent !== undefined) {
    if (v.native !== undefined) return false;
    if (v.intent === "claim") {
      if (typeof v.claimBinding !== "string" || v.claimBinding.length === 0) {
        return false;
      }
    } else if (v.intent === "reproof") {
      if (
        typeof v.reproofUserId !== "string" ||
        v.reproofUserId.length === 0 ||
        typeof v.reproofSessionId !== "string" ||
        v.reproofSessionId.length === 0 ||
        v.claimBinding !== undefined
      ) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

/** The decrypted blob, or null when it is missing, unreadable or malformed. */
export function readStoredOidcState(
  rawCookie: string | undefined,
): StoredOidcState | null {
  if (!rawCookie) return null;
  try {
    const parsed: unknown = JSON.parse(decrypt(rawCookie));
    return isStoredOidcState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Closed set of RFC 6749 §4.1.2.1 / OIDC Core §3.1.2.6 authorization error
 * codes. The wide-event meta only ever carries a member of this set (or
 * "other"), never the raw, attacker-influenceable query value.
 */
const KNOWN_IDP_ERROR_CODES = new Set([
  "access_denied",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "interaction_required",
  "login_required",
  "account_selection_required",
  "consent_required",
  "invalid_request_uri",
  "invalid_request_object",
  "request_not_supported",
  "request_uri_not_supported",
  "registration_not_supported",
]);

/** The provider's error code as the wide event may carry it. */
export function idpErrorCode(raw: string): string {
  return KNOWN_IDP_ERROR_CODES.has(raw) ? raw : "other";
}
