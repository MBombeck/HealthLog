/**
 * GET    /api/auth/me/sessions   — list the user's active web sessions.
 * DELETE /api/auth/me/sessions   — "sign out everywhere": revoke every OTHER
 *                                  session, device login, AI-assistant
 *                                  connection and token, and (unless
 *                                  `?keepShareLinks=1`) every clinician share
 *                                  link, keeping the caller's current
 *                                  credential. Closes #64. Also withdraws
 *                                  record-sharing invitations nobody has
 *                                  accepted yet, and lists the accepted
 *                                  grants it left standing (`grantsKept`).
 *
 * v1.23 — the user-facing session/device-management surface. Distinct from
 * `/api/auth/me/devices`, which lists APNs / Web-Push notification devices;
 * this lists the authenticated `Session` rows (one per browser login). The list
 * carries the masked IP + resolved coarse location + a coarse device label +
 * the sliding `lastActiveAt` — never the full IP, never a credential. The
 * caller's own row is flagged `isCurrent` so the UI can mark "this device".
 */
import { NextRequest } from "next/server";
import { headers } from "next/headers";
import {
  apiHandler,
  AUTH_ERROR_CODES,
  HttpError,
  requireAuth,
} from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { getClientIp } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";
import {
  destroyOtherSessions,
  sessionHandle,
  type CurrentCredential,
} from "@/lib/auth/session";
import { lookupIpLocation } from "@/lib/geo";
import { GRANT_PARTY_SELECT } from "@/lib/sharing/grant-view";
import { isGrantActive } from "@/lib/sharing/grant-access";
import { coarseDeviceLabel, maskIp } from "@/lib/auth/device-fingerprint";

export const dynamic = "force-dynamic";

export interface SessionDTO {
  id: string;
  device: string;
  ipMasked: string | null;
  location: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  isCurrent: boolean;
}

export const GET = apiHandler(async () => {
  const { user, session } = await requireAuth();

  const sessions = await prisma.session.findMany({
    where: { userId: user.id, expiresAt: { gt: new Date() } },
    orderBy: { lastActiveAt: { sort: "desc", nulls: "last" } },
    select: {
      id: true,
      ipAddress: true,
      userAgent: true,
      lastActiveAt: true,
      createdAt: true,
    },
  });

  // Resolve location once per distinct IP (the resolver caches internally, but
  // de-duping keeps the await count to the number of unique networks).
  const uniqueIps = Array.from(
    new Set(
      sessions.map((s) => s.ipAddress).filter((ip): ip is string => !!ip),
    ),
  );
  const locationByIp = new Map<string, string | null>();
  await Promise.all(
    uniqueIps.map(async (ip) => {
      try {
        locationByIp.set(ip, await lookupIpLocation(ip));
      } catch {
        locationByIp.set(ip, null);
      }
    }),
  );

  const result: SessionDTO[] = sessions.map((s) => ({
    id: sessionHandle(s.id),
    device: coarseDeviceLabel(s.userAgent),
    ipMasked: maskIp(s.ipAddress),
    location: s.ipAddress ? (locationByIp.get(s.ipAddress) ?? null) : null,
    lastActiveAt: s.lastActiveAt ? s.lastActiveAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    isCurrent: s.id === session.id,
  }));

  annotate({
    action: { name: "auth.session.list" },
    meta: { session_count: result.length },
  });

  return apiSuccess({ sessions: result });
});

export const DELETE = apiHandler(async (request: NextRequest) => {
  const auth = await requireAuth();
  const { user } = auth;

  // Name the caller by the transport it actually used. On the Bearer path
  // `session.id` is the `ApiToken` row id, not a session id; handing that to
  // the session-kind spared nothing, so the phone that pressed "sign out
  // everywhere" was the one signed out at its next rotation, while the other
  // devices kept their access tokens. The access-token kind spares the
  // caller's own device login by its `accessTokenHash`.
  const current: CurrentCredential =
    auth.authMethod === "bearer"
      ? {
          kind: "accessToken",
          accessTokenHash: hashToken(await presentedBearerToken()),
        }
      : { kind: "session", sessionId: auth.session.id };

  // "Everywhere" reaches every credential that works without signing in: AI
  // assistant connections, programmatic tokens and, unless the caller asks to
  // keep them, clinician share links. The default is to revoke, because the
  // person pressing this is often doing it after losing a device or a session,
  // and a share link made by whoever held it would otherwise keep working. A
  // client that sends nothing (the shipped app) gets the safe default.
  const keepShareLinks =
    new URL(request.url).searchParams.get("keepShareLinks") === "1";

  const {
    sessionsRevoked,
    accessTokensRevoked,
    connectorsRevoked,
    shareLinksRevoked,
    pendingInvitesRevoked,
  } = await destroyOtherSessions(user.id, current, {
    reach: "everything",
    keepShareLinks,
  });

  // The accepted grants this account gave, still live. Not ended here: each is
  // a person the owner chose, often a carer who still needs the record, and a
  // button labelled "sign out" must not quietly cut them off. They are listed
  // instead, so the person who just signed everything out can see who can
  // still read the record and end any of them with one click.
  const now = new Date();
  const grantsKept = (
    await prisma.accountGrant.findMany({
      where: {
        grantorId: user.id,
        acceptedAt: { not: null },
        revokedAt: null,
      },
      orderBy: { acceptedAt: "desc" },
      include: { grantee: { select: GRANT_PARTY_SELECT } },
    })
  )
    .filter((g) => isGrantActive(g, now))
    .map((g) => ({ id: g.id, account: g.grantee, access: g.access }));

  await auditLog("auth.session.revoke_others", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      sessionsRevoked,
      accessTokensRevoked,
      connectorsRevoked,
      shareLinksRevoked,
      pendingInvitesRevoked,
      grantsKept: grantsKept.length,
      keepShareLinks,
    },
  });

  annotate({
    action: { name: "auth.session.revoke_others" },
    meta: {
      sessions_revoked: sessionsRevoked,
      access_tokens_revoked: accessTokensRevoked,
      connectors_revoked: connectorsRevoked,
      share_links_revoked: shareLinksRevoked,
      pending_invites_revoked: pendingInvitesRevoked,
      grants_kept: grantsKept.length,
    },
  });

  return apiSuccess({
    sessionsRevoked,
    accessTokensRevoked,
    connectorsRevoked,
    shareLinksRevoked,
    pendingInvitesRevoked,
    grantsKept,
  });
});

/**
 * The raw Bearer token this request presented. `requireAuth` has already
 * accepted it, so a missing header here is a programming error, not a client
 * one; it is refused the same way rather than reasoned about.
 */
async function presentedBearerToken(): Promise<string> {
  const authHeader = (await headers()).get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HttpError(401, "Not authenticated", AUTH_ERROR_CODES.missing);
  }
  return authHeader.slice(7);
}
