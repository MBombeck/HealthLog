"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import {
  LEAFLET_URL_MAX_CHARS,
  isAcceptableLeafletUrl,
} from "@/lib/medications/leaflet-url";

import type { StepProps } from "./step1-name";

/**
 * #1430 — the official leaflet the person found, saved as a link. Optional;
 * clearing it on an edit removes the stored link. Only `https:` addresses are
 * accepted; anything else holds the step with the hint under the field.
 */
export function Step8LeafletField({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  const value = payload.leafletUrl;
  const invalid = value.trim() !== "" && !isAcceptableLeafletUrl(value.trim());
  return (
    <div className="space-y-1.5" data-slot="wizard-leaflet">
      <Label htmlFor="wizard-leaflet-url" className="text-sm font-medium">
        {t("medications.leaflet.urlLabel")}
      </Label>
      <Input
        id="wizard-leaflet-url"
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => applyPartial({ leafletUrl: e.target.value })}
        placeholder="https://"
        maxLength={LEAFLET_URL_MAX_CHARS}
        aria-invalid={invalid || undefined}
        aria-describedby="wizard-leaflet-url-helper"
        data-slot="wizard-leaflet-url-input"
      />
      <p
        id="wizard-leaflet-url-helper"
        className={
          invalid ? "text-destructive text-xs" : "text-muted-foreground text-xs"
        }
      >
        {invalid
          ? t("medications.leaflet.urlInvalid")
          : t("medications.leaflet.urlHelper")}
      </p>
    </div>
  );
}
