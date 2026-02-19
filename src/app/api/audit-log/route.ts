import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { NextRequest } from "next/server";

/**
 * Get audit log entries for the current user.
 * Query params: limit (default 50, max 200), offset (default 0)
 */
export async function GET(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50"), 200);
  const offset = parseInt(searchParams.get("offset") ?? "0");

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where: { userId: sessionData.user.id },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        action: true,
        ipAddress: true,
        details: true,
        createdAt: true,
      },
    }),
    prisma.auditLog.count({
      where: { userId: sessionData.user.id },
    }),
  ]);

  return apiSuccess({ entries, meta: { total, limit, offset } });
}
