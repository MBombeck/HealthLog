/**
 * Logging a dose clears the booster reminders it answers.
 *
 * This is the reader half of `MeasurementReminder.vaccinationAntigen`, and the
 * whole of it. The writer — the booster mint, which is rung 2: prefilled,
 * user-confirmed, editable, declinable — lands with the capture surface. The
 * column is a match key and nothing else: no cron query changes, no reminder
 * DTO field, no new queue, no new notification event type, no new preference,
 * and the published `origin` enum still reads `["VORSORGE","COACH"]`. A
 * booster reminder is an ordinary preventive-care row that happens to say
 * which antigen would settle it.
 *
 * ── Why components, not the slug ───────────────────────────────────────────
 *
 * A reminder is keyed by an ANTIGEN. A dose is recorded as whatever
 * preparation the person was given, which is usually a combination. Matching
 * the record's own slug against the reminder's key would mean a Tdap dose left
 * a tetanus booster standing, which is the named failure mode of this whole
 * design. So the dose is expanded to its component antigens first, and every
 * reminder any of them matches is satisfied.
 *
 * A free-text-only dose matches nothing. Nothing here reads `vaccineName`: a
 * name string is not evidence about which antigens were in the syringe, and a
 * booster cleared by a guess is worse than a booster not cleared at all. A
 * dose logged against the person's own vaccine definition (v1.42, #1005)
 * counts its listed antigens, the same way a catalogue combination does.
 *
 * ── Cold path only ─────────────────────────────────────────────────────────
 *
 * It runs inside the create transaction of `POST /api/vaccinations` and
 * nowhere else. Never on a cron, never on an ingest hook, never on an edit —
 * the never-nag query in `src/lib/jobs/measurement-reminder.ts` is untouched
 * by this feature, and PATCH deliberately does not re-run this, because
 * correcting a transcription typo is not a second clinical event.
 *
 * ── The two properties that come from `satisfyReminder` ────────────────────
 *
 * Both are the design rather than an accident, and both have a fixture:
 *
 *   - **Forward-only.** A dose older than the reminder's `lastSatisfiedAt` is
 *     a no-op. Transcribing a 1987 Pass page can never clear a booster that is
 *     due today, which is the property that makes bulk back-entry safe.
 *   - **Re-anchored.** `nextDueAt` recomputes from the satisfy instant, so
 *     logging a tetanus dose from 2019 against a ten-year reminder moves the
 *     due date to 2029 — and logging one old enough that the recomputed date
 *     is already past leaves the reminder due, which is correct. An old dose
 *     does not silence a real gap.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import {
  satisfyReminder,
  type SatisfiableReminder,
} from "@/lib/measurement-reminders/satisfy";
import {
  componentsForDose,
  loadCustomVaccineLookup,
  type VaccineIdentity,
} from "@/lib/vaccinations/resolve-vaccine-entry";

/** What the create route needs back: which reminders moved, and the first. */
export interface BoosterSatisfyResult {
  /** Ids of every reminder this dose advanced, in catalogue component order. */
  satisfiedReminderIds: string[];
  /**
   * The id stamped onto `VaccinationRecord.reminderId`.
   *
   * The first satisfied reminder in catalogue component order, so a Tdap dose
   * that clears a tetanus and a pertussis booster always records the same one
   * rather than whichever the database returned first. The column records ONE
   * act; the engine records them all, in each row's own `lastSatisfiedAt`.
   */
  primaryReminderId: string | null;
}

const EMPTY: BoosterSatisfyResult = {
  satisfiedReminderIds: [],
  primaryReminderId: null,
};

/**
 * Satisfy every live booster reminder this dose answers.
 *
 * Takes the transaction client the create runs in, so the reminder advance and
 * the record insert commit or roll back together: a dose that failed to save
 * must not leave a booster looking settled.
 */
export async function satisfyBoostersForDose(
  tx: Prisma.TransactionClient,
  userId: string,
  identity: VaccineIdentity,
  occurredAt: Date,
  timezone: string,
): Promise<BoosterSatisfyResult> {
  const components = componentsForDose(
    identity,
    identity.customVaccineId
      ? await loadCustomVaccineLookup(tx, userId)
      : undefined,
  );
  if (components.length === 0) return EMPTY;

  const reminders = await tx.measurementReminder.findMany({
    where: {
      userId,
      deletedAt: null,
      // An ordinary Vorsorge reminder carries NULL here and is never touched:
      // the `in` filter cannot match a null, so the fence is structural rather
      // than a condition somebody has to remember.
      vaccinationAntigen: { in: [...components] },
    },
    select: {
      id: true,
      userId: true,
      vaccinationAntigen: true,
      intervalDays: true,
      rrule: true,
      anchorDate: true,
      notifyHour: true,
      nextDueAt: true,
      lastSatisfiedAt: true,
      lastSkippedAt: true,
      createdAt: true,
    },
  });
  if (reminders.length === 0) return EMPTY;

  // Deterministic: catalogue component order, then id, so two reminders for
  // the same antigen still resolve to a stable primary.
  const rank = new Map(components.map((antigen, index) => [antigen, index]));
  const ordered = [...reminders].sort((a, b) => {
    const byAntigen =
      (rank.get(a.vaccinationAntigen as never) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.vaccinationAntigen as never) ?? Number.MAX_SAFE_INTEGER);
    return byAntigen !== 0 ? byAntigen : a.id.localeCompare(b.id);
  });

  const satisfiedReminderIds: string[] = [];
  for (const reminder of ordered) {
    const row: SatisfiableReminder = {
      id: reminder.id,
      userId: reminder.userId,
      intervalDays: reminder.intervalDays,
      rrule: reminder.rrule,
      anchorDate: reminder.anchorDate,
      notifyHour: reminder.notifyHour,
      nextDueAt: reminder.nextDueAt,
      lastSatisfiedAt: reminder.lastSatisfiedAt,
      lastSkippedAt: reminder.lastSkippedAt,
      createdAt: reminder.createdAt,
    };
    // `satisfyReminder` types its client as the full `PrismaClient` because
    // every other caller hands it one; the only member it touches is
    // `measurementReminder.updateMany`, which a transaction client has. The
    // cast is confined to this line so the advance stays inside the create
    // transaction rather than committing on its own.
    const result = await satisfyReminder(
      tx as unknown as PrismaClient,
      row,
      timezone,
      occurredAt,
      "vaccination",
    );
    if (result.satisfied) satisfiedReminderIds.push(reminder.id);
  }

  return {
    satisfiedReminderIds,
    primaryReminderId: satisfiedReminderIds[0] ?? null,
  };
}
