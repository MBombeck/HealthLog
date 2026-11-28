"use client";

/**
 * A measurement token's one setting (#1272): whether the HealthLog app on the
 * iPhone writes the readings that token sent into Apple Health.
 *
 * The readings keep their EXTERNAL source either way; the server resolves
 * the decision per reading and the app follows it. The API settings set it
 * from a token's row menu and from the new-token flow; this module holds the
 * write and the notice about readings that belong to no token.
 */
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

/** The scope a measurement token carries, and nothing else. */
const MEASUREMENTS_WRITE = "measurements:write";

export function isMeasurementTokenInfo(permissions: readonly string[]) {
  return permissions.length === 1 && permissions[0] === MEASUREMENTS_WRITE;
}

/** `PATCH /api/tokens/{id}`: the one write behind the switch. */
export function patchTokenMirror(
  tokenId: string,
  mirrorToAppleHealth: boolean,
) {
  return apiPatch<{ id: string; mirrorToAppleHealth: boolean }>(
    `/api/tokens/${encodeURIComponent(tokenId)}`,
    { mirrorToAppleHealth },
  );
}

/**
 * Shown only when the account holds EXTERNAL readings no token reaches: sent
 * before readings were linked to their token, by an account that held more
 * than one, so no setting here can put them into Apple Health.
 */
export function UnattributedReadingsNotice({
  className,
}: {
  className?: string;
}) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const { data } = useQuery({
    queryKey: queryKeys.measurementTokenSummary(),
    queryFn: () =>
      apiGet<{ unattributedReadings: number }>("/api/tokens/measurements"),
    enabled: isAuthenticated,
  });
  if (!data || !(data.unattributedReadings > 0)) return null;
  return (
    <p
      className={cn("text-sm", className)}
      data-slot="apple-health-unattributed-notice"
    >
      {t("settings.measurementsToken.appleHealth.unattributed")}
    </p>
  );
}
