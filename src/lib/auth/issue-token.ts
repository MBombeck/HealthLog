/**
 * Helper for issuing an `ApiToken` for a user — currently used by the
 * native-client auto-login flow (login + passkey login-verify) so the iOS
 * app can talk to bearer-protected routes without juggling the session
 * cookie. The raw `hlk_<hex>` value is returned exactly once.
 */
import { randomBytes } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";

export interface IssuedToken {
  token: string;
  expiresAt: Date;
  tokenId: string;
  name: string;
}

export interface IssueTokenOptions {
  userId: string;
  /** Token row name (also surfaced to the user under /api/tokens). */
  name: string;
  /** Default permissions. `["*"]` = unrestricted (matches cookie scope). */
  permissions?: string[];
  /** Lifetime in days. */
  expiresInDays?: number;
  /**
   * Lifetime in minutes. When set it WINS over `expiresInDays` — used for the
   * short-lived OAuth access tokens the MCP bridge mints (the refresh token
   * carries continuity). Ignored when `expiresInDays` alone is supplied.
   */
  expiresInMinutes?: number;
  /**
   * Links this access token to an MCP OAuth connection (H2). Set only by the
   * `/api/mcp/oauth` bridge so a connection revoke can kill every access row it
   * issued and the connector token list can exclude the transient access rows.
   */
  mcpConnectionId?: string;
  /** A measurement token's Apple Health write-back (#1272). Off by default. */
  mirrorToAppleHealth?: boolean;
}

/**
 * Generate a new `hlk_<64 hex>` token, store its hash, and return the raw
 * value to the caller. The plaintext token is never persisted and must
 * never be logged.
 */
export async function issueApiToken(
  opts: IssueTokenOptions,
  db: Pick<Prisma.TransactionClient, "apiToken"> = prisma,
): Promise<IssuedToken> {
  const rawToken = `hlk_${randomBytes(32).toString("hex")}`;
  const tokenHashValue = hashToken(rawToken);
  const expiresAt =
    opts.expiresInMinutes !== undefined
      ? new Date(Date.now() + opts.expiresInMinutes * 60 * 1000)
      : new Date(Date.now() + (opts.expiresInDays ?? 90) * 24 * 60 * 60 * 1000);

  const created = await db.apiToken.create({
    data: {
      userId: opts.userId,
      name: opts.name,
      tokenHash: tokenHashValue,
      permissions: opts.permissions ?? ["*"],
      expiresAt,
      ...(opts.mcpConnectionId
        ? { mcpConnectionId: opts.mcpConnectionId }
        : {}),
      ...(opts.mirrorToAppleHealth === true
        ? { mirrorToAppleHealth: true }
        : {}),
    },
    select: { id: true },
  });

  return {
    token: rawToken,
    expiresAt,
    tokenId: created.id,
    name: opts.name,
  };
}

/**
 * Detect whether the request is from a native client and should receive a
 * bearer token in the login response. Two opt-in signals:
 *   - `X-Client-Type: native`
 *   - `User-Agent: HealthLog-iOS/...`
 */
export function isNativeClientRequest(headers: Headers): boolean {
  const xClient = headers.get("x-client-type");
  if (xClient && xClient.toLowerCase() === "native") return true;

  const ua = headers.get("user-agent") ?? "";
  if (ua.startsWith("HealthLog-iOS")) return true;

  return false;
}
