"use client";

/**
 * Per-user timezone picker (v1.4.25 W7).
 *
 * Renders a native `<select>` over `Intl.supportedValuesOf('timeZone')`
 * plus a "use my browser zone" button. The control is uncontrolled
 * w.r.t. its parent — the parent passes in `value` + `onChange`, but
 * the parent owns the network round-trip so this component stays
 * synchronous + presentational. The save POSTs
 * `PUT /api/auth/me/timezone` in the parent form's submit handler.
 *
 * Fallback: on older engines without `Intl.supportedValuesOf` we
 * render a free-text input. Every modern browser back to mid-2022
 * (Chrome 99 / Safari 15.4 / Firefox 99) ships the API; the fallback
 * is defensive only.
 */
import { useMemo, useState } from "react";
import { Compass } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  detectBrowserTimezone,
  listSupportedTimezones,
} from "@/lib/tz/format";
import { useTranslations } from "@/lib/i18n/context";

const NATIVE_SELECT_CLASS =
  "border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none";

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
  const [detected] = useState(() => detectBrowserTimezone());

  const handleUseBrowserTz = () => {
    if (detected) onChange(detected);
  };

  const labelHint = hint ?? t("settings.timezoneHint");

  if (zones.length === 0) {
    // Older engine — free-text fallback.
    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{t("settings.timezone")}</Label>
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Europe/Berlin"
          autoComplete="off"
        />
        <p className="text-muted-foreground text-xs">{labelHint}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleUseBrowserTz}
        >
          <Compass className="mr-2 h-4 w-4" />
          {t("settings.timezoneDetect", { tz: detected })}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("settings.timezone")}</Label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${NATIVE_SELECT_CLASS} sm:max-w-sm`}
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
        </select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleUseBrowserTz}
          className="sm:w-auto"
        >
          <Compass className="mr-2 h-4 w-4" />
          {t("settings.timezoneDetect", { tz: detected })}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">{labelHint}</p>
    </div>
  );
}
