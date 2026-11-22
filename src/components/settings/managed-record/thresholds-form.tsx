import { useState, type FormEvent } from "react";

import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  METRIC_BOUNDS,
  type ThresholdMetric,
} from "@/lib/analytics/effective-range";
import { useTranslations } from "@/lib/i18n/context";
import { ALL_METRICS } from "@/lib/validations/thresholds";

import { METRIC_LABEL_KEYS } from "../managed-record-settings-labels";
import {
  asNumber,
  asRecord,
  FormFooter,
  formNumber,
  type SettingsFormProps,
} from "./form-kit";

export function ThresholdsSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();
  const overrides = asRecord(settings.overrides);
  const effective = asRecord(settings.effective);
  const [metric, setMetric] = useState<ThresholdMetric>(ALL_METRICS[0]);
  const overrideRange = asRecord(overrides[metric]);
  const defaultRange = asRecord(asRecord(effective[metric]).range);
  const bounds = METRIC_BOUNDS[metric];
  const minimum = asNumber(
    overrideRange.min,
    asNumber(defaultRange.greenMin, bounds.min),
  );
  const maximum = asNumber(
    overrideRange.max,
    asNumber(defaultRange.greenMax, bounds.max),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      overrides: {
        [metric]: {
          min: formNumber(form, "minimum", minimum),
          max: formNumber(form, "maximum", maximum),
        },
      },
    });
  }

  return (
    <form className="grid gap-4 sm:grid-cols-3" onSubmit={submit}>
      <FieldGroup
        htmlFor="managed-threshold-metric"
        label={t("settings.sharedRecord.managedSettings.thresholds.metric")}
      >
        <NativeSelect
          onChange={(event) => setMetric(event.target.value as ThresholdMetric)}
          value={metric}
          disabled={disabled}
          id="managed-threshold-metric"
          name="metric"
        >
          {ALL_METRICS.map((entry) => (
            <option key={entry} value={entry}>
              {t(METRIC_LABEL_KEYS[entry])}
            </option>
          ))}
        </NativeSelect>
      </FieldGroup>
      <FieldGroup
        htmlFor="managed-threshold-minimum"
        label={t("settings.sharedRecord.managedSettings.thresholds.minimum")}
      >
        <Input
          defaultValue={minimum}
          disabled={disabled}
          id="managed-threshold-minimum"
          key={`${metric}-minimum`}
          name="minimum"
          required
          type="number"
        />
      </FieldGroup>
      <FieldGroup
        htmlFor="managed-threshold-maximum"
        label={t("settings.sharedRecord.managedSettings.thresholds.maximum")}
      >
        <Input
          defaultValue={maximum}
          disabled={disabled}
          id="managed-threshold-maximum"
          key={`${metric}-maximum`}
          name="maximum"
          required
          type="number"
        />
      </FieldGroup>
      <FormFooter
        disabled={disabled}
        label={saveLabel}
        error={error}
        span="sm:col-span-3"
      />
    </form>
  );
}
