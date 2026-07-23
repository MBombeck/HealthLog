/**
 * GET    /api/auth/me/sessions   — list the user's active web sessions.
 * DELETE /api/auth/me/sessions   — "sign out everywhere": revoke every OTHER
 *                                  session (and native refresh tokens), keeping
 *                                  the caller's current session. Closes #64.
 *
 * v1.23 — the user-facing session/device-management surface. Distinct from
 * `/api/auth/me/devices`, which lists APNs / Web-Push notification devices;
 * this lists the authenticated `Session` rows (one per browser login). The list
 * carries the masked IP + resolved coarse location + a coarse device label +
 * the sliding `lastActiveAt` — never the full IP, never a credential. The
 * caller's own row is flagged `isCurrent` so the UI can mark "this device".
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { getClientIp } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { destroyOtherSessions, sessionHandle } from "@/lib/auth/session";
import { lookupIpLocation } from "@/lib/geo";
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
  const { user, session } = await requireAuth();

  const { sessionsRevoked } = await destroyOtherSessions(user.id, {
    kind: "session",
    sessionId: session.id,
  });

  await auditLog("auth.session.revoke_others", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { sessionsRevoked },
  });

  annotate({
    action: { name: "auth.session.revoke_others" },
    meta: { sessions_revoked: sessionsRevoked },
  });

  return apiSuccess({ sessionsRevoked });
});
