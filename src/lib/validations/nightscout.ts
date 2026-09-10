import { z } from "zod/v4";
import {
  canonicalOrigin,
  evaluateOriginGrant,
  INVALID_ORIGIN,
  parsePrivateOrigins,
  PRIVATE_ORIGIN_NOT_APPROVED_CODE,
  type OriginReason,
  type OriginVerdict,
} from "@/lib/private-origin-policy";

export const NIGHTSCOUT_PRIVATE_ORIGIN_REASON =
  PRIVATE_ORIGIN_NOT_APPROVED_CODE;
export const NIGHTSCOUT_INVALID_ORIGIN_REASON = INVALID_ORIGIN;

/**
 * Thrown when `NIGHTSCOUT_PRIVATE_ORIGINS` holds an entry that is not a
 * grant. The message names the entry (scheme and host only) and the reason,
 * so the sync ledger and the connect form show the operator what to edit
 * instead of a bare "invalid entry". Loopback and `localhost` entries
 * became invalid with the shared address floor (#947); a host-networking
 * deployment lists the LAN address instead.
 */
export class NightscoutOriginConfigError extends Error {
  constructor(redactedEntry: string, reason: string) {
    super(
      `Invalid NIGHTSCOUT_PRIVATE_ORIGINS entry "${redactedEntry}": ${reason}`,
    );
    this.name = "NightscoutOriginConfigError";
  }
}

export type NightscoutOriginReason = OriginReason;

export type NightscoutOriginVerdict = OriginVerdict;

/**
 * Parse the server-only comma-separated exact-origin allowlist.
 *
 * The grammar lives in `@/lib/private-origin-policy` and is shared with
 * `NOTIFICATION_PRIVATE_ORIGINS`. Invalid non-empty entries fail
 * startup/call-site evaluation loudly rather than being skipped: partial
 * acceptance makes an operator believe a private integration is protected
 * while silently changing which origin is trusted.
 */
export function parseNightscoutPrivateOrigins(
  raw: string | undefined,
): ReadonlySet<string> {
  return parsePrivateOrigins(raw, (redactedEntry, reason) => {
    throw new NightscoutOriginConfigError(redactedEntry, reason);
  });
}

/**
 * Resolve one user-supplied Nightscout base URL against server policy.
 *
 * A Nightscout base URL is itself a bare origin, so the strict grant grammar
 * applies to the input as well: a path, query, fragment or credential part
 * is `invalid_origin`, not merely unapproved.
 */
export function evaluateNightscoutOrigin(
  value: string,
  privateOrigins: ReadonlySet<string>,
): NightscoutOriginVerdict {
  const origin = canonicalOrigin(value);
  if (!origin) {
    return {
      allowed: false,
      canonicalOrigin: null,
      privateOriginApproved: false,
      reasonCode: NIGHTSCOUT_INVALID_ORIGIN_REASON,
    };
  }
  return evaluateOriginGrant(origin, privateOrigins);
}

export function configuredNightscoutPrivateOrigins(): ReadonlySet<string> {
  return parseNightscoutPrivateOrigins(process.env.NIGHTSCOUT_PRIVATE_ORIGINS);
}

/**
 * Per-user Nightscout connection input (v1.17.0). The self-hoster points
 * HealthLog at their own Nightscout instance (Railway / Heroku / Fly / a LAN
 * box) and pastes the instance's API token. Both fields are stored encrypted
 * on `User` (`nightscoutUrlEncrypted` / `nightscoutTokenEncrypted`); the
 * legacy private-host boolean is accepted for compatibility but never grants
 * network authority.
 *
 * The URL is validated to be parseable here. Exact server policy is evaluated
 * by the route and again by the client so the request body cannot confer
 * private-network authority.
 */
export const nightscoutConnectSchema = z.object({
  // Trimmed: a trailing space / newline from a copy button reaches the
  // instance verbatim and produces an opaque DNS failure.
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((value) => {
      try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    }, "Must be a valid http(s) URL"),
  // Nightscout API tokens are opaque strings (a role-scoped access token or
  // the raw `API_SECRET`). Optional: a fully public instance with
  // `AUTH_DEFAULT_ROLES=readable` serves SGV entries without a token.
  token: z.string().trim().max(512).optional().default(""),
  // Deprecated request compatibility only. This value is deliberately
  // ignored by the route and client.
  allowPrivateHost: z.boolean().optional().default(false),
});

export type NightscoutConnectInput = z.infer<typeof nightscoutConnectSchema>;
