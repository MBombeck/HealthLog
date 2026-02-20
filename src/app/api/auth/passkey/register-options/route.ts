import { createRegistrationOptions } from "@/lib/auth/passkey";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";

export async function POST() {
  try {
    const sessionData = await getSession();
    if (!sessionData) {
      return apiError("Nicht angemeldet", 401);
    }

    const { options, challengeId } = await createRegistrationOptions(
      sessionData.user.id,
      sessionData.user.email ?? sessionData.user.username,
    );

    return apiSuccess({ options, challengeId });
  } catch (err) {
    console.error("Passkey register-options error:", err);
    return apiError("Konnte Passkey-Optionen nicht erzeugen", 500);
  }
}
