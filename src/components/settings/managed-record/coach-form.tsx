import { useState, type FormEvent } from "react";

import { NativeSelect } from "@/components/ui/native-select";
import {
  COACH_HISTORY_WINDOWS,
  HISTORY_REACH_DAYS,
  lookbackText,
} from "@/lib/ai/coach/history-reach";
import { useTranslations } from "@/lib/i18n/context";
import type { CoachDefaultWindow } from "@/lib/validations/coach-prefs";

import {
  COACH_DATA_CLUSTER_LABEL_KEYS,
  COACH_DATA_CLUSTERS,
  COACH_EXCLUDE_METRIC_LABEL_KEYS,
  COACH_EXCLUDE_METRICS,
} from "../managed-record-settings-labels";
import {
  asRecord,
  asString,
  asStringArray,
  FormFooter,
  ManagedSwitchRow,
  ownStringValue,
  type SettingsFormProps,
} from "./form-kit";

function coachMetricLabel(
  t: ReturnType<typeof useTranslations>["t"],
  metric: (typeof COACH_EXCLUDE_METRICS)[number],
): string {
  const labelKey = ownStringValue(COACH_EXCLUDE_METRIC_LABEL_KEYS, metric);
  return labelKey
    ? t(labelKey)
    : t("settings.sharedRecord.managedSettings.insights.unknownItem");
}

function coachClusterLabel(
  t: ReturnType<typeof useTranslations>["t"],
  cluster: (typeof COACH_DATA_CLUSTERS)[number],
): string {
  const labelKey = ownStringValue(COACH_DATA_CLUSTER_LABEL_KEYS, cluster);
  return labelKey
    ? t(labelKey)
    : t("settings.sharedRecord.managedSettings.insights.unknownItem");
}

export function CoachSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();
  const preferences = asRecord(settings.preferences);
  const excluded = new Set(asStringArray(preferences.excludeMetrics));
  const dataClusters = new Set(asStringArray(preferences.dataClusters));
  const savedWindow = asString(preferences.defaultWindow, "allTime");
  const [lookback, setLookback] = useState<CoachDefaultWindow>(
    (COACH_HISTORY_WINDOWS as readonly string[]).includes(savedWindow)
      ? (savedWindow as CoachDefaultWindow)
      : "allTime",
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      disableCoach: form.get("disableCoach") === "on",
      preferences: {
        tone: asString(form.get("tone"), "warm"),
        verbosity: asString(form.get("verbosity"), "default"),
        excludeMetrics: COACH_EXCLUDE_METRICS.filter(
          (metric) => form.get(`exclude-${metric}`) === "on",
        ),
        defaultWindow: asString(form.get("defaultWindow"), "allTime"),
        ...(form.get("useCustomClusters") === "on"
          ? {
              dataClusters: COACH_DATA_CLUSTERS.filter(
                (cluster) => form.get(`cluster-${cluster}`) === "on",
              ),
            }
          : {}),
      },
    });
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <ManagedSwitchRow
        name="disableCoach"
        label={t("settings.sharedRecord.managedSettings.coach.disable")}
        defaultChecked={settings.disableCoach === true}
        disabled={disabled}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="grid gap-1 text-sm" htmlFor="managed-coach-tone">
          {t("settings.sharedRecord.managedSettings.coach.tone")}
          <NativeSelect
            defaultValue={asString(preferences.tone, "warm")}
            disabled={disabled}
            id="managed-coach-tone"
            name="tone"
          >
            <option value="warm">
              {t("settings.sharedRecord.managedSettings.coach.warm")}
            </option>
            <option value="neutral">
              {t("settings.sharedRecord.managedSettings.coach.neutral")}
            </option>
            <option value="concise">
              {t("settings.sharedRecord.managedSettings.coach.concise")}
            </option>
          </NativeSelect>
        </label>
        <label className="grid gap-1 text-sm" htmlFor="managed-coach-verbosity">
          {t("settings.sharedRecord.managedSettings.coach.verbosity")}
          <NativeSelect
            defaultValue={asString(preferences.verbosity, "default")}
            disabled={disabled}
            id="managed-coach-verbosity"
            name="verbosity"
          >
            <option value="brief">
              {t("settings.sharedRecord.managedSettings.coach.brief")}
            </option>
            <option value="default">
              {t("settings.sharedRecord.managedSettings.coach.default")}
            </option>
            <option value="detailed">
              {t("settings.sharedRecord.managedSettings.coach.detailed")}
            </option>
          </NativeSelect>
        </label>
        {/* The same lookback options and wording as the Coach's own picker:
            the choice is a limit on every Coach read. */}
        <div className="grid gap-1 text-sm">
          <label htmlFor="managed-coach-window">
            {t("insights.coach.lookback.label")}
          </label>
          <NativeSelect
            value={lookback}
            onChange={(event) =>
              setLookback(event.currentTarget.value as CoachDefaultWindow)
            }
            disabled={disabled}
            id="managed-coach-window"
            name="defaultWindow"
            aria-describedby="managed-coach-window-detail"
          >
            {COACH_HISTORY_WINDOWS.map((window) => (
              <option key={window} value={window}>
                {t(
                  `insights.coach.lookback.option.${window}`,
                  lookbackText(window).optionParams,
                )}
              </option>
            ))}
          </NativeSelect>
          <p
            id="managed-coach-window-detail"
            className="text-muted-foreground text-xs"
          >
            {t(
              `insights.coach.lookback.${lookbackText(lookback).detailKey}`,
              lookbackText(lookback).detailParams,
            )}
            {HISTORY_REACH_DAYS[lookback] !== null
              ? ` ${t("insights.coach.lookback.note")}`
              : null}
          </p>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          {t("settings.sharedRecord.managedSettings.coach.excludedMetrics")}
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {COACH_EXCLUDE_METRICS.map((metric) => (
            <ManagedSwitchRow
              key={metric}
              name={`exclude-${metric}`}
              label={coachMetricLabel(t, metric)}
              defaultChecked={excluded.has(metric)}
              disabled={disabled}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          {t("settings.sharedRecord.managedSettings.coach.dataClusters")}
        </legend>
        <ManagedSwitchRow
          name="useCustomClusters"
          label={t(
            "settings.sharedRecord.managedSettings.coach.customClusters",
          )}
          defaultChecked={Array.isArray(preferences.dataClusters)}
          disabled={disabled}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          {COACH_DATA_CLUSTERS.map((cluster) => (
            <ManagedSwitchRow
              key={cluster}
              name={`cluster-${cluster}`}
              label={coachClusterLabel(t, cluster)}
              defaultChecked={dataClusters.has(cluster)}
              disabled={disabled}
            />
          ))}
        </div>
      </fieldset>
      <FormFooter disabled={disabled} label={saveLabel} error={error} />
    </form>
  );
}
