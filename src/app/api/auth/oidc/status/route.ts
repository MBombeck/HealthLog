import { apiSuccess } from "@/lib/api-response";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { getOidcConfig, isOidcOnly } from "@/lib/auth/oidc";
import {
  NATIVE_OIDC_RETURN_PATH,
  nativeHttpsReturnOrigin,
} from "@/lib/auth/native-return";

export const dynamic = "force-dynamic";

/** Public — the login page reads this pre-session to decide whether to
 * render the SSO button and whether to hide password/passkey login. Pure
 * env reads; nothing here can throw. */
export const GET = apiHandler(async () => {
  annotate({ action: { name: "auth.oidc.status" } });
  const config = getOidcConfig();
  return apiSuccess({
    enabled: config !== null,
    buttonLabel: config?.buttonLabel ?? null,
    only: isOidcOnly(),
    // #163 B2 — the native sign-in's opt-in https return. Announced only when
    // SSO is on and the instance is served over https; an app build with an
    // associated domain for this host may then start with `return=https`.
    nativeReturnPath:
      config !== null && nativeHttpsReturnOrigin() !== null
        ? NATIVE_OIDC_RETURN_PATH
        : null,
  });
});
