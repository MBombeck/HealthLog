import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Admin endpoint: list all auth-related audit log entries across all users.
 * Supports filtering by action prefix and pagination.
 */
export async function GET(request: NextRequest) {
  const session = await requireAdmin();
  if (!session) return apiError("Nicht berechtigt", 403);

  const { searchParams } = new URL(request.url);
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get("limit") ?? "100", 10) || 100),
    500,
  );
  const offset = Math.max(
    0,
    parseInt(searchParams.get("offset") ?? "0", 10) || 0,
  );
  const filter = searchParams.get("filter") ?? "auth"; // "auth" | "all"

  const where =
    filter === "auth" ? { action: { startsWith: "auth." } } : undefined;

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        action: true,
        ipAddress: true,
        location: true,
        details: true,
        createdAt: true,
        user: {
          select: { id: true, username: true },
        },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return apiSuccess({ entries, meta: { total, limit, offset } });
}
