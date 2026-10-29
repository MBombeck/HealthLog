"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchMe } from "@/hooks/use-auth";
import { persistLocaleToServer, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

/**
 * Keeps `User.locale` in step with the language on screen, for a signed-in
 * account only, so the proactive Coach nudge and the other cookie-blind
 * background paths write in the language the person reads.
 *
 * It watches the account payload without fetching it (`enabled: false`): the
 * shell already reads `/api/auth/me` on every signed-in page, and a signed-out
 * page has no account to write to. Fetching here would trade the refused
 * locale PUT for a refused account read on every signed-out load. Same key
 * and same fetcher as `useAuth`, so the cache entry is shared, not shadowed.
 *
 * Fires when an account appears (right after signing in, carrying the choice
 * made on the sign-in page) and on every switch; `persistLocaleToServer`
 * skips a value this tab already wrote for this account.
 */
export function LocaleServerSyncBridge() {
  const { locale } = useTranslations();
  const { data: account } = useQuery({
    queryKey: queryKeys.authMe(),
    queryFn: fetchMe,
    enabled: false,
  });
  const accountId = account?.id ?? null;

  useEffect(() => {
    if (accountId) persistLocaleToServer(locale, accountId);
  }, [locale, accountId]);

  return null;
}
