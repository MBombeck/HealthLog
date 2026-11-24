import { cookies } from "next/headers";

import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { isSetupProof, SETUP_PROOF_COOKIE } from "@/lib/auth/setup-token";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  annotate({ action: { name: "auth.registration-status" } });
  try {
    const [settings, userCount] = await Promise.all([
      prisma.appSettings.findUnique({ where: { id: "singleton" } }),
      prisma.user.count(),
    ]);
    const setupRequired = userCount === 0;
    const proof = setupRequired
      ? (await cookies()).get(SETUP_PROOF_COOKIE)?.value
      : undefined;

    return apiSuccess({
      registrationEnabled: settings?.registrationEnabled ?? true,
      // Whether this server issues `Secure` session cookies. The login page
      // compares it with its own scheme before any credential is sent.
      sessionCookieSecure: shouldEmitSecureCookie(),
      // The instance has no account yet: the first one needs the setup token
      // (`@/lib/auth/setup-token`), and `setupProven` says this browser has
      // already shown it.
      setupRequired,
      setupProven: setupRequired && isSetupProof(proof),
    });
  } catch {
    // Fail closed on backend errors.
    return apiSuccess({
      registrationEnabled: false,
      sessionCookieSecure: shouldEmitSecureCookie(),
      setupRequired: false,
      setupProven: false,
    });
  }
});
