"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

export interface RegistrationStatus {
  registrationEnabled: boolean;
  sessionCookieSecure: boolean;
  /** The instance has no account yet; the first one needs the setup token. */
  setupRequired: boolean;
  /** This browser has proven the setup token already. */
  setupProven: boolean;
}

/**
 * `GET /api/auth/registration-status`, the one reader of that key: the
 * sign-in and the registration page share the cache entry, so both read it
 * through the same function and shape.
 */
export function useRegistrationStatus() {
  return useQuery({
    queryKey: queryKeys.authRegistrationStatus(),
    queryFn: async (): Promise<RegistrationStatus> => {
      try {
        const data = await apiGet<Partial<RegistrationStatus>>(
          "/api/auth/registration-status",
          { cache: "no-store" },
        );
        return {
          registrationEnabled: Boolean(data?.registrationEnabled ?? true),
          sessionCookieSecure: data?.sessionCookieSecure === true,
          setupRequired: data?.setupRequired === true,
          setupProven: data?.setupProven === true,
        };
      } catch {
        // Fail open for the registration link, as the page always did; no
        // transport gate and no setup step without the server's word.
        return {
          registrationEnabled: true,
          sessionCookieSecure: false,
          setupRequired: false,
          setupProven: false,
        };
      }
    },
    staleTime: 60 * 1000,
  });
}
