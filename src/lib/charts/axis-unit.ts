/**
 * The unit suffix a chart axis appends to each tick value ("62 bpm").
 *
 * Joined with a no-break space, never a plain one. Recharts word-wraps a
 * tick label that is wider than the axis, and it measures the label in the
 * page's body font rather than the tick's own 11 px, so "62 bpm" and
 * "106 mg/dL" measured wider than their axis and broke onto two lines on
 * every screen. The second line dropped onto the first x tick. A label with
 * no breaking space is one word and stays on one line.
 */
export function axisUnitSuffix(
  unit: string | null | undefined,
): string | undefined {
  // A space inside the unit ("/ 5") would break the label the same way.
  return unit ? ` ${unit.replace(/ /g, "\u00a0")}` : undefined;
}

/**
 * The longest unit a tick label carries. A word-length unit ("Schritte",
 * "Atemzüge/min", "mL/(kg·min)") made every tick wider than the fixed y-axis
 * gutter, and the label was clipped at its left edge (".744 Schritte"). Such
 * a unit stays off the ticks; the stat strip and the tile above the chart
 * already name it.
 */
export const MAX_TICK_UNIT_LENGTH = 5;

/** The tick suffix for `unit`, or none when the unit is too long to fit. */
export function axisTickUnitSuffix(
  unit: string | null | undefined,
): string | undefined {
  if (!unit || unit.length > MAX_TICK_UNIT_LENGTH) return undefined;
  return axisUnitSuffix(unit);
}
