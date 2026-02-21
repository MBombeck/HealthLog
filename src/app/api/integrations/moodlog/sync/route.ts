import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { syncMoodLogEntries } from "@/lib/moodlog/sync";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  // Check global toggle
  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { moodLogGlobal: true },
  });
  if (appSettings && !appSettings.moodLogGlobal) {
    return apiError("moodLog-Integration ist deaktiviert", 403);
  }

  let fullSync = false;
  try {
    const body = await request.json();
    fullSync = body?.fullSync === true;
  } catch {
    // No body or invalid JSON — use defaults
  }

  try {
    const imported = await syncMoodLogEntries(sessionData.user.id, { fullSync });
    return apiSuccess({ imported });
  } catch (err) {
    console.error("[moodlog] Manual sync failed:", err);
    return apiError("Sync fehlgeschlagen", 500);
  }
}
