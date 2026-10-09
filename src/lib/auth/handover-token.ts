/**
 * v1.42 (#959) — managed-profile handover tokens.
 *
 * A Guardian mints one of these to hand a managed profile over to the person
 * it describes. The raw token (`hlp_<64 hex>`) is shown exactly once, in the
 * response that minted it; only its HMAC-SHA256 hash under
 * `API_TOKEN_HMAC_KEY` is stored, the same scheme as `ApiToken`,
 * `ClinicianShareLink` and the registration invite (`invite-token.ts`). A
 * database leak therefore never yields a usable link, and the keyed hash makes
 * the unique-index lookup the timing-safe comparison: without the key nobody
 * can construct a preimage to probe the index byte by byte.
 *
 * The shape gate below is restated in `src/proxy.ts` (the `/claim/` edge
 * redirect), because that module must not pull in the Prisma client this one
 * does not need either. Keep the two in step.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import { hashToken } from "@/lib/auth/hmac";

/** Raw-token prefix — distinct from every other `hl*_` credential. */
export const HANDOVER_TOKEN_PREFIX = "hlp_";

const HANDOVER_TOKEN_SHAPE = /^hlp_[0-9a-f]{64}$/;

/** Generate a fresh raw handover token. 32 random bytes → 64 hex chars. */
export function generateHandoverToken(): string {
  return `${HANDOVER_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

/** Cheap shape gate before paying the HMAC and the database lookup. */
export function looksLikeHandoverToken(value: string): boolean {
  return HANDOVER_TOKEN_SHAPE.test(value);
}

/** The stored form of a raw token. */
export function hashHandoverToken(rawToken: string): string {
  return hashToken(rawToken);
}

/**
 * Compare a stored hash with the hash of a presented token in constant time.
 *
 * The row was found through the unique index on exactly this hash, so the two
 * are equal whenever this runs. It is kept anyway: it costs nothing, and it is
 * what keeps a later change to the lookup (a prefix scan, a cache) from
 * turning into a byte-by-byte comparison without anybody deciding that.
 */
export function handoverHashMatches(
  stored: string,
  presented: string,
): boolean {
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The link a Guardian hands over: `<origin>/claim/<hlp_token>`.
 *
 * Origin precedence matches `buildInviteUrl`: the operator-configured
 * `APP_URL` / `NEXT_PUBLIC_APP_URL` win over the request origin, which behind
 * a reverse proxy may be an internal hostname.
 */
export function buildHandoverUrl(rawToken: string, requestUrl: string): string {
  const candidates = [
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    requestUrl,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  let origin = "http://localhost:3000";
  for (const candidate of candidates) {
    try {
      origin = new URL(candidate).origin;
      break;
    } catch {
      // try the next candidate
    }
  }
  return `${origin}/claim/${encodeURIComponent(rawToken)}`;
}
