/**
 * Decimal places a vital reading is shown at, in the unit it is shown in.
 *
 * The transform's own `decimals` covers the converted units (lb, °F,
 * mmol/L); body temperature and weight read at one decimal; the rest
 * (pulse, blood pressure, HRV, SpO2, respiratory rate, the cumulative
 * same-hours metrics) are whole numbers on every device and in every chart
 * that shows them.
 *
 * One answer for every server-side text that prints a vital or a difference
 * of one: the Today overview's value and range labels, the signals of the
 * day the briefing prompt is given, and the delta under the hero lead. A
 * difference is read at the precision of the readings it was taken from, so
 * "+34 bpm", never "+33.72 bpm".
 */
export function vitalDisplayDecimals(
  type: string,
  transformDecimals: number,
): number {
  switch (type) {
    case "BODY_TEMPERATURE":
    case "SKIN_TEMPERATURE":
    case "WEIGHT":
      return 1;
    case "BLOOD_GLUCOSE":
      return transformDecimals;
    default:
      return 0;
  }
}

/** Round to `decimals` fraction digits. Non-finite input passes through. */
export function roundToDisplay(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
