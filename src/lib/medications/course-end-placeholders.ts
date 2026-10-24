/**
 * #1280 — the pending placeholders an "End course" took, given back when the
 * End is taken back. Called by the one writer of a medication's window
 * (`project` in `courses.ts`) whenever the instant it carried goes away.
 */
import type { Prisma } from "@/generated/prisma/client";
import { isInsideCourses } from "@/lib/medications/course-window";
import { userDayKey } from "@/lib/tz/format";

/**
 * #1280 — undo what an "End course" did to the pending placeholders.
 *
 * The End tombstones every pending placeholder at or after its instant, and
 * stamps them with that instant (`deletedAt = endedAt`), so the rows it took
 * are exactly the pending ones carrying it. Once the instant is gone, the
 * slots those rows held are inside the course again, but a tombstoned row
 * keeps its unique slot: the today projector treats it as present and never
 * mints a new one, so the dose would be neither listed, reminded nor missed.
 *
 * So they come back, each one only while the slot is inside the courses as
 * they now stand (an end moved to an earlier day keeps them gone) and while
 * no live row already holds the slot (a dose logged for it after the End).
 * `syncVersion` moves so the clients' sync sees them return.
 */
export async function reviveEndedPlaceholders(
  tx: Prisma.TransactionClient,
  args: {
    userId: string;
    medicationId: string;
    endedAt: Date;
    courses: readonly {
      startsOn: Date;
      endsOn: Date | null;
      endedAt: Date | null;
    }[];
    timeZone: string;
  },
): Promise<void> {
  const dropped = await tx.medicationIntakeEvent.findMany({
    where: {
      userId: args.userId,
      medicationId: args.medicationId,
      deletedAt: args.endedAt,
      takenAt: null,
      skipped: false,
      autoMissed: false,
      scheduledFor: { gte: args.endedAt },
    },
    select: { id: true, scheduledFor: true },
  });
  if (dropped.length === 0) return;
  const held = await tx.medicationIntakeEvent.findMany({
    where: {
      medicationId: args.medicationId,
      deletedAt: null,
      scheduledFor: { in: dropped.map((r) => r.scheduledFor) },
    },
    select: { scheduledFor: true },
  });
  const taken = new Set(held.map((r) => r.scheduledFor.getTime()));
  const ids = dropped
    .filter(
      (r) =>
        !taken.has(r.scheduledFor.getTime()) &&
        isInsideCourses(
          userDayKey(r.scheduledFor, args.timeZone),
          args.courses,
          r.scheduledFor,
        ),
    )
    .map((r) => r.id);
  if (ids.length === 0) return;
  await tx.medicationIntakeEvent.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: null, syncVersion: { increment: 1 } },
  });
}
