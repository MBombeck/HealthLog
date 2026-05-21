import { createHash, randomBytes } from "node:crypto";
import { encrypt, decrypt } from "@/lib/crypto";

/**
 * Codex / ChatGPT-OAuth flow — implemented against `docs/codex-protocol-spec.md`,
 * which mirrors the official `openai/codex` CLI.
 *
 * Production-only path: **device-code flow**. The browser/auth-code flow
 * does not work for hosted apps — Hydra's redirect-URI allow-list for the
 * public Codex CLI client ID covers only `localhost:1455/1457`. The
 * device-code flow side-steps that: the user types a short code on
 * `auth.openai.com/codex/device`, we poll, on success we get an
 * authorization-code internally and exchange it for OAuth tokens.
 *
 * After the exchange we hold three pieces:
 *   - `accessToken` — the OAuth access token used as `Authorization: Bearer`
 *     on every Codex request.
 *   - `refreshToken` — long-lived; rotates on every refresh.
 *   - `accountId`    — the `chatgpt_account_id` claim from the id_token,
 *     required as the `ChatGPT-Account-ID` header (without it: 401).
 *
 * All three are persisted (JSON-encoded then encrypted) on the user row
 * so we don't need a schema migration.
 */

const ISSUER = "https://auth.openai.com";

/**
 * Public PKCE client ID hardcoded in the official `openai/codex` CLI
 * (`codex-rs/login/src/auth/manager.rs`). Operators with a private OAuth
 * app can override via env var.
 */
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Same scopes the official CLI requests. */
const CODEX_SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

const DEVICE_VERIFICATION_URL = `${ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(96));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(32));
}

export function getCodexClientId(): string {
  return process.env.CODEX_OAUTH_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
}

export function isCodexOAuthConfigured(): boolean {
  return true;
}

// ─── JWT inspection ──────────────────────────────────────────────────

interface JwtClaims {
  exp?: number;
  chatgpt_account_id?: string;
  /**
   * The official Codex CLI also accepts the URI-namespaced variant
   * (`https://api.openai.com/auth.chatgpt_account_id`) in the
   * `https://api.openai.com/auth` claim object — see
   * `codex-rs/login/src/auth/manager.rs:891`.
   */
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
  [key: string]: unknown;
}

function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].padEnd(
      parts[1].length + ((4 - (parts[1].length % 4)) % 4),
      "=",
    );
    const json = Buffer.from(padded, "base64url").toString("utf8");
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}

function extractAccountId(idToken: string): string | null {
  const claims = decodeJwtClaims(idToken);
  if (!claims) return null;
  if (typeof claims.chatgpt_account_id === "string") {
    return claims.chatgpt_account_id;
  }
  const namespaced = claims["https://api.openai.com/auth"];
  if (
    namespaced &&
    typeof namespaced === "object" &&
    typeof namespaced.chatgpt_account_id === "string"
  ) {
    return namespaced.chatgpt_account_id;
  }
  return null;
}

function extractExpiry(idToken: string): Date | null {
  const claims = decodeJwtClaims(idToken);
  if (!claims || typeof claims.exp !== "number") return null;
  return new Date(claims.exp * 1000);
}

// ─── Token shape persisted on the user row ───────────────────────────

export interface CodexCreds {
  /** OAuth access token used directly against chatgpt.com/backend-api. */
  accessToken: string;
  /** OAuth refresh token; rotates on every refresh. */
  refreshToken: string;
  /**
   * `chatgpt_account_id` claim from the id_token. Required as the
   * `ChatGPT-Account-ID` header on every Codex backend request.
   */
  accountId: string;
  /** Wall-clock expiry. Derived from id_token `exp`, fallback expires_in. */
  expiresAt: Date;
}

interface RawTokenResponse {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

function buildCreds(
  raw: RawTokenResponse,
  prevRefresh: string | null,
): CodexCreds {
  const accountId = extractAccountId(raw.id_token);
  if (!accountId) {
    throw new Error(
      "Codex token exchange returned id_token without chatgpt_account_id",
    );
  }
  const refreshToken = raw.refresh_token ?? prevRefresh ?? "";
  if (!refreshToken) {
    throw new Error("Codex token exchange returned no refresh_token");
  }
  const jwtExp = extractExpiry(raw.id_token);
  const expiresAt =
    jwtExp ?? new Date(Date.now() + (raw.expires_in ?? 3600) * 1000);
  return {
    accessToken: raw.access_token,
    refreshToken,
    accountId,
    expiresAt,
  };
}

// ─── Device-code flow ────────────────────────────────────────────────

export interface DeviceCodeStart {
  userCode: string;
  verificationUrl: string;
  deviceAuthId: string;
  intervalSeconds: number;
}

export async function requestDeviceCode(): Promise<DeviceCodeStart> {
  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: getCodexClientId() }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Codex device-code request failed (${res.status}): ${body}`,
    );
  }
  const json = (await res.json()) as {
    device_auth_id: string;
    user_code: string;
    interval: string | number;
  };
  return {
    userCode: json.user_code,
    verificationUrl: DEVICE_VERIFICATION_URL,
    deviceAuthId: json.device_auth_id,
    intervalSeconds:
      typeof json.interval === "string"
        ? Number(json.interval) || 5
        : json.interval || 5,
  };
}

export type DevicePollResult =
  | { status: "pending" }
  | { status: "connected"; creds: CodexCreds };

/**
 * One poll attempt against the device-auth token endpoint. Returns
 * `pending` while the user has not yet approved (Hydra answers with
 * 403/404), and `connected` with fully resolved Codex credentials
 * once the user finishes the approval on chatgpt.com.
 */
export async function pollDeviceCode(params: {
  deviceAuthId: string;
  userCode: string;
}): Promise<DevicePollResult> {
  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_auth_id: params.deviceAuthId,
      user_code: params.userCode,
    }),
  });

  if (res.status === 403 || res.status === 404) {
    return { status: "pending" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Codex device-code poll failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    authorization_code: string;
    code_challenge: string;
    code_verifier: string;
  };

  // Standard PKCE exchange against the OAuth token endpoint, with the
  // device-auth callback URI Hydra associates with this authorization
  // code internally.
  const tokenRes = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: getCodexClientId(),
      code: json.authorization_code,
      redirect_uri: DEVICE_REDIRECT_URI,
      code_verifier: json.code_verifier,
    }).toString(),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    throw new Error(
      `Codex device-code token exchange failed (${tokenRes.status}): ${body}`,
    );
  }
  const tokens = (await tokenRes.json()) as RawTokenResponse;
  return {
    status: "connected",
    creds: buildCreds(tokens, null),
  };
}

/**
 * Refresh an OAuth access token using the long-lived refresh token.
 * Per `docs/codex-protocol-spec.md` §6d, the refresh endpoint takes
 * a JSON body (NOT form-urlencoded — that detail bit us once before).
 *
 * The refresh token rotates on every call; the new value (when
 * present in the response) MUST be persisted, otherwise the next
 * attempt fails with `refresh_token_reused`.
 */
export async function refreshDeviceTokens(
  refreshToken: string,
): Promise<CodexCreds> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: getCodexClientId(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: CODEX_SCOPES,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Codex device-token refresh failed (${res.status}): ${body}`,
    );
  }
  const tokens = (await res.json()) as RawTokenResponse;
  return buildCreds(tokens, refreshToken);
}

// ─── Encrypted-storage codec ────────────────────────────────────────
//
// We re-purpose `codexAccessTokenEncrypted` to store the entire creds
// blob (access_token + accountId + expiresAt) JSON-encoded then
// encrypted. `codexRefreshTokenEncrypted` continues to hold just the
// refresh token (encrypted), so a future migration to a dedicated
// column shape stays simple. Old v1.4.9-v1.4.11 tokens stored without
// the accountId field will fail to parse — the user has to re-connect
// once after the v1.4.12 deploy. Acceptable since those connects
// never produced a working session anyway.

interface StoredAccess {
  accessToken: string;
  accountId: string;
  expiresAt: string; // ISO
}

export function encryptCodexCreds(creds: CodexCreds): {
  accessEncrypted: string;
  refreshEncrypted: string;
} {
  const stored: StoredAccess = {
    accessToken: creds.accessToken,
    accountId: creds.accountId,
    expiresAt: creds.expiresAt.toISOString(),
  };
  return {
    accessEncrypted: encrypt(JSON.stringify(stored)),
    refreshEncrypted: encrypt(creds.refreshToken),
  };
}

export function decryptCodexCreds(encrypted: {
  accessEncrypted: string;
  refreshEncrypted: string;
}): CodexCreds | null {
  let parsed: StoredAccess;
  try {
    const raw = decrypt(encrypted.accessEncrypted);
    parsed = JSON.parse(raw) as StoredAccess;
  } catch {
    // Pre-v1.4.12 stored format (raw access token / api key string).
    // We cannot recover the accountId from that — caller must treat
    // the connection as expired and ask the user to re-link.
    return null;
  }
  if (!parsed.accessToken || !parsed.accountId) return null;
  return {
    accessToken: parsed.accessToken,
    refreshToken: decrypt(encrypted.refreshEncrypted),
    accountId: parsed.accountId,
    expiresAt: new Date(parsed.expiresAt),
  };
}
