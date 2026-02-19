import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  return apiSuccess({
    registrationEnabled: settings?.registrationEnabled ?? true,
  });
}

export async function PUT(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return apiError("Nicht berechtigt", 403);

  const body = await request.json();
  const { registrationEnabled } = body as { registrationEnabled?: boolean };

  if (typeof registrationEnabled !== "boolean") {
    return apiError("registrationEnabled muss boolean sein", 422);
  }

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: { registrationEnabled },
    create: { id: "singleton", registrationEnabled },
  });

  await auditLog("admin.settings.update", {
    userId: admin.id,
    ipAddress: getClientIp(request),
    details: { registrationEnabled },
  });

  return apiSuccess({
    registrationEnabled: settings.registrationEnabled,
  });
}
