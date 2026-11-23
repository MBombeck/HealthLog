/**
 * The one Vorsorge-reminder list read, shared by `GET
 * /api/measurement-reminders` and the `/care` RSC prefetch wrapper so the
 * two cannot drift in filter, order, or DTO shape — the SSR-seeded cell must
 * be byte-compatible with what the client `queryFn` gets from the wire.
 */
import { prisma } from "@/lib/db";
import {
  toMeasurementReminderDto,
  type MeasurementReminderDtoShape,
} from "@/lib/measurement-reminders/dto";

export async function listMeasurementReminders(
  userId: string,
): Promise<MeasurementReminderDtoShape[]> {
  const reminders = await prisma.measurementReminder.findMany({
    // A booked visit's one-shot reminder rides this same engine with
    // `origin: ENCOUNTER`. It is not a checkup and must not appear on a
    // Vorsorge surface, or the list fills with appointments. Four read
    // sites carry this exclusion; `encounter-reminder-exclusion.test.ts`
    // proves every one of them, and the DTO mapper refuses such a row
    // outright so a site that lost its filter fails loudly.
    where: { userId, deletedAt: null, origin: { not: "ENCOUNTER" } },
    // Most-urgent first; a null next-due (uncomputable / disabled) sinks
    // to the end so the actionable items float to the top.
    orderBy: [
      { nextDueAt: { sort: "asc", nulls: "last" } },
      { createdAt: "asc" },
    ],
  });
  return reminders.map(toMeasurementReminderDto);
}
