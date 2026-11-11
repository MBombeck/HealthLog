/**
 * The medications the Telegram bot may offer a dose for or record one
 * against: the `/add` list, the "taken" keyword, and the reminder buttons.
 *
 * Active and with intake tracked, as every bot path has asked since #1033,
 * and two conditions the bot used to skip:
 *
 *   - The Medications module is on. With it off the web shows no medication
 *     surface and the reminder jobs send nothing, so the bot offers and books
 *     nothing either; re-enabling the module finds every row where it was.
 *   - The course has not ended on the person's clock (`courseStatusAt`). The
 *     web card stops offering a dose then, and a dose booked through the bot
 *     after the end would take a unit off the stock. A course that has not
 *     started yet is left to the bot as before.
 *
 * A paused medication is `active: false` (pausing writes both), so the
 * `active` filter already keeps it out.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/gate";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import {
  MEDICATION_WINDOW_SELECT,
  courseStatusAt,
} from "@/lib/medications/course-window";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

const DOSE_MEDICATION_SELECT = {
  id: true,
  name: true,
  dose: true,
  ...MEDICATION_WINDOW_SELECT,
} as const;

function courseEnded(
  medication: {
    startsOn: Date | null;
    endsOn: Date | null;
    endedAt: Date | null;
  },
  timeZone: string | null,
): boolean {
  return (
    courseStatusAt(medication, new Date(), timeZone || DEFAULT_TIMEZONE) ===
    "ENDED"
  );
}

/** Every medication the person may pick a dose from, by name. */
export async function listTelegramDoseMedications(
  userId: string,
  timeZone: string | null,
) {
  if (!(await isModuleEnabled(userId, "medications"))) return [];
  const medications = await prisma.medication.findMany({
    where: { userId, active: true, ...TRACKED_INTAKE_WHERE },
    select: DOSE_MEDICATION_SELECT,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return medications.filter((m) => !courseEnded(m, timeZone));
}

/** The one medication `where` names, or null when the bot may not act on it. */
export async function findTelegramDoseMedication(
  userId: string,
  timeZone: string | null,
  where: Prisma.MedicationWhereInput,
) {
  if (!(await isModuleEnabled(userId, "medications"))) return null;
  const medication = await prisma.medication.findFirst({
    where: { ...where, userId, active: true, ...TRACKED_INTAKE_WHERE },
    select: DOSE_MEDICATION_SELECT,
  });
  return medication && !courseEnded(medication, timeZone) ? medication : null;
}
