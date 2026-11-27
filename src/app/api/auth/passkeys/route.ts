import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireSelfAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireSelfAuth();

  const passkeys = await prisma.passkey.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      name: true,
      credentialDeviceType: true,
      credentialBackedUp: true,
      createdAt: true,
      lastUsedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  annotate({ action: { name: "auth.passkeys.list" } });

  return apiSuccess(passkeys);
});
