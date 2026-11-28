"use client";

/**
 * Per-user timezone picker (v1.4.25 W7).
 *
 * Renders a native `<select>` over `Intl.supportedValuesOf('timeZone')`.
 * The control is uncontrolled w.r.t. its parent — the parent passes in
 * `value` + `onChange`, but the parent owns the network round-trip so
 * this component stays synchronous + presentational. The save POSTs
 * `PUT /api/auth/me/timezone` in the parent form's submit handler.
 *
 * v1.4.37 — the "Browser-Zeitzone übernehmen" button retired. The
 * account-section bootstrap effect now seeds the form silently with
 * `detectBrowserTimezone()` on first mount when the stored value is
 * still the Europe/Berlin default, so the affordance is no longer
 * needed and the picker reads cleaner alongside the surrounding form
 * rows.
 *
 * Fallback: on older engines without `Intl.supportedValuesOf` we
 * render a free-text input. Every modern browser back to mid-2022
 * (Chrome 99 / Safari 15.4 / Firefox 99) ships the API; the fallback
 * is defensive only.
 */
import { useMemo } from "react";

import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { listSupportedTimezones, DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { useTranslations } from "@/lib/i18n/context";

// v1.4.27 — the in-file `NATIVE_SELECT_CLASS` constant
// retired; the shared `<NativeSelect>` primitive owns the visual
// contract now. The select spans the full width of its grid cell so it
// lines up with the fields above it rather than sitting narrower.

export interface TimezonePickerProps {
  /** The user's current stored timezone. */
  value: string;
  /** Called when the user picks (or types) a new zone. */
  onChange: (next: string) => void;
  /** Render-only id for the label association. */
  id?: string;
  /** Optional override of the hint copy under the picker. */
  hint?: string;
}

export function TimezonePicker({
  value,
  onChange,
  id = "timezone",
  hint,
}: TimezonePickerProps) {
  const { t } = useTranslations();
  // `listSupportedTimezones()` is engine-side; memoise so the list
  // isn't reconstructed on every render.
  const zones = useMemo(() => listSupportedTimezones(), []);

  const labelHint = hint ?? t("settings.timezoneHint");

  if (zones.length === 0) {
    // Older engine — free-text fallback.
    return (
      <FieldGroup htmlFor={id} label={t("settings.timezone")}>
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={DEFAULT_TIMEZONE}
          autoComplete="off"
        />
        <p className="text-muted-foreground text-xs">{labelHint}</p>
      </FieldGroup>
    );
  }

  return (
    <FieldGroup htmlFor={id} label={t("settings.timezone")}>
      <NativeSelect
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full"
      >
        {/* Preserve the stored value even if the runtime's IANA
            list changed across engines or tzdata rolls. */}
        {!zones.includes(value) && value.length > 0 && (
          <option value={value}>{value}</option>
        )}
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </NativeSelect>
      <p className="text-muted-foreground text-xs">{labelHint}</p>
    </FieldGroup>
  );
}
