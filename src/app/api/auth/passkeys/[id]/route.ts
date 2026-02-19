import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;

  const passkey = await prisma.passkey.findUnique({
    where: { id },
  });

  if (!passkey || passkey.userId !== sessionData.user.id) {
    return apiError("Passkey nicht gefunden", 404);
  }

  // Check: at least 1 auth method must remain
  const passkeyCount = await prisma.passkey.count({
    where: { userId: sessionData.user.id },
  });
  const hasPassword = !!sessionData.user.passwordHash;

  if (passkeyCount <= 1 && !hasPassword) {
    return apiError(
      "Kann nicht gelöscht werden — es muss mindestens eine Anmeldemethode bestehen bleiben",
      400,
    );
  }

  await prisma.passkey.delete({ where: { id } });

  await auditLog("auth.passkey.delete", {
    userId: sessionData.user.id,
    ipAddress: getClientIp(request),
    details: { passkeyId: id, passkeyName: passkey.name },
  });

  return apiSuccess({ success: true });
}
