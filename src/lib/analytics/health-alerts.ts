/**
 * Rule-based health alerts: the deterministic threshold engine behind the
 * Insights overview (`/api/insights/comprehensive`) and the native app's
 * insight cards (`/api/insights/cards`).
 *
 * The engine decides which alerts fire and with which values
 * (`generateAlertSpecs`); the wording is a catalog entry under
 * `serverText.alerts.*`, filled in the reader's language
 * (`localiseAlerts`). The two steps are apart because the overview body is
 * cached per record while the language belongs to the request: a body
 * cached for a German browser must still read in English to an app that
 * asks for English. The specs are what gets cached; the sentence is made
 * on the way out.
 *
 * Server only: the translator reads the message catalogs from disk.
 */
import { classifyBP } from "@/lib/analytics/classifications";
import type { Locale } from "@/lib/i18n/config";
import { resolveIntlLocale } from "@/lib/format-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { STATUS_CATEGORY_KEY } from "@/lib/targets/status-category-keys";

export type HealthAlertLevel = "success" | "info" | "warning" | "danger";

/** The worded alert a client receives. */
export interface HealthAlert {
  level: HealthAlertLevel;
  title: string;
  message: string;
}

/** Which alert fired and the values it names; no wording. */
export interface HealthAlertSpec {
  level: HealthAlertLevel;
  /** Entry under `serverText.alerts.*` holding `title` and `message`. */
  key: AlertKey;
  /** Numbers are formatted for the reader's locale, strings go in as written. */
  params: Record<string, string | number>;
  /** Parameters that are themselves catalog keys, resolved in the reader's language. */
  keyParams?: Record<string, string>;
}

export type AlertKey =
  | "bmiBelowNormal"
  | "bmiOverweight"
  | "bmiObesity"
  | "bmiNormal"
  | "bpSignificantlyElevated"
  | "bpSlightlyElevated"
  | "bpTargetGood"
  | "bpTargetLow"
  | "weightIncreasing"
  | "weightDecreasing"
  | "pulseOutliers"
  | "complianceLow"
  | "complianceExcellent";

export interface AlertInput {
  bmi?: number | null;
  bpAvgSys?: number | null;
  bpAvgDia?: number | null;
  bpPctInTarget?: number | null;
  weightSlope30?: number | null;
  pulseAvg30?: number | null;
  pulseAnomalyCount?: number;
  medications?: Array<{
    name: string;
    compliance7: number;
    compliance30: number;
  }>;
}

/** The catalog key a BP category is named under, the status pill's own. */
function bpCategoryKey(category: string): string {
  const key = STATUS_CATEGORY_KEY[category];
  return key ? `targets.status.${key}` : category;
}

export function generateAlertSpecs(input: AlertInput): HealthAlertSpec[] {
  const alerts: HealthAlertSpec[] = [];

  if (input.bmi != null) {
    const bmi = input.bmi;
    if (bmi < 18.5) {
      alerts.push({ level: "warning", key: "bmiBelowNormal", params: { bmi } });
    } else if (bmi >= 25 && bmi < 30) {
      alerts.push({ level: "info", key: "bmiOverweight", params: { bmi } });
    } else if (bmi >= 30) {
      alerts.push({ level: "warning", key: "bmiObesity", params: { bmi } });
    } else {
      alerts.push({ level: "success", key: "bmiNormal", params: { bmi } });
    }
  }

  if (input.bpAvgSys != null && input.bpAvgDia != null) {
    const bpClass = classifyBP(input.bpAvgSys, input.bpAvgDia);
    const params = { sys: input.bpAvgSys, dia: input.bpAvgDia };
    const keyParams = { category: bpCategoryKey(bpClass.category) };
    if (bpClass.severity === "danger") {
      alerts.push({
        level: "danger",
        key: "bpSignificantlyElevated",
        params,
        keyParams,
      });
    } else if (bpClass.severity === "warning") {
      alerts.push({
        level: "warning",
        key: "bpSlightlyElevated",
        params,
        keyParams,
      });
    }
  }

  if (input.bpPctInTarget != null) {
    const percent = input.bpPctInTarget;
    if (percent >= 80) {
      alerts.push({
        level: "success",
        key: "bpTargetGood",
        params: { percent },
      });
    } else if (percent < 50) {
      alerts.push({
        level: "warning",
        key: "bpTargetLow",
        params: { percent },
      });
    }
  }

  if (input.weightSlope30 != null) {
    const weeklyChange = input.weightSlope30 * 7;
    if (weeklyChange > 0.5) {
      alerts.push({
        level: "info",
        key: "weightIncreasing",
        params: { kg: Math.round(weeklyChange * 10) / 10 },
      });
    } else if (weeklyChange < -0.5) {
      alerts.push({
        level: "info",
        key: "weightDecreasing",
        params: { kg: Math.round(Math.abs(weeklyChange) * 10) / 10 },
      });
    }
  }

  if (input.pulseAnomalyCount != null && input.pulseAnomalyCount > 2) {
    alerts.push({
      level: "warning",
      key: "pulseOutliers",
      params: { count: input.pulseAnomalyCount },
    });
  }

  for (const med of input.medications ?? []) {
    const params = { name: med.name, percent: med.compliance7 };
    if (med.compliance7 < 80) {
      alerts.push({ level: "warning", key: "complianceLow", params });
    } else if (med.compliance7 >= 95) {
      alerts.push({ level: "success", key: "complianceExcellent", params });
    }
  }

  return alerts;
}

/** Word the alerts in the reader's language. */
export function localiseAlerts(
  specs: readonly HealthAlertSpec[],
  locale: Locale,
): HealthAlert[] {
  const { t } = getServerTranslator(locale);
  const number = new Intl.NumberFormat(resolveIntlLocale(locale), {
    maximumFractionDigits: 1,
    useGrouping: false,
  });
  return specs.map((spec) => {
    const params: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(spec.params)) {
      // A count stays a number so the plural block can pick its form.
      params[name] =
        typeof value === "number" && name !== "count"
          ? number.format(value)
          : value;
    }
    for (const [name, key] of Object.entries(spec.keyParams ?? {})) {
      params[name] = t(key);
    }
    return {
      level: spec.level,
      title: t(`serverText.alerts.${spec.key}.title`, params),
      message: t(`serverText.alerts.${spec.key}.message`, params),
    };
  });
}

/** The alerts for `input`, worded in `locale`. */
export function generateAlerts(
  input: AlertInput,
  locale: Locale,
): HealthAlert[] {
  return localiseAlerts(generateAlertSpecs(input), locale);
}
