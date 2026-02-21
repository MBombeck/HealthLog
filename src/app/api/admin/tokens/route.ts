import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  const tokens = await prisma.apiToken.findMany({
    select: {
      id: true,
      name: true,
      permissions: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
      revoked: true,
      user: {
        select: { id: true, username: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return apiSuccess(tokens);
}
