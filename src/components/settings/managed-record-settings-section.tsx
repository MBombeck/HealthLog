"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  normalizeInsightsTileId,
  type InsightsSectionId,
} from "@/lib/insights-layout";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { queryKeys } from "@/lib/query-keys";
import {
  assertRecordSettingsResponseForRecord,
  MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS,
  safeParseManagedRecordSettingsPatch,
  type ManagedRecordSettingsFamily,
} from "@/lib/record-settings";
import {
  METRIC_BOUNDS,
  type ThresholdMetric,
} from "@/lib/analytics/effective-range";
import { ALL_METRICS } from "@/lib/validations/thresholds";
import { SUB_PAGE_TABS } from "@/components/insights/insights-tab-strip";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Switch } from "@/components/ui/switch";
import { SettingsCardActions } from "./_card-actions";
import { SettingsCardHeader } from "./_card-header";
import { SettingsCard } from "./settings-card";

interface ManagedRecordSettingsResponse {
  recordId: string;
  family: ManagedRecordSettingsFamily;
  settings: Record<string, unknown>;
}

type ManagedSettingsFamily = Exclude<
  ManagedRecordSettingsFamily,
  "integrations"
>;
type SettingsFormProps = {
  settings: Record<string, unknown>;
  disabled: boolean;
  onSave: (patch: unknown) => void;
  saveLabel: string;
  /** Save/validation error, rendered ABOVE the action row per §12. */
  error?: ReactNode;
};

const COACH_EXCLUDE_METRICS = [
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
  "hrv",
  "sleep",
  "resting_hr",
  "steps",
  "medications",
  "anthropometrics",
] as const;
const COACH_DATA_CLUSTERS = [
  "cardio",
  "body",
  "activity",
  "workouts",
  "sleep",
  "mood",
  "glucose",
  "medication",
  "mobility",
  "environment",
] as const;
const COACH_EXCLUDE_METRIC_LABEL_KEYS: Record<
  (typeof COACH_EXCLUDE_METRICS)[number],
  string
> = {
  bp: "settings.sharedRecord.managedSettings.coach.metrics.bp",
  weight: "settings.sharedRecord.managedSettings.coach.metrics.weight",
  pulse: "settings.sharedRecord.managedSettings.coach.metrics.pulse",
  mood: "settings.sharedRecord.managedSettings.coach.metrics.mood",
  compliance: "settings.sharedRecord.managedSettings.coach.metrics.compliance",
  hrv: "settings.sharedRecord.managedSettings.coach.metrics.hrv",
  sleep: "settings.sharedRecord.managedSettings.coach.metrics.sleep",
  resting_hr: "settings.sharedRecord.managedSettings.coach.metrics.restingHr",
  steps: "settings.sharedRecord.managedSettings.coach.metrics.steps",
  medications:
    "settings.sharedRecord.managedSettings.coach.metrics.medications",
  anthropometrics:
    "settings.sharedRecord.managedSettings.coach.metrics.anthropometrics",
};
const COACH_DATA_CLUSTER_LABEL_KEYS: Record<
  (typeof COACH_DATA_CLUSTERS)[number],
  string
> = {
  cardio: "settings.sharedRecord.managedSettings.coach.clusters.cardio",
  body: "settings.sharedRecord.managedSettings.coach.clusters.body",
  activity: "settings.sharedRecord.managedSettings.coach.clusters.activity",
  workouts: "settings.sharedRecord.managedSettings.coach.clusters.workouts",
  sleep: "settings.sharedRecord.managedSettings.coach.clusters.sleep",
  mood: "settings.sharedRecord.managedSettings.coach.clusters.mood",
  glucose: "settings.sharedRecord.managedSettings.coach.clusters.glucose",
  medication: "settings.sharedRecord.managedSettings.coach.clusters.medication",
  mobility: "settings.sharedRecord.managedSettings.coach.clusters.mobility",
  environment:
    "settings.sharedRecord.managedSettings.coach.clusters.environment",
};
const INSIGHTS_SECTION_LABEL_KEYS: Record<InsightsSectionId, string> = {
  "wellness-scores":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.wellnessScores",
  "daily-briefing":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.dailyBriefing",
  vitals: "settings.sharedRecord.managedSettings.insights.sectionLabels.vitals",
  trends: "settings.sharedRecord.managedSettings.insights.sectionLabels.trends",
  "period-review":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.periodReview",
  "cycle-summary":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.cycleSummary",
  signals:
    "settings.sharedRecord.managedSettings.insights.sectionLabels.signals",
  "rhythm-events":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.rhythmEvents",
  "health-status":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.healthStatus",
  breathing:
    "settings.sharedRecord.managedSettings.insights.sectionLabels.breathing",
  "labs-changes":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.labsChanges",
  ecg: "settings.sharedRecord.managedSettings.insights.sectionLabels.ecg",
};
const METRIC_LABEL_KEYS: Record<ThresholdMetric, string> = {
  WEIGHT: "thresholds.metricWeight",
  BLOOD_PRESSURE_SYS: "thresholds.metricBpSys",
  BLOOD_PRESSURE_DIA: "thresholds.metricBpDia",
  PULSE: "thresholds.metricPulse",
  BODY_FAT: "thresholds.metricBodyFat",
  SLEEP_DURATION: "thresholds.metricSleep",
  ACTIVITY_STEPS: "thresholds.metricSteps",
  BLOOD_GLUCOSE_FASTING: "thresholds.metricGlucoseFasting",
  BLOOD_GLUCOSE_POSTPRANDIAL: "thresholds.metricGlucosePostprandial",
  BLOOD_GLUCOSE_RANDOM: "thresholds.metricGlucoseRandom",
  BLOOD_GLUCOSE_BEDTIME: "thresholds.metricGlucoseBedtime",
  TOTAL_BODY_WATER: "thresholds.metricBodyWater",
  BONE_MASS: "thresholds.metricBoneMass",
  OXYGEN_SATURATION: "thresholds.metricOxygenSaturation",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function formNumber(form: FormData, name: string, fallback: number): number {
  const value = Number(form.get(name));
  return Number.isFinite(value) ? value : fallback;
}

function ownStringValue(inventory: object, id: string): string | undefined {
  if (!Object.hasOwn(inventory, id)) return undefined;
  const value = Reflect.get(inventory, id);
  return typeof value === "string" ? value : undefined;
}

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

function insightItemLabel(
  t: ReturnType<typeof useTranslations>["t"],
  kind: "section" | "tile",
  id: string,
): string {
  if (kind === "section") {
    const labelKey = ownStringValue(INSIGHTS_SECTION_LABEL_KEYS, id);
    return labelKey
      ? t(labelKey)
      : t("settings.sharedRecord.managedSettings.insights.unknownItem");
  }

  const normalizedId = normalizeInsightsTileId(id);
  if (normalizedId === "overview") return t("insights.navOverview");
  if (!Object.hasOwn(SUB_PAGE_TABS, normalizedId)) {
    return t("settings.sharedRecord.managedSettings.insights.unknownItem");
  }

  const labelKey =
    SUB_PAGE_TABS[normalizedId as keyof typeof SUB_PAGE_TABS]?.labelKey;
  return typeof labelKey === "string"
    ? t(labelKey)
    : t("settings.sharedRecord.managedSettings.insights.unknownItem");
}

/**
 * The form footer, §12: the error line sits ABOVE the action row, and the
 * action row (`SettingsCardActions`) is the last thing in the form. `span`
 * lets a grid form put the footer in a full-width cell.
 */
function FormFooter({
  disabled,
  label,
  error,
  span,
}: {
  disabled: boolean;
  label: string;
  error?: ReactNode;
  span?: string;
}) {
  return (
    <div className={span ? `${span} space-y-3` : "space-y-3"}>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <SettingsCardActions>
        <Button disabled={disabled} type="submit">
          {label}
        </Button>
      </SettingsCardActions>
    </div>
  );
}

/**
 * A managed-settings toggle row — a `<Switch>` (the same primitive the owner
 * module section uses) paired with a hidden mirror input so the FormData
 * submit still reads `name === "on"`. Uncontrolled at the DOM level, controlled
 * in React so the switch and its mirror stay in lockstep.
 */
function ManagedSwitchRow({
  name,
  label,
  defaultChecked,
  disabled,
  className,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
  disabled: boolean;
  className?: string;
}) {
  const id = `managed-switch-${name}`;
  const [on, setOn] = useState(defaultChecked);
  return (
    <div
      className={className ?? "flex items-center justify-between gap-3 text-sm"}
    >
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      <Switch
        id={id}
        checked={on}
        onCheckedChange={setOn}
        disabled={disabled}
        aria-label={label}
        className="shrink-0"
      />
      <input name={name} type="hidden" value={on ? "on" : "off"} />
    </div>
  );
}

function ProfileSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const displayName = asString(form.get("displayName")).trim();
    const heightValue = asString(form.get("heightCm")).trim();
    onSave({
      displayName: displayName || null,
      heightCm: heightValue === "" ? null : Number(heightValue),
      dateOfBirth: asString(form.get("dateOfBirth")) || null,
      gender: asString(form.get("gender")) || null,
      locale: asString(form.get("locale")) || null,
      timezone: asString(form.get("timezone")),
      unitPreference: asString(form.get("unitPreference")),
      timeFormat: asString(form.get("timeFormat")),
      dateFormat: asString(form.get("dateFormat")),
    });
  }

  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <label className="grid gap-1 text-sm" htmlFor="managed-display-name">
        {t("settings.sharedRecord.managedSettings.profile.displayName")}
        <Input
          defaultValue={asString(settings.displayName)}
          disabled={disabled}
          id="managed-display-name"
          name="displayName"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-height">
        {t("settings.sharedRecord.managedSettings.profile.height")}
        <Input
          defaultValue={
            settings.heightCm === null ? "" : String(settings.heightCm ?? "")
          }
          disabled={disabled}
          id="managed-height"
          max="300"
          min="30"
          name="heightCm"
          type="number"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-date-of-birth">
        {t("settings.sharedRecord.managedSettings.profile.dateOfBirth")}
        {/* v1.25.4 — the profile date must not depend on the browser's date
            parsing; DateField displays in the user's order and submits ISO
            through its hidden mirror. */}
        <DateField
          defaultValue={asString(settings.dateOfBirth)}
          disabled={disabled}
          id="managed-date-of-birth"
          name="dateOfBirth"
          autoComplete="bday"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-gender">
        {t("settings.sharedRecord.managedSettings.profile.gender")}
        <NativeSelect
          defaultValue={asString(settings.gender)}
          disabled={disabled}
          id="managed-gender"
          name="gender"
        >
          <option value="">
            {t("settings.sharedRecord.managedSettings.profile.notSpecified")}
          </option>
          <option value="MALE">
            {t("settings.sharedRecord.managedSettings.profile.male")}
          </option>
          <option value="FEMALE">
            {t("settings.sharedRecord.managedSettings.profile.female")}
          </option>
          <option value="OTHER">
            {t("settings.sharedRecord.managedSettings.profile.other")}
          </option>
        </NativeSelect>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-locale">
        {t("settings.sharedRecord.managedSettings.profile.locale")}
        <NativeSelect
          defaultValue={asString(settings.locale)}
          disabled={disabled}
          id="managed-locale"
          name="locale"
        >
          <option value="">
            {t("settings.sharedRecord.managedSettings.profile.systemDefault")}
          </option>
          {["de", "en", "es", "fr", "it", "pl", "ko"].map((locale) => (
            <option key={locale} value={locale}>
              {locale}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-timezone">
        {t("settings.sharedRecord.managedSettings.profile.timezone")}
        <Input
          defaultValue={asString(settings.timezone, "Europe/Berlin")}
          disabled={disabled}
          id="managed-timezone"
          name="timezone"
          required
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-units">
        {t("settings.sharedRecord.managedSettings.profile.units")}
        <NativeSelect
          defaultValue={asString(settings.unitPreference, "metric")}
          disabled={disabled}
          id="managed-units"
          name="unitPreference"
        >
          <option value="metric">
            {t("settings.sharedRecord.managedSettings.profile.metric")}
          </option>
          <option value="imperial">
            {t("settings.sharedRecord.managedSettings.profile.imperial")}
          </option>
        </NativeSelect>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-time-format">
        {t("settings.sharedRecord.managedSettings.profile.timeFormat")}
        <NativeSelect
          defaultValue={asString(settings.timeFormat, "AUTO")}
          disabled={disabled}
          id="managed-time-format"
          name="timeFormat"
        >
          <option value="AUTO">
            {t("settings.sharedRecord.managedSettings.profile.automatic")}
          </option>
          <option value="H12">
            {t("settings.sharedRecord.managedSettings.profile.hour12")}
          </option>
          <option value="H24">
            {t("settings.sharedRecord.managedSettings.profile.hour24")}
          </option>
        </NativeSelect>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-date-format">
        {t("settings.sharedRecord.managedSettings.profile.dateFormat")}
        <NativeSelect
          defaultValue={asString(settings.dateFormat, "AUTO")}
          disabled={disabled}
          id="managed-date-format"
          name="dateFormat"
        >
          <option value="AUTO">
            {t("settings.sharedRecord.managedSettings.profile.automatic")}
          </option>
          <option value="DMY">
            {t("settings.sharedRecord.managedSettings.profile.dateDmy")}
          </option>
          <option value="MDY">
            {t("settings.sharedRecord.managedSettings.profile.dateMdy")}
          </option>
          <option value="YMD">
            {t("settings.sharedRecord.managedSettings.profile.dateYmd")}
          </option>
        </NativeSelect>
      </label>
      <FormFooter
        disabled={disabled}
        label={saveLabel}
        error={error}
        span="sm:col-span-2"
      />
    </form>
  );
}

/**
 * What a Modules save actually sends.
 *
 * The direct modules ride along whether or not they moved — they are one blob
 * the route merges, and a key that did not change writes the value it already
 * had. `cycleTrackingEnabled` is not one of them: it is a DELEGATED module
 * whose column the cycle gate honours OVER the sex-derived default, so sending
 * the switch's current position on every save freezes the derivation. A record
 * created with no recorded sex derives cycle OFF; a guardian who turns Labs off
 * and saves would write that OFF as an explicit answer, and the record's sex
 * being set to FEMALE afterwards would then leave cycle off with nothing on
 * screen to say why. It also put `cycleTrackingEnabled` in the record's audit
 * trail on every save of any module.
 *
 * So it is sent only when it differs from the value the form opened on, which
 * is what the managed-record edit form's `managedProfileEditPatch` already does
 * for its own five fields.
 *
 * Exported and pure because it is the decision this form makes, and a decision
 * about what NOT to send is invisible in the rendered markup.
 */
export function managedModulesPatch(
  settings: Record<string, unknown>,
  form: FormData,
): {
  modulePreferences: Record<string, boolean>;
  cycleTrackingEnabled?: boolean;
} {
  const cycleTrackingEnabled = form.get("cycleTrackingEnabled") === "on";
  // The same expression the switch is seeded from, so "differs from what the
  // form opened on" is one statement rather than two that can drift.
  const loaded = settings.cycleTrackingEnabled === true;
  return {
    modulePreferences: Object.fromEntries(
      Object.keys(MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS).map((key) => [
        key,
        form.get(key) === "on",
      ]),
    ),
    ...(cycleTrackingEnabled !== loaded ? { cycleTrackingEnabled } : {}),
  };
}

function ModulesSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();
  const preferences = asRecord(settings.modulePreferences);
  const entries = Object.entries(MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS) as [
    keyof typeof MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS,
    boolean,
  ][];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(managedModulesPatch(settings, new FormData(event.currentTarget)));
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      {entries.map(([key, defaultEnabled]) => (
        <ManagedSwitchRow
          key={key}
          name={key}
          label={t(MODULE_REGISTRY[key].labelKey)}
          defaultChecked={
            preferences[key] === undefined
              ? defaultEnabled
              : preferences[key] === true
          }
          disabled={disabled}
        />
      ))}
      {/* v1.38.14 (#939) — Cycle sits below the rest because it is not one of
          them: it is a DELEGATED module, so its state lives in the record's own
          cycle profile rather than in the module blob, and it had no row here
          at all. A guardian could not turn it off for a record whose sex says
          it should be on, which is the case the issue was opened about. */}
      <ManagedSwitchRow
        name="cycleTrackingEnabled"
        label={t(MODULE_REGISTRY.cycle.labelKey)}
        defaultChecked={settings.cycleTrackingEnabled === true}
        disabled={disabled}
      />
      <FormFooter disabled={disabled} label={saveLabel} error={error} />
    </form>
  );
}

function NotificationsSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();
  const preferences = asRecord(settings.notificationPreferences);
  const medication = asRecord(preferences.medication);
  const mood = asRecord(preferences.mood);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      moodReminderEnabled: form.get("moodReminderEnabled") === "on",
      notificationPreferences: {
        medication: {
          lowStockRunwayDays:
            form.get("lowStockRunwayDays") === ""
              ? null
              : formNumber(form, "lowStockRunwayDays", 7),
          reorderLeadDays: formNumber(form, "reorderLeadDays", 10),
        },
        mood: { reminderHour: formNumber(form, "reminderHour", 22) },
      },
    });
  }

  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <ManagedSwitchRow
        name="moodReminderEnabled"
        label={t(
          "settings.sharedRecord.managedSettings.notifications.moodReminder",
        )}
        defaultChecked={settings.moodReminderEnabled === true}
        disabled={disabled}
        className="flex items-center justify-between gap-3 text-sm sm:col-span-2"
      />
      <label className="grid gap-1 text-sm" htmlFor="managed-reminder-hour">
        {t("settings.sharedRecord.managedSettings.notifications.reminderHour")}
        <Input
          defaultValue={asNumber(mood.reminderHour, 22)}
          disabled={disabled}
          id="managed-reminder-hour"
          max="23"
          min="0"
          name="reminderHour"
          type="number"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-low-stock">
        {t(
          "settings.sharedRecord.managedSettings.notifications.lowStockRunwayDays",
        )}
        <Input
          defaultValue={
            medication.lowStockRunwayDays === null
              ? ""
              : asNumber(medication.lowStockRunwayDays, 7)
          }
          disabled={disabled}
          id="managed-low-stock"
          max="60"
          min="1"
          name="lowStockRunwayDays"
          type="number"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-reorder-lead">
        {t(
          "settings.sharedRecord.managedSettings.notifications.reorderLeadDays",
        )}
        <Input
          defaultValue={asNumber(medication.reorderLeadDays, 10)}
          disabled={disabled}
          id="managed-reorder-lead"
          max="60"
          min="0"
          name="reorderLeadDays"
          type="number"
        />
      </label>
      <FormFooter
        disabled={disabled}
        label={saveLabel}
        error={error}
        span="sm:col-span-2"
      />
    </form>
  );
}

function ThresholdsSettingsForm({
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
      <label className="grid gap-1 text-sm" htmlFor="managed-threshold-metric">
        {t("settings.sharedRecord.managedSettings.thresholds.metric")}
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
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-threshold-minimum">
        {t("settings.sharedRecord.managedSettings.thresholds.minimum")}
        <Input
          defaultValue={minimum}
          disabled={disabled}
          id="managed-threshold-minimum"
          key={`${metric}-minimum`}
          name="minimum"
          required
          type="number"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-threshold-maximum">
        {t("settings.sharedRecord.managedSettings.thresholds.maximum")}
        <Input
          defaultValue={maximum}
          disabled={disabled}
          id="managed-threshold-maximum"
          key={`${metric}-maximum`}
          name="maximum"
          required
          type="number"
        />
      </label>
      <FormFooter
        disabled={disabled}
        label={saveLabel}
        error={error}
        span="sm:col-span-3"
      />
    </form>
  );
}

function CoachSettingsForm({
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
        <label className="grid gap-1 text-sm" htmlFor="managed-coach-window">
          {t("settings.sharedRecord.managedSettings.coach.defaultWindow")}
          <NativeSelect
            defaultValue={asString(preferences.defaultWindow, "allTime")}
            disabled={disabled}
            id="managed-coach-window"
            name="defaultWindow"
          >
            <option value="last7days">
              {t("settings.sharedRecord.managedSettings.coach.last7days")}
            </option>
            <option value="last30days">
              {t("settings.sharedRecord.managedSettings.coach.last30days")}
            </option>
            <option value="last90days">
              {t("settings.sharedRecord.managedSettings.coach.last90days")}
            </option>
            <option value="allTime">
              {t("settings.sharedRecord.managedSettings.coach.allTime")}
            </option>
          </NativeSelect>
        </label>
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

type LayoutItem = { id: string; visible: boolean; order: number };

function layoutItems(value: unknown): LayoutItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = asRecord(entry);
    const id = asString(item.id);
    return id
      ? [
          {
            id,
            visible: item.visible === true,
            order: asNumber(item.order, 0),
          },
        ]
      : [];
  });
}

function InsightsSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
  error,
}: SettingsFormProps) {
  const { t } = useTranslations();
  const layout = asRecord(settings.layout);
  const sections = layoutItems(layout.sections);
  const tiles = layoutItems(layout.tiles);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const toPatch = (kind: "section" | "tile", item: LayoutItem) => ({
      id: item.id,
      visible: form.get(`${kind}-visible-${item.id}`) === "on",
      order: formNumber(form, `${kind}-order-${item.id}`, item.order),
    });
    onSave({
      layout: {
        version: asNumber(layout.version, 2),
        sections: sections.map((section) => toPatch("section", section)),
        tiles: tiles.map((tile) => toPatch("tile", tile)),
      },
    });
  }

  const renderItems = (kind: "section" | "tile", items: LayoutItem[]) => (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {kind === "section"
          ? t("settings.sharedRecord.managedSettings.insights.sections")
          : t("settings.sharedRecord.managedSettings.insights.tiles")}
      </legend>
      {items.map((item) => (
        <div className="flex items-center gap-3 text-sm" key={item.id}>
          <ManagedSwitchRow
            className="flex flex-1 items-center justify-between gap-2 text-sm"
            name={`${kind}-visible-${item.id}`}
            label={insightItemLabel(t, kind, item.id)}
            defaultChecked={item.visible}
            disabled={disabled}
          />
          <label
            className="flex items-center gap-2"
            htmlFor={`${kind}-order-${item.id}`}
          >
            {t("settings.sharedRecord.managedSettings.insights.order")}
            <Input
              className="w-16"
              defaultValue={item.order}
              disabled={disabled}
              id={`${kind}-order-${item.id}`}
              min="0"
              name={`${kind}-order-${item.id}`}
              type="number"
            />
          </label>
        </div>
      ))}
    </fieldset>
  );

  return (
    <form className="space-y-4" onSubmit={submit}>
      {renderItems("section", sections)}
      {renderItems("tile", tiles)}
      <FormFooter disabled={disabled} label={saveLabel} error={error} />
    </form>
  );
}

export function ManagedRecordSettingsForm({
  family,
  ...props
}: SettingsFormProps & { family: ManagedSettingsFamily }) {
  switch (family) {
    case "profile":
      return <ProfileSettingsForm {...props} />;
    case "modules":
      return <ModulesSettingsForm {...props} />;
    case "notifications":
      return <NotificationsSettingsForm {...props} />;
    case "thresholds":
      return <ThresholdsSettingsForm {...props} />;
    case "coach":
      return <CoachSettingsForm {...props} />;
    case "insights":
      return <InsightsSettingsForm {...props} />;
  }
}

/**
 * Managed settings use typed target-record controls only. The actor's
 * Settings components never mount here, so their actor-scoped queries and
 * mutations cannot fire while a Guardian administers a profile.
 */
export function ManagedRecordSettingsSection({
  family,
}: {
  family: ManagedSettingsFamily;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const recordId = user?.accountAccess?.active?.accountId ?? null;
  const [validationFailed, setValidationFailed] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.recordSettingsFamily(recordId ?? "", family),
    enabled: recordId !== null,
    queryFn: async () => {
      const response = await apiGet<ManagedRecordSettingsResponse>(
        `/api/record-settings/${family}`,
      );
      assertRecordSettingsResponseForRecord(response, recordId);
      if (response.family !== family) {
        throw new Error(
          "Managed record settings response did not match its key",
        );
      }
      return response;
    },
  });
  const save = useMutation({
    mutationFn: async (patch: unknown) => {
      const response = await apiPatch<ManagedRecordSettingsResponse>(
        `/api/record-settings/${family}`,
        patch,
      );
      assertRecordSettingsResponseForRecord(response, recordId);
      if (response.family !== family) {
        throw new Error(
          "Managed record settings response did not match its key",
        );
      }
      return response;
    },
    onSuccess: (response) => {
      if (recordId === null) return;
      queryClient.setQueryData(
        queryKeys.recordSettingsFamily(recordId, family),
        response,
      );
    },
  });

  if (query.isError) {
    return <QueryErrorCard onRetry={() => void query.refetch()} />;
  }

  return (
    <SettingsCard
      aria-busy={query.isLoading}
      data-record-id={recordId ?? undefined}
      data-record-settings-family={family}
    >
      <SettingsCardHeader
        icon={Settings}
        title={t(`settings.sharedRecord.managedSettings.${family}.title`)}
      />
      {query.data ? (
        <ManagedRecordSettingsForm
          disabled={save.isPending}
          family={family}
          // §12 — the form renders this ABOVE its action row; nothing follows
          // the action.
          error={
            validationFailed
              ? t("settings.sharedRecord.managedSettings.validationError")
              : save.isError
                ? t("settings.sharedRecord.managedSettings.saveError")
                : undefined
          }
          onSave={(patch) => {
            const parsed = safeParseManagedRecordSettingsPatch(family, patch);
            if (!parsed.success) {
              setValidationFailed(true);
              return;
            }
            setValidationFailed(false);
            save.mutate(parsed.data);
          }}
          saveLabel={t("common.save")}
          settings={query.data.settings}
        />
      ) : null}
    </SettingsCard>
  );
}
