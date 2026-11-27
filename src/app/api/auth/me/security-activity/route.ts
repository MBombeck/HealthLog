/**
 * GET /api/auth/me/security-activity
 *
 * v1.23 — the SHARED user-facing security-activity feed. Returns the caller's
 * recent account-security audit events (logins, MFA, password change, token /
 * session revocations, exports, deletions) with timestamp + resolved location
 * + MASKED IP. The IP is never returned in full and no event detail body is
 * surfaced — only the action name, time, and coarse geo. Consumed by the
 * account-security surface and the privacy dashboard.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireSelfAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { securityActivityWhere } from "@/lib/auth/security-activity";
import { maskIp } from "@/lib/auth/device-fingerprint";
import { apiListSuccess } from "@/lib/api/list-cap";
import { listPage, parseListQuery } from "@/lib/http/list-query";
import { returnAllZodIssues } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface SecurityActivityDTO {
  action: string;
  createdAt: string;
  location: string | null;
  ipMasked: string | null;
  carrier: string | null;
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireSelfAuth();

  // The shared list query: an out-of-range limit is a 422 naming it, as on
  // every other list, rather than a silent clamp to something not asked for.
  const query = parseListQuery(request.nextUrl.searchParams, {
    defaultLimit: DEFAULT_LIMIT,
    maxLimit: MAX_LIMIT,
  });
  if (!query.success) {
    return returnAllZodIssues(query.error, 422, {
      errorCode: "security_activity.invalid",
    });
  }
  const { limit } = query.data;

  const { rows, cap } = await listPage(limit, (take) =>
    prisma.auditLog.findMany({
      where: securityActivityWhere(user.id),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: {
        action: true,
        createdAt: true,
        location: true,
        ipAddress: true,
        carrier: true,
      },
    }),
  );

  const events: SecurityActivityDTO[] = rows.map((r) => ({
    action: r.action,
    createdAt: r.createdAt.toISOString(),
    location: r.location ?? null,
    ipMasked: maskIp(r.ipAddress),
    carrier: r.carrier ?? null,
  }));

  annotate({
    action: { name: "auth.security_activity.list" },
    meta: { event_count: events.length },
  });

  return apiListSuccess({ events }, cap);
});
