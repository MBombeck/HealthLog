/**
 * When a typed reading is far enough from the person's own last one to ask
 * "is that right?". A hint, never a block: the plausibility band in
 * `value-ranges.ts` is what refuses a value, this only catches the "8.23"
 * typed for "82.3" that the band lets through.
 *
 * Compared in the stored (canonical) unit, so the table holds one number per
 * type whatever the reader's unit system. A type that is not listed gets no
 * hint: steps, sleep, glucose and pain move by large amounts from one
 * reading to the next as a matter of course, so a threshold there would
 * mostly cry wolf.
 *
 * | Type                               | Hint when the change exceeds |
 * | ---------------------------------- | ---------------------------- |
 * | Weight                             | 10 %                         |
 * | Body water, bone, fat, lean, muscle mass | 15 %                   |
 * | Body fat                           | 8 percentage points          |
 * | Systolic, diastolic                | 30 %                         |
 * | Pulse                              | 50 %                         |
 * | Resting heart rate                 | 30 %                         |
 * | Oxygen saturation                  | 6 percentage points          |
 * | Body temperature                   | 1.5 °C                       |
 * | Waist circumference                | 10 %                         |
 * | Grip strength                      | 30 %                         |
 */

import { ownValue } from "@/lib/own-key";

type Threshold = { relative: number } | { absolute: number };

export const LAST_VALUE_DEVIATION: Readonly<Record<string, Threshold>> = {
  WEIGHT: { relative: 0.1 },
  TOTAL_BODY_WATER: { relative: 0.15 },
  BONE_MASS: { relative: 0.15 },
  FAT_MASS: { relative: 0.15 },
  FAT_FREE_MASS: { relative: 0.15 },
  LEAN_BODY_MASS: { relative: 0.15 },
  MUSCLE_MASS: { relative: 0.15 },
  BODY_FAT: { absolute: 8 },
  BLOOD_PRESSURE_SYS: { relative: 0.3 },
  BLOOD_PRESSURE_DIA: { relative: 0.3 },
  PULSE: { relative: 0.5 },
  RESTING_HEART_RATE: { relative: 0.3 },
  OXYGEN_SATURATION: { absolute: 6 },
  BODY_TEMPERATURE: { absolute: 1.5 },
  WAIST_CIRCUMFERENCE: { relative: 0.1 },
  GRIP_STRENGTH: { relative: 0.3 },
};

/** True when `value` differs from `last` by more than the type's threshold. */
export function deviatesFromLast(
  type: string,
  value: number,
  last: number | null | undefined,
): boolean {
  const threshold = ownValue(LAST_VALUE_DEVIATION, type);
  if (!threshold || last == null) return false;
  if (!Number.isFinite(value) || !Number.isFinite(last)) return false;
  const delta = Math.abs(value - last);
  if ("absolute" in threshold) return delta > threshold.absolute;
  if (last === 0) return false;
  return delta / Math.abs(last) > threshold.relative;
}
