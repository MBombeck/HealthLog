/**
 * MCP OAuth connections — persistent, revocable, theft-detectable refresh
 * state (Phase 3 security fix, H2).
 *
 * The bridge AS mints stateless `hlrt_` refresh artifacts (see `artifacts.ts`).
 * On their own they reference no server row, so they could not be revoked and a
 * replayed (already-rotated) artifact was not treated as theft. This module is
 * the anchor the artifact lacked: one `McpOAuthConnection` row per connector
 * connection that requested `offline_access`.
 *
 *   - `createConnection` is called on the `authorization_code` exchange. It
 *     records the granted scope/audience and seeds `currentJti` with the jti of
 *     the first refresh artifact.
 *   - `rotateConnection` is called on every `refresh_token` exchange. It is the
 *     reuse-detection gate: a presented jti that is not the connection's
 *     `currentJti` is a replay of an already-rotated token → the connection is
 *     revoked (family revocation, mirroring `refresh-token.ts`) and the refresh
 *     fails. A revoked connection always fails. The happy path advances
 *     `currentJti` atomically (a `where currentJti = presented` guard so two
 *     concurrent refreshes cannot both win) and revokes the prior access tokens
 *     (L4).
 *   - `revokeConnection` is the kill switch the settings card flips: it stamps
 *     `revokedAt` and revokes every access token the connection ever issued, so
 *     a settings "revoke" terminates the whole refresh chain.
 *
 * The access tokens themselves stay ordinary `hlk_` `ApiToken` rows, linked
 * back through `ApiToken.mcpConnectionId`.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  refreshFamilyHardEnd,
  refreshTokenMaxLifetimeMs,
} from "@/lib/auth/session-lifetime";

type ConnectionDb = Pick<
  Prisma.TransactionClient,
  "mcpOAuthConnection" | "apiToken" | "$queryRaw"
>;

export interface ConnectionRotation {
  /** The connection id (`cid`) embedded in the refresh artifact. */
  connectionId: string;
  /** The jti presented in the refresh artifact being exchanged. */
  presentedJti: string;
  /** The jti to advance the connection to (the new refresh artifact's jti). */
  newJti: string;
  /** The client the refresh artifact claims — must match the stored client. */
  clientId: string;
  /** The user the refresh artifact claims — must match the stored owner. */
  userId: string;
}

export type RotationOutcome =
  /** `endsAt`: the connection's absolute end, which caps the successor. */
  | { ok: true; endsAt: Date }
  | {
      ok: false;
      reason:
        | "not_found"
        | "revoked"
        | "reuse_detected"
        | "client_mismatch"
        | "lifetime_ended";
    };

/** Create the connection anchor for a freshly-granted `offline_access` flow. */
export async function createConnection(args: {
  userId: string;
  clientId: string;
  clientName: string;
  scope: string;
  resource: string;
  jti: string;
}): Promise<string> {
  const row = await prisma.mcpOAuthConnection.create({
    data: {
      userId: args.userId,
      clientId: args.clientId,
      clientName: args.clientName,
      scope: args.scope,
      resource: args.resource,
      currentJti: args.jti,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Rotate a connection's refresh chain with reuse-detection.
 *
 * Returns `{ ok: true }` only when the presented jti is the connection's live
 * `currentJti` and the connection is not revoked; on success `currentJti` is
 * advanced to `newJti` and the connection's prior access tokens are revoked.
 * A presented jti that does not match `currentJti` is a replay and revokes the
 * connection before returning `reuse_detected`.
 */
export async function rotateConnection(
  args: ConnectionRotation,
  db: ConnectionDb = prisma,
): Promise<RotationOutcome> {
  // PostgreSQL has no Prisma model-level row-lock primitive. Inside the token
  // route's interactive transaction this serializes every decision for one
  // refresh family before we re-read its current state. The runtime guard keeps
  // lightweight unit doubles compatible while production clients always lock.
  if (typeof db.$queryRaw === "function") {
    await db.$queryRaw`
      SELECT id
      FROM mcp_oauth_connections
      WHERE id = ${args.connectionId}
      FOR UPDATE
    `;
  }

  const connection = await db.mcpOAuthConnection.findUnique({
    where: { id: args.connectionId },
    select: {
      id: true,
      userId: true,
      clientId: true,
      currentJti: true,
      createdAt: true,
      revokedAt: true,
    },
  });

  if (!connection || connection.userId !== args.userId) {
    return { ok: false, reason: "not_found" };
  }
  if (connection.clientId !== args.clientId) {
    return { ok: false, reason: "client_mismatch" };
  }
  if (connection.revokedAt) {
    return { ok: false, reason: "revoked" };
  }
  // A connection ends a fixed time after the consent that opened it
  // (REFRESH_TOKEN_MAX_LIFETIME_DAYS), however often it refreshes; the client
  // runs the consent again. Stamped revoked here so it leaves the settings
  // list and the cleanup job prunes it like any other ended connection.
  const endsAt = refreshFamilyHardEnd(connection.createdAt);
  if (endsAt.getTime() <= Date.now()) {
    await revokeConnectionRow(connection.id, db);
    return { ok: false, reason: "lifetime_ended" };
  }
  if (connection.currentJti !== args.presentedJti) {
    // Replay of an already-rotated refresh token — treat as theft and revoke
    // the whole connection (reuse-detection family revocation).
    await revokeConnectionRow(connection.id, db);
    return { ok: false, reason: "reuse_detected" };
  }

  // Advance the chain atomically: only the caller presenting the current jti
  // wins, so two concurrent refreshes cannot both rotate the same row.
  const advanced = await db.mcpOAuthConnection.updateMany({
    where: {
      id: connection.id,
      currentJti: args.presentedJti,
      revokedAt: null,
    },
    data: { currentJti: args.newJti, lastUsedAt: new Date() },
  });
  if (advanced.count === 0) {
    // A contender that loses the guarded advancement is a replay signal just
    // like a stale JTI observed after taking the row lock. Revoke the complete
    // family before returning; the surrounding transaction commits this deny.
    await revokeConnectionRow(connection.id, db);
    return { ok: false, reason: "reuse_detected" };
  }

  // Revoke the access tokens minted before this rotation so a leaked
  // 60-minute access token cannot outlive the refresh that spawned it.
  await db.apiToken.updateMany({
    where: { mcpConnectionId: connection.id, revoked: false },
    data: { revoked: true },
  });

  return { ok: true, endsAt };
}

/** Internal — stamp `revokedAt` and revoke every linked access token. */
async function revokeConnectionRow(
  connectionId: string,
  db: Pick<ConnectionDb, "mcpOAuthConnection" | "apiToken"> = prisma,
): Promise<void> {
  await db.mcpOAuthConnection.updateMany({
    where: { id: connectionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await db.apiToken.updateMany({
    where: { mcpConnectionId: connectionId, revoked: false },
    data: { revoked: true },
  });
}

/**
 * Revoke a connection on behalf of its owner (settings "revoke"). Ownership is
 * enforced so a connection id alone cannot revoke another user's connection.
 * Returns true when a live connection owned by the user was revoked.
 */
export async function revokeConnectionForUser(
  userId: string,
  connectionId: string,
): Promise<boolean> {
  const connection = await prisma.mcpOAuthConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!connection || connection.userId !== userId) return false;
  await revokeConnectionRow(connection.id);
  return true;
}

export interface ConnectionSummary {
  id: string;
  clientName: string;
  scope: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * The user's live connector connections for the settings list: not revoked,
 * and not past the absolute lifetime counted from their consent (one that
 * ended without refreshing since is stamped revoked only on its next try).
 */
export async function listConnectionsForUser(
  userId: string,
): Promise<ConnectionSummary[]> {
  return prisma.mcpOAuthConnection.findMany({
    where: {
      userId,
      revokedAt: null,
      createdAt: { gt: new Date(Date.now() - refreshTokenMaxLifetimeMs()) },
    },
    select: {
      id: true,
      clientName: true,
      scope: true,
      createdAt: true,
      lastUsedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}
