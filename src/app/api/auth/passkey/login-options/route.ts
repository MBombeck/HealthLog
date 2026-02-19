import { createAuthenticationOptions } from "@/lib/auth/passkey";
import { apiSuccess, apiError } from "@/lib/api-response";

export async function POST() {
  try {
    const { options, challengeId } = await createAuthenticationOptions();

    return apiSuccess({ options, challengeId });
  } catch (err) {
    console.error("Passkey login-options error:", err);
    return apiError("Konnte Passkey-Optionen nicht erzeugen", 500);
  }
}
