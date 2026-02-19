import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import { withingsCredentialsSchema } from "@/lib/validations/withings";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * Check if user has Withings credentials stored.
 */
export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const user = await prisma.user.findUnique({
    where: { id: sessionData.user.id },
    select: {
      withingsClientIdEncrypted: true,
      withingsClientSecretEncrypted: true,
    },
  });

  return apiSuccess({
    hasCredentials:
      !!user?.withingsClientIdEncrypted &&
      !!user?.withingsClientSecretEncrypted,
  });
}

/**
 * Save Withings API credentials (encrypted).
 */
export async function PUT(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  try {
    const body = await request.json();
    const result = z.safeParse(withingsCredentialsSchema, body);
    if (!result.success) {
      return apiError("Client-ID und Client-Secret sind erforderlich", 422);
    }

    await prisma.user.update({
      where: { id: sessionData.user.id },
      data: {
        withingsClientIdEncrypted: encrypt(result.data.clientId),
        withingsClientSecretEncrypted: encrypt(result.data.clientSecret),
      },
    });

    return apiSuccess({ updated: true });
  } catch (err) {
    console.error("Withings credentials save error:", err);
    if (err instanceof Error && err.message.includes("ENCRYPTION_KEY")) {
      return apiError(
        "Server-Konfiguration fehlerhaft: ENCRYPTION_KEY fehlt.",
        500,
      );
    }
    return apiError("Fehler beim Speichern der Withings-Zugangsdaten", 500);
  }
}

/**
 * Delete Withings credentials and disconnect.
 */
export async function DELETE() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  // Remove connection first
  await prisma.withingsConnection
    .delete({ where: { userId: sessionData.user.id } })
    .catch(() => {});

  // Remove credentials
  await prisma.user.update({
    where: { id: sessionData.user.id },
    data: {
      withingsClientIdEncrypted: null,
      withingsClientSecretEncrypted: null,
    },
  });

  return apiSuccess({ deleted: true });
}
