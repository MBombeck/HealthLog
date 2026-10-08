/**
 * v1.25 (W-ENV) — the canonical environmental-exposure field vocabulary.
 *
 * One declarative table that names each daily weather/daylight field HealthLog
 * stores AND correlates. It is the single source the two surfaces speak:
 *
 *   - the SIGNAL REGISTRY (`src/lib/signals/registry.ts`) registers one
 *     `kind:"environment"` signal per field here, so each gets a stable signal
 *     key + display metadata for free; and
 *   - the CORRELATION ENGINE reads {@link ENVIRONMENT_FIELDS} to fold the
 *     same fields in as lagged BEHAVIOUR (exposure) channels against mood /
 *     sleep / vitals.
 *
 * `key` doubles as the registry signal key AND the correlation channel key —
 * the `ENV_` prefix keeps it from colliding with a `MeasurementType` and lets
 * `metricFamily()` collapse all env channels into one `ENVIRONMENT` family (so
 * the engine never lag-correlates two same-day weather fields against each
 * other — that is a near-tautology, not an insight).
 *
 * `column` is the `EnvironmentContext` numeric column the field reads. Leaf
 * module (no imports) so both the registry and the pure correlation engine can
 * depend on it without a cycle.
 *
 * Lag semantics (v1.42). Every field here is tested as ONE hypothesis per
 * outcome: the exposure is the mean of the day before and the day itself
 * ("lag 0–1"), paired with the outcome on the same day. The correlation read
 * in `correlation-channel-series.ts` builds that mean, emits a point only for
 * a day whose previous day is stored too, and tags the series `lagDays: 0`; a
 * discovered pair therefore reports `lagDays: 0` and narrates "on the day and
 * the day before". Two reasons, both about getting the night right:
 *
 *  - sleep is keyed on the day you wake up, so last night's sleep sits on day
 *    D, and the overnight low that shaped it is the early morning of D (and the
 *    evening of D−1). The old fixed next-day lag paired the night's low with
 *    the FOLLOWING night;
 *  - testing lag 0 and lag 1 separately would double the environmental tests
 *    in the false-discovery family (and taking whichever looked better would
 *    be selection without correction). The averaged window covers both at the
 *    cost of one test.
 *
 * Season and trend are removed from both series before any of this is
 * correlated (see `src/lib/insights/seasonal-adjust.ts`), so a field that only
 * follows the calendar does not surface. A new field added below inherits all
 * of it with no further wiring.
 */

/** The `EnvironmentContext` numeric columns a correlation field can read. */
export type EnvironmentContextNumericColumn =
  | "tempMean"
  | "tempMin"
  | "tempMax"
  | "apparentMean"
  | "sunshineSec"
  | "daylightSec"
  | "precipSum"
  | "pressureMean"
  | "pressureDelta"
  | "humidityMean"
  | "cloudMean";

export interface EnvironmentField {
  /** Stable key — the registry signal key AND the correlation channel key. */
  key: string;
  /** The `EnvironmentContext` column this field's daily value comes from. */
  column: EnvironmentContextNumericColumn;
  /** Canonical unit (English, for prose + registry metadata). */
  unit: string;
  /** Stable English display name (the UI localises via `i18nLabelKey`). */
  displayName: string;
  /** Lower-cased phrase the correlation narration ("humanise") reads. */
  narrationLabel: string;
  /** i18n label key resolved by the correlation / settings surfaces. */
  i18nLabelKey: string;
}

/**
 * The exposure fields, ranked by evidence in the W-ENV research review:
 * temperature (sleep / BP / recovery), sunshine + daylight (mood), precipitation
 * (activity), pressure mean + intraday swing (headache/symptom — honestly
 * caveated, optional-strength). All are BEHAVIOUR (lag-source) channels.
 */
export const ENVIRONMENT_FIELDS: readonly EnvironmentField[] = [
  {
    key: "ENV_TEMP_MEAN",
    column: "tempMean",
    unit: "°C",
    displayName: "Daily temperature",
    narrationLabel: "daily temperature",
    i18nLabelKey: "environment.fields.tempMean",
  },
  {
    key: "ENV_TEMP_MIN",
    column: "tempMin",
    unit: "°C",
    displayName: "Overnight low temperature",
    narrationLabel: "overnight low temperature",
    i18nLabelKey: "environment.fields.tempMin",
  },
  {
    key: "ENV_SUNSHINE",
    column: "sunshineSec",
    unit: "h",
    displayName: "Sunshine duration",
    narrationLabel: "sunshine",
    i18nLabelKey: "environment.fields.sunshine",
  },
  {
    key: "ENV_DAYLIGHT",
    column: "daylightSec",
    unit: "h",
    displayName: "Daylight length",
    narrationLabel: "daylight",
    i18nLabelKey: "environment.fields.daylight",
  },
  {
    key: "ENV_PRECIP",
    column: "precipSum",
    unit: "mm",
    displayName: "Precipitation",
    narrationLabel: "precipitation",
    i18nLabelKey: "environment.fields.precip",
  },
  {
    key: "ENV_PRESSURE_MEAN",
    column: "pressureMean",
    unit: "hPa",
    displayName: "Barometric pressure",
    narrationLabel: "barometric pressure",
    i18nLabelKey: "environment.fields.pressureMean",
  },
  {
    key: "ENV_PRESSURE_DELTA",
    column: "pressureDelta",
    unit: "hPa",
    displayName: "Pressure swing",
    narrationLabel: "intraday pressure swing",
    i18nLabelKey: "environment.fields.pressureDelta",
  },
] as const;
