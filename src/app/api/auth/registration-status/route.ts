import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
    });

    return apiSuccess({
      registrationEnabled: settings?.registrationEnabled ?? true,
    });
  } catch (err) {
    console.error("Registration status error:", err);
    // Fail closed on backend errors.
    return apiSuccess({ registrationEnabled: false });
  }
}
