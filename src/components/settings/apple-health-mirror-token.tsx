"use client";

/**
 * A measurement token's one setting (#1272): whether the HealthLog app on the
 * iPhone writes the readings that token sent into Apple Health.
 *
 * The readings keep their EXTERNAL source either way; the server resolves
 * the decision per reading and the app follows it. Three pieces, used by the
 * API settings: the switch on a measurement token's row, the opt-in on the
 * mint form, and the notice about readings that belong to no token.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

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

/** The switch on a measurement token's row; nothing on any other token. */
export function AppleHealthMirrorSwitch({
  token,
}: {
  token: {
    id: string;
    name: string;
    permissions: string[];
    mirrorToAppleHealth: boolean;
  };
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  if (!isMeasurementTokenInfo(token.permissions)) return null;

  async function handleChange(next: boolean) {
    setSaving(true);
    try {
      await patchTokenMirror(token.id, next);
      await queryClient.invalidateQueries({ queryKey: queryKeys.tokens() });
    } catch (failure) {
      showErrorToast(t("settings.measurementsToken.appleHealth.updateFailed"), {
        cause: failure,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <label
      className="flex min-h-11 items-center gap-2 sm:min-h-9"
      data-slot="apple-health-mirror-switch"
    >
      <Switch
        checked={token.mirrorToAppleHealth}
        onCheckedChange={(next) => void handleChange(next)}
        disabled={saving}
        aria-label={t("settings.measurementsToken.appleHealth.toggleAria", {
          name: token.name,
        })}
      />
      <span className="text-xs">
        {t("settings.measurementsToken.appleHealth.label")}
      </span>
    </label>
  );
}

/** The opt-in on the measurement mint form. Off unless the person ticks it. */
export function AppleHealthMirrorOptIn({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  const { t } = useTranslations();
  return (
    <label className="flex items-start gap-2 text-sm">
      <Checkbox
        data-slot="apple-health-mirror-opt-in"
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="mt-0.5"
      />
      <span>
        {t("settings.measurementsToken.appleHealth.label")}
        <span className="text-muted-foreground block text-xs">
          {t("settings.measurementsToken.appleHealth.createHint")}
        </span>
      </span>
    </label>
  );
}

/**
 * Shown only when the account holds EXTERNAL readings no token reaches: sent
 * before readings were linked to their token, by an account that held more
 * than one, so no setting here can put them into Apple Health.
 */
export function UnattributedReadingsNotice() {
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
    <p className="text-sm" data-slot="apple-health-unattributed-notice">
      {t("settings.measurementsToken.appleHealth.unattributed")}
    </p>
  );
}
