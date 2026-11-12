import { ApiError } from "./api-fetch";
import { defaultErrorCodeForStatus } from "./default-error-codes";
import { translateCode } from "@/lib/i18n/translate-code";

type Translate = (key: string) => string;

/**
 * Resolve an API envelope's stable error code through the locale catalog.
 * A refusal without a code of its own (a proxy's 429, an answer without the
 * envelope) is read by its status, the way the server labels one, so an
 * ended session or a rate limit is named as such. Unknown codes, network
 * failures, and non-API errors deliberately collapse to the caller's safe
 * domain fallback; server prose is never shown.
 */
export function localizedApiError(
  error: unknown,
  t: Translate,
  fallbackKey: string,
): string {
  const errorCode = !(error instanceof ApiError)
    ? null
    : typeof error.meta?.errorCode === "string"
      ? error.meta.errorCode
      : defaultErrorCodeForStatus(error.status);
  return translateCode(t, "apiErrors", errorCode, fallbackKey);
}

/**
 * A refused sign-in step (password, second factor, passkey). These refusals
 * mostly carry only their status's generic code, and here a 401 means a
 * wrong password or code, not an ended session, and a 429 a lockout of
 * several minutes. A code of the step's own keeps its sentence.
 */
export function localizedSignInError(
  error: unknown,
  t: Translate,
  fallbackKey: string,
): string {
  if (error instanceof ApiError) {
    const code = error.meta?.errorCode;
    const generic = typeof code !== "string" || code.startsWith("http.");
    if (generic && error.status === 429) return t("auth.signInRateLimited");
    if (generic && error.status === 401) return t(fallbackKey);
  }
  return localizedApiError(error, t, fallbackKey);
}
