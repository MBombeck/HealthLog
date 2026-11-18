import type { Prisma } from "@/generated/prisma/client";

/**
 * Shared OAuth rotating-refresh-token persistence helper.
 *
 * WHOOP and Oura both issue ONE-TIME-USE refresh tokens: every refresh
 * response carries a fresh `refresh_token` that invalidates the one just spent.
 * The naive read → refresh → persist sequence is racy. When two syncs for the
 * same user overlap (a scheduled tick collides with a manual sync, or two
 * resource syncs each call `getValidToken`), both read the SAME stored refresh
 * token, both POST it, and the provider honours only the first. The loser's POST
 * comes back 401, the caller classifies it as `reauth_required`, and the
 * connection is parked at `error_reauth` — spuriously, because the peer already
 * rotated the token successfully and the connection is perfectly healthy.
 *
 * The fix is a compare-and-swap on persistence: write the rotated tokens with a
 * `WHERE refreshToken = <the exact ciphertext we read>` guard. The tokens are
 * AES-256-GCM encrypted with a random IV, so the guard matches the STORED
 * ciphertext (passed in verbatim), never a re-encryption of the plaintext —
 * re-encrypting the same plaintext yields different bytes. If the conditional
 * update touches zero rows a peer refresh already won; re-read the row and reuse
 * the peer's freshly-rotated access token instead of erroring.
 *
 * Both racing callers thus end up with a usable access token and neither parks
 * the connection. The window is small but real on the shared scheduler, and a
 * single spurious reauth forces the user back through the consent flow.
 */

export interface PersistRotatedTokenOptions {
  /**
   * Conditional persist: update the connection row ONLY when its stored refresh
   * token still equals the ciphertext this caller read (compare-and-swap on the
   * stored bytes). Returns the number of rows written — 0 means a peer rotated
   * first. The closure owns the encryption + the `WHERE` clause so the helper
   * stays storage-agnostic across the three provider tables.
   */
  conditionalUpdate: () => Promise<number>;
  /**
   * Re-read the connection AFTER a lost race and return the peer's freshly
   * rotated, DECRYPTED access token. Returns null only if the row vanished
   * (connection deleted mid-flight) — the caller then treats it as no token.
   */
  readPeerAccessToken: () => Promise<string | null>;
}

/**
 * Persist a rotated token pair with compare-and-swap semantics, falling back to
 * the peer's token on a lost race. Returns the access token the caller should
 * use for the current sync — the one it just minted on a win, or the peer's on a
 * loss — or null when the connection no longer exists.
 */
export async function persistRotatedToken(
  freshAccessToken: string,
  opts: PersistRotatedTokenOptions,
): Promise<string | null> {
  const rows = await opts.conditionalUpdate();
  if (rows > 0) return freshAccessToken;
  // Lost the race: a concurrent refresh already rotated the stored token, which
  // invalidated the one we spent. Reuse the peer's freshly rotated access token
  // rather than parking the connection at reauth.
  return opts.readPeerAccessToken();
}

export type SerializedRefreshProvider =
  | "whoop"
  | "withings"
  | "oura"
  | "strava"
  | "google-health"
  | "polar"
  | "codex"
  | "admin-codex";

/**
 * Provider refreshes hold a database transaction open around one bounded
 * external request. `maxWait` bounds pool acquisition and `timeout` bounds the
 * advisory-lock wait, provider call, and durable token replacement together.
 */
export const PROVIDER_REFRESH_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000,
} as const;

/**
 * Serialize one provider/user refresh attempt for the transaction lifetime.
 * Callers must re-read token state after this returns: a prior contender may
 * have committed a fresh token while this transaction waited for the lock.
 */
export async function acquireProviderTokenRefreshLock(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  provider: SerializedRefreshProvider,
  userId: string,
): Promise<void> {
  const key = `provider-token-refresh:${provider}:${userId}`;
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))
  `;
}
