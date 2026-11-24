"use client";

import { NativeSelect } from "@/components/ui/native-select";
import { useTranslations } from "@/lib/i18n/context";
import {
  SettingsToggle,
  type AdminSettings,
  type useUpdateSettings,
} from "./_shared";

/** The grace periods an admin can pick, in days (0 = none). */
const GRACE_DAY_CHOICES = [0, 7, 14, 30, 60, 90];

/**
 * The second-factor policies (`@/lib/auth/mfa-enrollment`): for admin
 * accounts (on by default), for every account, and the grace period an
 * account a policy newly covers gets before it is confined to enrolment.
 * The server answers in `docs/ops/mfa-enforcement.md`.
 */
export function MfaPolicySettings({
  settings,
  update,
}: {
  settings: AdminSettings | undefined;
  update: ReturnType<typeof useUpdateSettings>;
}) {
  const { t } = useTranslations();
  const graceDays = settings?.mfaGraceDays ?? 14;
  const choices = GRACE_DAY_CHOICES.includes(graceDays)
    ? GRACE_DAY_CHOICES
    : [...GRACE_DAY_CHOICES, graceDays].sort((a, b) => a - b);

  return (
    <>
      <SettingsToggle
        label={t("admin.mfaRequiredForAdmins")}
        description={t("admin.mfaRequiredForAdminsDescription")}
        checked={settings?.mfaRequiredForAdmins ?? true}
        onCheckedChange={(checked) =>
          update.mutate({ mfaRequiredForAdmins: checked })
        }
        disabled={update.isPending}
      />
      <SettingsToggle
        label={t("admin.mfaRequired")}
        description={t("admin.mfaRequiredDescription")}
        checked={settings?.mfaRequired ?? false}
        onCheckedChange={(checked) => update.mutate({ mfaRequired: checked })}
        disabled={update.isPending}
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("admin.mfaGraceDays")}</p>
          <p className="text-muted-foreground text-xs">
            {t("admin.mfaGraceDaysDescription")}
          </p>
        </div>
        <NativeSelect
          aria-label={t("admin.mfaGraceDays")}
          value={String(graceDays)}
          onChange={(e) =>
            update.mutate({ mfaGraceDays: Number(e.target.value) })
          }
          disabled={update.isPending}
          className="self-end sm:w-auto sm:self-auto"
        >
          {choices.map((days) => (
            <option key={days} value={days}>
              {days === 0
                ? t("admin.mfaGraceDaysNone")
                : t("admin.mfaGraceDaysOption", { count: days })}
            </option>
          ))}
        </NativeSelect>
      </div>
    </>
  );
}
