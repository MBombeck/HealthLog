/**
 * The safety-floor facts of the morning read (`morning.ts`, rank 0 and the
 * unconfirmed reading of rank 3): which reading of the last 24 hours is past
 * a floor. Pure; the loader reads the window, the builder words it.
 */
import {
  BP_DIA_CRITICAL,
  BP_SYS_CRITICAL,
  BP_SYS_HYPOTENSIVE_FLOOR,
  GLUCOSE_HYPER_FLOOR,
  GLUCOSE_HYPO_FLOOR,
  GLUCOSE_HYPO_SEVERE_FLOOR,
} from "@/lib/clinical-floors";

/** A confirmed safety-floor breach from the last 24 hours. */
export interface MorningFloor {
  reason:
    | "bp_hypertensive"
    | "bp_hypotensive"
    | "glucose_hypo"
    | "glucose_hypo_severe"
    | "glucose_hyper";
  /** The breaching reading in the reader's units ("182/121 mmHg"). */
  valueLabel: string;
}

/** The floor reasons, in the order an unconfirmed reading is named. */
const FLOOR_ORDER: readonly MorningFloor["reason"][] = [
  "bp_hypertensive",
  "glucose_hypo_severe",
  "glucose_hypo",
  "glucose_hyper",
  "bp_hypotensive",
];

/** The readings of the floor window, canonical units (mmHg, mg/dL). */
export interface FloorWindowReadings {
  bp: readonly { sys: number; dia: number }[];
  glucose: readonly number[];
}

/**
 * The reading past a safety floor in the window, the most extreme one in the
 * floor's direction: for `reason` when the ledger confirmed one, else for the
 * first floor any reading crosses. Null when no reading crosses it (deleted
 * since, or the window holds none): the sentence names a value or does not
 * speak. Pure.
 */
export function floorFromReadings(
  readings: FloorWindowReadings,
  reason: MorningFloor["reason"] | null,
  glucoseLabel: (mgdl: number) => string,
): MorningFloor | null {
  for (const r of reason ? [reason] : FLOOR_ORDER) {
    if (r === "bp_hypertensive" || r === "bp_hypotensive") {
      const breaching =
        r === "bp_hypertensive"
          ? readings.bp
              .filter(
                (p) => p.sys >= BP_SYS_CRITICAL || p.dia >= BP_DIA_CRITICAL,
              )
              .sort((a, b) => b.sys - a.sys || b.dia - a.dia)
          : readings.bp
              .filter((p) => p.sys < BP_SYS_HYPOTENSIVE_FLOOR)
              .sort((a, b) => a.sys - b.sys);
      const worst = breaching[0];
      if (worst) {
        return {
          reason: r,
          valueLabel: `${Math.round(worst.sys)}/${Math.round(worst.dia)} mmHg`,
        };
      }
      continue;
    }
    const low = r !== "glucose_hyper";
    const floorValue =
      r === "glucose_hypo_severe"
        ? GLUCOSE_HYPO_SEVERE_FLOOR
        : r === "glucose_hypo"
          ? GLUCOSE_HYPO_FLOOR
          : GLUCOSE_HYPER_FLOOR;
    const breaching = readings.glucose.filter((v) =>
      low ? v < floorValue : v >= floorValue,
    );
    if (breaching.length > 0) {
      const worst = low ? Math.min(...breaching) : Math.max(...breaching);
      return { reason: r, valueLabel: glucoseLabel(worst) };
    }
  }
  return null;
}
