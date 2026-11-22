/**
 * Where a symptom or a seizure sits against the day's doses: "2 h 10 min
 * after Metformin".
 *
 * A person whose medication timing matters notes a symptom's onset or relief
 * and wants to see it against the dose they took that day. This states the
 * distance in time and nothing else: no cause, no verdict, no "because of".
 *
 * The anchor is the nearest dose taken at or before the symptom. When the
 * day holds no earlier dose, it is the nearest one after it, as a negative
 * distance ("40 min before"). Only intakes with a taken time count, and only
 * the day's own events, so a dose on another day never anchors a symptom and
 * a switched-off medications section takes the offsets with it.
 *
 * Pure: it reads the day's assembled events.
 */
import type { DayEvent } from "./contract";

/** The event kinds placed against the day's doses. */
export const DOSE_OFFSET_KINDS: ReadonlySet<DayEvent["kind"]> = new Set([
  "symptom",
  "seizure",
]);

export function withDoseOffsets(events: readonly DayEvent[]): DayEvent[] {
  const doses = events
    .filter((e) => e.kind === "intake" && e.at !== null)
    .map((e) => ({ event: e, ms: Date.parse(e.at!) }))
    .sort((a, b) => a.ms - b.ms);
  if (doses.length === 0) return [...events];
  return events.map((e) => {
    if (!DOSE_OFFSET_KINDS.has(e.kind) || e.at === null) return e;
    const at = Date.parse(e.at);
    const before = doses.filter((d) => d.ms <= at).at(-1);
    const anchor = before ?? doses.find((d) => d.ms > at)!;
    return {
      ...e,
      doseOffset: {
        intakeId: anchor.event.id,
        title: anchor.event.title,
        minutes: Math.round((at - anchor.ms) / 60_000),
      },
    };
  });
}
