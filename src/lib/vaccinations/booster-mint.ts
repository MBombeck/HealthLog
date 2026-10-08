/**
 * Rung 2: mint the booster reminder a logged dose suggests — the writer half of
 * `MeasurementReminder.vaccinationAntigen`, whose reader is the Phase 1 satisfy
 * matcher.
 *
 * This is rung 2 exactly: the reminder is prefilled and only exists because the
 * person confirmed it. The catalogue's booster interval seeds a due date the
 * user can edit or decline; this module writes what they confirmed. It never
 * computes what a person is due — that would be rung 3, a different venture.
 *
 * ── An ordinary Vorsorge reminder ──────────────────────────────────────────
 *
 * The minted row is `origin: VORSORGE` and carries `vaccinationAntigen` as a
 * match key. Everything else — the cron, the digest, `/checkups`, the insights
 * block, `get_preventive_care` — reads it with zero new code, because a booster
 * reminder is the engine's native case. That nativeness is the whole Option-A
 * argument; the column is a key, not a behaviour change, and the published
 * `origin` enum stays two-armed.
 *
 * ── One antigen, at most one minted reminder ───────────────────────────────
 *
 * The idempotence is by `vaccinationAntigen`: if a live reminder already keys
 * on this antigen, a second confirmation RE-ANCHORS it rather than minting a
 * second. The satisfy matcher has usually already re-anchored it during the
 * create, so the common path simply confirms the new due date. Breaking this
 * branch mints a duplicate, which is the watched-red the mint owes (WR-9).
 */
import type { Prisma } from "@/generated/prisma/client";

import { computeReminderNextDueAt } from "@/lib/measurement-reminders/scheduling";
import {
  componentsForDose,
  loadCustomVaccineLookup,
} from "@/lib/vaccinations/resolve-vaccine-entry";

/** What the confirm carries. All three are the user's edited-or-accepted values. */
export interface BoosterMintInput {
  vaccinationId: string;
  /** Months between doses, as confirmed. Converted to a rolling day interval. */
  intervalMonths: number;
  /** The reminder label, composed and editable client-side. */
  label: string;
  notifyHour?: number;
}

export type BoosterMintResult =
  | { outcome: "unknown-record" }
  | { outcome: "no-antigen" }
  | { outcome: "minted" | "reanchored"; reminderId: string; antigen: string };

/** The reminder engine's hard ceiling on a rolling interval (ten years). */
const MAX_INTERVAL_DAYS = 3650;

const DAYS_PER_MONTH = 30.4375;

/**
 * A booster reminder is a ROLLING cadence, not an absolute calendar rule.
 *
 * This is the whole reason it uses `intervalDays` rather than an rrule: a
 * rolling interval re-anchors on `lastSatisfiedAt`, so logging the next dose
 * moves the due date forward — the activity-aware loop the satisfy matcher
 * closes. An rrule's occurrences are fixed dates, so satisfying one would
 * leave the same due date standing. The months are converted to days and
 * capped at the engine's ten-year ceiling, which is exactly a decade booster.
 */
function cadenceDays(intervalMonths: number): number {
  return Math.min(
    MAX_INTERVAL_DAYS,
    Math.round(intervalMonths * DAYS_PER_MONTH),
  );
}

/**
 * Mint the booster reminder for a dose, or re-anchor the one that already keys
 * on its antigen. Runs in the caller's transaction so the reminder and the
 * `reminderId` stamp commit together.
 */
export async function mintOrReanchorBooster(
  tx: Prisma.TransactionClient,
  userId: string,
  input: BoosterMintInput,
  timezone: string,
): Promise<BoosterMintResult> {
  const record = await tx.vaccinationRecord.findFirst({
    where: { id: input.vaccinationId, userId, deletedAt: null },
    select: {
      id: true,
      antigenSlug: true,
      customVaccineId: true,
      occurredAt: true,
    },
  });
  if (!record) return { outcome: "unknown-record" };

  // The reminder keys on the dose's PRIMARY component antigen — for a Tdap that
  // is tetanus, for the person's own definition the first antigen it lists. A
  // person who tracks the components separately can mint further reminders by
  // hand; the offer covers the one the interval belongs to.
  const [antigen] = componentsForDose(
    record,
    record.customVaccineId
      ? await loadCustomVaccineLookup(tx, userId)
      : undefined,
  );
  if (!antigen) return { outcome: "no-antigen" };

  const notifyHour = input.notifyHour ?? 9;
  const intervalDays = cadenceDays(input.intervalMonths);
  const now = new Date();
  // The FIRST booster is due one interval after the dose, so the anchor is the
  // dose date plus the interval — a never-satisfied rolling reminder is due at
  // its anchor, and the dose date itself is not when the next shot is due. Once
  // the person logs that next dose, `satisfyReminder` re-anchors on the satisfy
  // instant and this anchor no longer matters.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const anchorDate = new Date(
    record.occurredAt.getTime() + intervalDays * DAY_MS,
  );
  const nextDueAt = computeReminderNextDueAt(
    {
      intervalDays,
      rrule: null,
      anchorDate,
      notifyHour,
      lastSatisfiedAt: null,
      createdAt: now,
    },
    timezone,
    now,
  );

  // One antigen, at most one minted reminder. A live row keyed on this antigen
  // is re-anchored, never duplicated.
  const existing = await tx.measurementReminder.findFirst({
    where: { userId, deletedAt: null, vaccinationAntigen: antigen },
    select: { id: true },
  });

  if (existing) {
    await tx.measurementReminder.update({
      where: { id: existing.id },
      data: {
        label: input.label,
        intervalDays,
        rrule: null,
        anchorDate,
        notifyHour,
        nextDueAt,
      },
    });
    await tx.vaccinationRecord.update({
      where: { id: record.id },
      data: { reminderId: existing.id },
    });
    return { outcome: "reanchored", reminderId: existing.id, antigen };
  }

  const created = await tx.measurementReminder.create({
    data: {
      userId,
      label: input.label,
      origin: "VORSORGE",
      vaccinationAntigen: antigen,
      measurementType: null,
      intervalDays,
      rrule: null,
      anchorDate,
      notifyHour,
      location: null,
      enabled: true,
      nextDueAt,
    },
    select: { id: true },
  });
  await tx.vaccinationRecord.update({
    where: { id: record.id },
    data: { reminderId: created.id },
  });
  return { outcome: "minted", reminderId: created.id, antigen };
}
