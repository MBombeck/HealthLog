import { ApiError } from "./api-fetch";

type Translate = (key: string) => string;

/**
 * Resolve an API envelope's stable error code through the locale catalog.
 * Missing/unknown codes, network failures, and non-API errors deliberately
 * collapse to the caller's safe domain fallback; server prose is never shown.
 */
export function localizedApiError(
  error: unknown,
  t: Translate,
  fallbackKey: string,
): string {
  if (error instanceof ApiError) {
    const errorCode = error.meta?.errorCode;
    if (typeof errorCode === "string") {
      const key = `apiErrors.${errorCode}`;
      const translated = t(key);
      if (translated !== key) return translated;
    }
  }

  return t(fallbackKey);
}
