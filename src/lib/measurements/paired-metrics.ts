/**
 * Metrics stored as separate measurement types that only mean something
 * together: one reading, several components. Blood pressure is the one today,
 * a systolic and a diastolic row per reading.
 *
 * Every per-type computation (the usual-range band, the latest reading) stays
 * per component and never pools them: a band over systolic and diastolic
 * values together describes no blood pressure anyone has. A surface that
 * speaks for the metric names every component, in this order, each with its
 * own figures. Client-safe: no server imports.
 */
export interface PairedMetric {
  /** The component types, in the order a reading is written (120/80). */
  components: readonly [string, string];
  /** i18n key of each component's short name, by type. */
  labelKeys: Readonly<Record<string, string>>;
}

export const BLOOD_PRESSURE_PAIR: PairedMetric = {
  components: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
  labelKeys: {
    BLOOD_PRESSURE_SYS: "charts.systolic",
    BLOOD_PRESSURE_DIA: "charts.diastolic",
  },
};

export const PAIRED_METRICS: readonly PairedMetric[] = [BLOOD_PRESSURE_PAIR];

/** The pair a type is a component of, or null for a standalone metric. */
export function pairOf(type: string): PairedMetric | null {
  return PAIRED_METRICS.find((p) => p.components.includes(type)) ?? null;
}
