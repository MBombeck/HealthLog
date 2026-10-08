"use client";

import { localeLabels, locales } from "@/lib/i18n/config";
import { useMemo, useState } from "react";
import { Settings } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { SettingsToggle, useAdminSettings, useUpdateSettings } from "./_shared";
import { listSupportedTimezones } from "@/lib/tz/format";

// Document-vault limits: bytes on the wire, MB / GB in the UI. The bounds
// mirror the server-side schema (per-file cap hard-clamped to 100 MiB —
// single-shot GCM + bounded in-memory reads are load-bearing past that).
const MIB = 1_048_576;
const GIB = 1_073_741_824;
const MAX_FILE_MB_MIN = 1;
const MAX_FILE_MB_MAX = 100;
const QUOTA_GB_MIN = 0.1;
const QUOTA_GB_MAX = 1024;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// v1.4.27 MB7 / CF-52 — the in-file `NATIVE_SELECT_CLASS` constant
// retired; the shared `<NativeSelect>` primitive owns the visual
// contract now. The admin copy previously diverged on the
// `focus-visible:ring-[3px]` weight; the shared primitive pins
// `focus-visible:ring-2` so admin selects match the rest of the form
// surface.

export function GeneralSettingsSection() {
  const { t } = useTranslations();
  const { data: settings } = useAdminSettings();
  const updateSettings = useUpdateSettings();
  // Memoised — `listSupportedTimezones()` calls the engine's
  // `Intl.supportedValuesOf('timeZone')` which returns ~400 strings.
  const zones = useMemo(() => listSupportedTimezones(), []);

  const currentDefaultTz = settings?.defaultUserTimezone ?? "";

  // Draft-while-editing pattern for the two limit inputs: null = not
  // editing (show the stored value), string = the in-progress draft.
  // Commit clamps to the schema bounds and converts to bytes.
  const [maxFileDraft, setMaxFileDraft] = useState<string | null>(null);
  const [quotaDraft, setQuotaDraft] = useState<string | null>(null);

  const storedMaxFileMb =
    settings?.documentMaxFileBytes != null
      ? String(Math.round(settings.documentMaxFileBytes / MIB))
      : "";
  const storedQuotaGb =
    settings?.documentQuotaBytes != null
      ? String(Math.round((settings.documentQuotaBytes / GIB) * 10) / 10)
      : "";

  const commitMaxFile = () => {
    if (maxFileDraft === null) return;
    const parsed = Number(maxFileDraft);
    setMaxFileDraft(null);
    if (!Number.isFinite(parsed) || maxFileDraft.trim() === "") return;
    const mb = clamp(Math.round(parsed), MAX_FILE_MB_MIN, MAX_FILE_MB_MAX);
    const bytes = mb * MIB;
    if (bytes === settings?.documentMaxFileBytes) return;
    updateSettings.mutate({ documentMaxFileBytes: bytes });
  };

  const commitQuota = () => {
    if (quotaDraft === null) return;
    const parsed = Number(quotaDraft);
    setQuotaDraft(null);
    if (!Number.isFinite(parsed) || quotaDraft.trim() === "") return;
    const gb = clamp(parsed, QUOTA_GB_MIN, QUOTA_GB_MAX);
    const bytes = Math.round(gb * GIB);
    if (bytes === settings?.documentQuotaBytes) return;
    updateSettings.mutate({ documentQuotaBytes: bytes });
  };

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Settings}
        title={t("admin.appSettings")}
        description={t("admin.appSettingsDescription")}
      />
      <div className="space-y-4">
        <SettingsToggle
          label={t("admin.registrationEnabled")}
          description={t("admin.registrationEnabledDescription")}
          checked={settings?.registrationEnabled ?? true}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ registrationEnabled: checked })
          }
          disabled={updateSettings.isPending}
        />

        {/* Honest nudge: registration stays open after the first admin so a
            household can be invited, but on an internet-exposed instance that
            means anyone who can reach the URL can sign up. Surface a quiet
            reminder while it is open — no behaviour change, just a signal. */}
        {(settings?.registrationEnabled ?? true) && (
          <p
            data-slot="registration-open-hint"
            className="text-muted-foreground text-xs"
          >
            {t("admin.registrationOpenHint")}
          </p>
        )}

        {/* v1.23 — instance-wide "require a second factor" policy. Every
            account without an active factor is sent to forced enrollment after
            sign-in. This is a web-session nudge, not an API wall: direct API /
            native (Bearer) access for a not-yet-enrolled account is not blocked.
            See docs/ops/mfa-enforcement.md. */}
        <SettingsToggle
          label={t("admin.mfaRequired")}
          description={t("admin.mfaRequiredDescription")}
          checked={settings?.mfaRequired ?? false}
          onCheckedChange={(checked) =>
            updateSettings.mutate({ mfaRequired: checked })
          }
          disabled={updateSettings.isPending}
        />

        {/* v1.4.27 MB7 / CF-56 — match the SettingsToggle stacking
            contract: stack on `<sm`, side-by-side on `sm+`. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("admin.defaultLanguage")}</p>
            <p className="text-muted-foreground text-xs">
              {t("admin.defaultLanguageDescription")}
            </p>
          </div>
          <NativeSelect
            aria-label={t("admin.defaultLanguage")}
            value={settings?.defaultLocale ?? "de"}
            onChange={(e) =>
              updateSettings.mutate({ defaultLocale: e.target.value })
            }
            disabled={updateSettings.isPending}
            className="self-end sm:w-auto sm:self-auto"
          >
            {/* Every shipped locale, not a hand-kept pair: a new language
                that ships without being offered here was the drift. */}
            {locales.map((loc) => (
              <option key={loc} value={loc}>
                {localeLabels[loc]}
              </option>
            ))}
          </NativeSelect>
        </div>

        {/* v1.4.25 W7 — server-wide default timezone for new
            signups. Existing accounts are NOT touched; this drives
            only the registration handler's fallback when the
            client doesn't send a browser-detected zone. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">
              {t("admin.defaultUserTimezone")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("admin.defaultUserTimezoneDescription")}
            </p>
          </div>
          <NativeSelect
            aria-label={t("admin.defaultUserTimezone")}
            value={currentDefaultTz}
            onChange={(e) =>
              updateSettings.mutate({ defaultUserTimezone: e.target.value })
            }
            disabled={updateSettings.isPending}
            className="sm:w-auto"
          >
            <option value="">{t("admin.defaultUserTimezoneFallback")}</option>
            {/* Preserve the stored value even if it's not in the
                current engine's IANA list (rare — but defensive). */}
            {currentDefaultTz && !zones.includes(currentDefaultTz) && (
              <option value={currentDefaultTz}>{currentDefaultTz}</option>
            )}
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </NativeSelect>
        </div>

        {/* Document vault — the two admin-tunable limits (per-file cap +
            per-user storage quota). Everything else about the vault is
            committed behaviour; these are deliberately the only knobs. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("admin.documentMaxFile")}</p>
            <p className="text-muted-foreground text-xs">
              {t("admin.documentMaxFileDescription")}
            </p>
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <Input
              type="number"
              inputMode="numeric"
              min={MAX_FILE_MB_MIN}
              max={MAX_FILE_MB_MAX}
              step={1}
              className="w-24 text-right tabular-nums"
              aria-label={t("admin.documentMaxFile")}
              value={maxFileDraft ?? storedMaxFileMb}
              onChange={(e) => setMaxFileDraft(e.target.value)}
              onBlur={commitMaxFile}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitMaxFile();
              }}
              disabled={updateSettings.isPending || settings == null}
            />
            <span className="text-muted-foreground text-xs">MB</span>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("admin.documentQuota")}</p>
            <p className="text-muted-foreground text-xs">
              {t("admin.documentQuotaDescription")}
            </p>
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <Input
              type="number"
              inputMode="decimal"
              min={QUOTA_GB_MIN}
              max={QUOTA_GB_MAX}
              step={0.1}
              className="w-24 text-right tabular-nums"
              aria-label={t("admin.documentQuota")}
              value={quotaDraft ?? storedQuotaGb}
              onChange={(e) => setQuotaDraft(e.target.value)}
              onBlur={commitQuota}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitQuota();
              }}
              disabled={updateSettings.isPending || settings == null}
            />
            <span className="text-muted-foreground text-xs">GB</span>
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}
