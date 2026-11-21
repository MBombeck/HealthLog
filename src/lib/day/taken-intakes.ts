/**
 * The day's taken doses as intake events: the one reader the medications
 * section of `GET /api/day/{date}` and the `doseOffset` of
 * `GET /api/symptoms/events` share, so both place a symptom against the
 * same doses.
 */
import { prisma } from "@/lib/db";
import type { DayEvent } from "@/lib/day/contract";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";

/**
 * The doses taken inside each `[from, to)` window, as the medications
 * section shows them: tracked medications only, skips and deleted rows left
 * out, oldest first. The day reads one window; the symptom list reads the
 * local days its page touches in one query.
 */
export async function readTakenIntakeEvents(
  userId: string,
  windows: readonly { from: Date; to: Date }[],
): Promise<DayEvent[]> {
  if (windows.length === 0) return [];
  const rows = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      deletedAt: null,
      skipped: false,
      OR: windows.map((w) => ({ takenAt: { gte: w.from, lt: w.to } })),
      ...TRACKED_INTAKE_EVENT_WHERE,
    },
    select: {
      id: true,
      medicationId: true,
      takenAt: true,
      doseTaken: true,
      medication: { select: { name: true, dose: true } },
    },
    orderBy: [{ takenAt: "asc" }, { id: "asc" }],
  });
  return rows.map((intake) => ({
    at: intake.takenAt ? intake.takenAt.toISOString() : null,
    kind: "intake",
    section: "medications",
    id: intake.id,
    title: intake.medication.name,
    meta: intake.doseTaken ?? intake.medication.dose,
    note: null,
    docs: [],
    href: `/medications/${intake.medicationId}/history`,
  }));
}
