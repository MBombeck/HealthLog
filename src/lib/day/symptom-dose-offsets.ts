/**
 * `doseOffset` for a list of symptom occurrences (`GET /api/symptoms/events`),
 * computed the way the day computes it.
 *
 * Each occurrence belongs to the local day of the record's zone, as on
 * `GET /api/day/{date}`. The doses of every day the list touches come from
 * one query (`readTakenIntakeEvents`, the medications section's own reader,
 * adjacent days merged into one window), and each day's symptoms and doses
 * then go through `withDoseOffsets`, the function the day uses. There is no
 * second rule here: an occurrence carries the offset the day view shows for
 * it, and none when the day shows none.
 */
import type { DayEvent } from "@/lib/day/contract";
import { withDoseOffsets } from "@/lib/day/dose-offsets";
import { readTakenIntakeEvents } from "@/lib/day/taken-intakes";
import { userDayKey } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";

export type SymptomDoseOffset = NonNullable<DayEvent["doseOffset"]>;

/** Local day windows, sorted, with touching days merged. */
function mergedWindows(
  days: readonly string[],
  tz: string,
): { from: Date; to: Date }[] {
  const windows = [...days].sort().map((day) => {
    const { dayStart, dayEnd } = localDayWindow(day, tz);
    return { from: dayStart, to: dayEnd };
  });
  const merged: { from: Date; to: Date }[] = [];
  for (const w of windows) {
    const last = merged.at(-1);
    if (last && last.to.getTime() >= w.from.getTime()) {
      if (w.to > last.to) last.to = w.to;
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

export async function symptomDoseOffsets(args: {
  userId: string;
  tz: string;
  occurrences: readonly { id: string; occurredAt: Date }[];
}): Promise<Map<string, SymptomDoseOffset>> {
  const { userId, tz, occurrences } = args;
  const out = new Map<string, SymptomDoseOffset>();
  if (occurrences.length === 0) return out;

  const symptomsByDay = new Map<string, DayEvent[]>();
  for (const o of occurrences) {
    const day = userDayKey(o.occurredAt, tz);
    const symptom: DayEvent = {
      at: o.occurredAt.toISOString(),
      kind: "symptom",
      section: "symptoms",
      id: o.id,
      title: "",
      meta: null,
      note: null,
      docs: [],
      href: "/illness",
    };
    const bucket = symptomsByDay.get(day);
    if (bucket) bucket.push(symptom);
    else symptomsByDay.set(day, [symptom]);
  }

  const intakes = await readTakenIntakeEvents(
    userId,
    mergedWindows([...symptomsByDay.keys()], tz),
  );
  const intakesByDay = new Map<string, DayEvent[]>();
  for (const intake of intakes) {
    if (intake.at === null) continue;
    const day = userDayKey(new Date(intake.at), tz);
    if (!symptomsByDay.has(day)) continue;
    const bucket = intakesByDay.get(day);
    if (bucket) bucket.push(intake);
    else intakesByDay.set(day, [intake]);
  }

  for (const [day, symptoms] of symptomsByDay) {
    const doses = intakesByDay.get(day);
    if (!doses) continue;
    for (const e of withDoseOffsets([...doses, ...symptoms])) {
      if (e.kind === "symptom" && e.doseOffset) out.set(e.id, e.doseOffset);
    }
  }
  return out;
}
