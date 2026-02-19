import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Revoke an API token.
 */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const token = await prisma.apiToken.findUnique({ where: { id } });

  if (!token || token.userId !== sessionData.user.id) {
    return apiError("Token nicht gefunden", 404);
  }

  await prisma.apiToken.update({
    where: { id },
    data: { revoked: true },
  });

  return apiSuccess({ revoked: true });
}
