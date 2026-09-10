/**
 * The work the encounter routes share: resolving a visit, wiring its links,
 * and keeping its appointment reminder in step with its status.
 *
 * Lives beside the routes rather than inside one of them because create and
 * edit both do most of it, and a copy in each is how the two drift.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import {
  satisfyReminder,
  type SatisfiableReminder,
} from "@/lib/measurement-reminders/satisfy";
import {
  listTargets,
  listTargetsBySource,
  replaceTargets,
  type LinkTargetKind,
} from "@/lib/links";
import type { ShareDomain } from "@/lib/sharing/scope";
import type { EncounterLinksDTO } from "@/lib/encounters/dto";
import {
  deleteAppointmentReminder,
  disableAppointmentReminder,
  mintAppointmentReminder,
  reanchorAppointmentReminder,
  type AppointmentReminderInput,
} from "@/lib/encounters/appointment-reminder";

const DEFAULT_TIMEZONE = "Europe/Berlin";

/**
 * The record owner's zone AND language, read together.
 *
 * Both are properties of the RECORD rather than of whoever is acting on it: a
 * delegate booking an appointment in somebody else's record produces a nudge
 * that rings on the owner's phone, at the owner's hour, in the owner's
 * language. Reading the actor's locale here would localise a stranger's
 * notification into the helper's tongue.
 */
export async function resolveOwnerNotificationContext(
  userId: string,
): Promise<{ timezone: string; locale: string | null }> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true, locale: true },
  });
  return {
    timezone: row?.timezone || DEFAULT_TIMEZONE,
    locale: row?.locale ?? null,
  };
}

/** The relations the detail and list responses resolve. */
export const ENCOUNTER_INCLUDE = {
  practitioner: true,
  reminder: { select: { nextDueAt: true } },
} as const satisfies Prisma.EncounterInclude;

/**
 * Which section of the record each link family's TARGET belongs to.
 *
 * Exhaustive over `LinkTargetKind` by the compiler, so a link kind added to
 * the service cannot reach a visit's link list without somebody deciding which
 * domain governs its names. `encounter` is here for that reason and is never
 * read from this side — a visit does not point at another visit — but a
 * `Partial` here would turn "nobody classified it" into "undefined", and an
 * undefined domain read as a falsy check is a leak.
 */
const TARGET_DOMAIN: Record<LinkTargetKind, ShareDomain> = {
  document: "documents",
  labResult: "labs",
  conditionEpisode: "illness",
  encounter: "profile",
};

/**
 * The three link families, resolved for one visit and redacted per family.
 *
 * A visit is a seam between four domains: it lives in the health background
 * and points at the vault, the lab results and the illness journal. A grant
 * that opened only the health background was never consent for what is on the
 * other side of that seam — and while the VALUES never crossed it (the list
 * carries a label and a date, not a document body or a result), the names are
 * themselves the sensitive part. "Oncology discharge letter" and "Ferritin,
 * 30 June" say most of what the person was worried about.
 *
 * So the name and the date are withheld per family, and the LINK is not: the
 * caller may know the visit produced a lab result, because the visit is theirs
 * to read. `label: null` rather than an invented placeholder, so an absence
 * reads as an absence; the array an entry sits in already carries the kind, so
 * a client renders "a linked lab result" from its own bundle without the
 * server shipping prose down the wire.
 *
 * Owners and entire-record delegates see everything, so the ordinary case is
 * untouched.
 */
export async function loadEncounterLinks(
  tx: Prisma.TransactionClient,
  userId: string,
  encounterId: string,
  visible: (domain: ShareDomain) => boolean,
): Promise<EncounterLinksDTO> {
  const read = async (targetKind: LinkTargetKind) => {
    const rows = await listTargets(tx, {
      userId,
      sourceKind: "encounter",
      sourceId: encounterId,
      targetKind,
    });
    if (visible(TARGET_DOMAIN[targetKind])) {
      return rows.map((row) => ({ ...row, redacted: false }));
    }
    return rows.map((row) => ({
      id: row.id,
      label: null,
      date: null,
      redacted: true,
    }));
  };
  const [documents, labResults, conditions] = await Promise.all([
    read("document"),
    read("labResult"),
    read("conditionEpisode"),
  ]);
  return { documents, labResults, conditions };
}

/**
 * The same three families for a PAGE of visits, in three grouped queries.
 *
 * Two grouped reads per family rather than two per visit — `listTargetsBySource`
 * is the batched arm of the same service, so the list pays six round trips for
 * a page instead of six per row.
 *
 * The list carries links for two reasons that are both defects when it does
 * not. The card shows counts of what a visit produced, and a card reading zero
 * for a visit with three documents is a lie the person cannot see past. And the
 * edit sheet seeds its pickers from the row it was handed: an edit opened from a
 * list row that did not know its links would save a replace-set of three empty
 * arrays and silently unfile everything the visit had collected.
 *
 * Redaction is the same rule, applied per family, from the same predicate.
 */
export async function loadEncounterLinksForMany(
  tx: Prisma.TransactionClient,
  userId: string,
  encounterIds: string[],
  visible: (domain: ShareDomain) => boolean,
): Promise<Map<string, EncounterLinksDTO>> {
  const out = new Map<string, EncounterLinksDTO>();
  if (encounterIds.length === 0) return out;

  const read = async (targetKind: LinkTargetKind) =>
    listTargetsBySource(tx, {
      userId,
      sourceKind: "encounter",
      sourceIds: encounterIds,
      targetKind,
    });
  const [documents, labResults, conditions] = await Promise.all([
    read("document"),
    read("labResult"),
    read("conditionEpisode"),
  ]);

  const family = (
    map: Map<string, { id: string; label: string; date: string | null }[]>,
    id: string,
    targetKind: LinkTargetKind,
  ) => {
    const rows = map.get(id) ?? [];
    if (visible(TARGET_DOMAIN[targetKind])) {
      return rows.map((row) => ({ ...row, redacted: false }));
    }
    return rows.map((row) => ({
      id: row.id,
      label: null,
      date: null,
      redacted: true,
    }));
  };

  for (const id of encounterIds) {
    out.set(id, {
      documents: family(documents, id, "document"),
      labResults: family(labResults, id, "labResult"),
      conditions: family(conditions, id, "conditionEpisode"),
    });
  }
  return out;
}

/**
 * Apply whichever of the three link arrays the request actually named.
 *
 * An absent array leaves that family alone; a present one replaces it, empty
 * array included. Unknown ids are dropped by the link service and never block
 * the save — a visit is never refused because one document it pointed at has
 * since been deleted.
 */
export async function applyEncounterLinks(
  tx: Prisma.TransactionClient,
  userId: string,
  encounterId: string,
  arrays: {
    documentIds?: string[];
    labResultIds?: string[];
    episodeIds?: string[];
  },
): Promise<void> {
  const families: Array<[LinkTargetKind, string[] | undefined]> = [
    ["document", arrays.documentIds],
    ["labResult", arrays.labResultIds],
    ["conditionEpisode", arrays.episodeIds],
  ];
  for (const [targetKind, targetIds] of families) {
    if (targetIds === undefined) continue;
    await replaceTargets(tx, {
      userId,
      sourceKind: "encounter",
      sourceId: encounterId,
      targetKind,
      targetIds,
    });
  }
}

/**
 * Whether a visit in this state, at this instant, should be nudging.
 *
 * Only a PLANNED visit in the future does. A visit that already happened needs
 * no reminder, and a terminal one must not produce a nudge for an appointment
 * that is not going to occur.
 */
export function shouldHaveReminder(
  status: string,
  occurredAt: Date,
  now: Date,
): boolean {
  return status === "PLANNED" && occurredAt.getTime() > now.getTime();
}

export interface ReminderSyncInput extends AppointmentReminderInput {
  status: string;
  /**
   * The APPOINTMENT reminder this visit already owns, or null.
   *
   * Never a checkup the visit closes. `Encounter.reminderId` carries either
   * one, and the two are kept apart by their origin: an appointment reminder
   * is `ENCOUNTER`, a checkup is not. Confusing them would re-anchor a
   * person's own Vorsorge cadence onto an appointment date, which is why the
   * routes resolve the origin before calling this.
   */
  existingReminderId: string | null;
}

/**
 * Bring the visit's appointment reminder in line with the visit.
 *
 * Returns the id to store on `Encounter.reminderId` — the existing one, a
 * freshly minted one, or the existing one left in place but switched off.
 * Never mints a second row for a visit that already has one.
 */
export async function syncAppointmentReminder(
  tx: Prisma.TransactionClient,
  input: ReminderSyncInput,
  timezone: string,
  now: Date,
): Promise<string | null> {
  const wanted = shouldHaveReminder(input.status, input.occurredAt, now);

  if (!wanted) {
    // The row stays — the history of a cancelled appointment is worth keeping —
    // but it stops nudging.
    if (input.existingReminderId) {
      await disableAppointmentReminder(tx, input.existingReminderId);
    }
    return input.existingReminderId;
  }

  if (input.existingReminderId) {
    await reanchorAppointmentReminder(
      tx,
      input.existingReminderId,
      input,
      timezone,
    );
    return input.existingReminderId;
  }

  return mintAppointmentReminder(tx, input, timezone);
}

/**
 * The checkup a visit says it closes, re-narrowed to the caller.
 *
 * Refuses an `ENCOUNTER`-origin row outright. Those belong to a booked visit
 * and are not a checkup anybody can close by filing one; accepting it here
 * would let a client re-point one visit's appointment reminder at another
 * visit and re-anchor it on the wrong date.
 *
 * Returns `undefined` when the id names nothing closeable.
 */
export async function resolveClosableReminder(
  tx: Prisma.TransactionClient,
  userId: string,
  reminderId: string,
): Promise<SatisfiableReminder | undefined> {
  const row = await tx.measurementReminder.findUnique({
    where: { id: reminderId },
    select: {
      id: true,
      userId: true,
      origin: true,
      deletedAt: true,
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
  if (!row || row.userId !== userId || row.deletedAt !== null) return undefined;
  if (row.origin === "ENCOUNTER") return undefined;
  return {
    id: row.id,
    userId: row.userId,
    intervalDays: row.intervalDays,
    rrule: row.rrule,
    anchorDate: row.anchorDate,
    notifyHour: row.notifyHour,
    nextDueAt: row.nextDueAt,
    lastSatisfiedAt: row.lastSatisfiedAt,
    lastSkippedAt: row.lastSkippedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Close the checkup a completed visit was filed against.
 *
 * `satisfyReminder` is the one shared primitive the cron, the ingest worker
 * and the explicit user action all route through. There is no second
 * mechanism; the only decision here is WHICH INSTANT to satisfy at.
 *
 * It is the visit's own instant, bounded by now — not `now`. The plan said
 * `now`, and two things it did not anticipate say otherwise:
 *
 *   - **Anchoring.** A yearly panel drawn thirty days ago is next due 335 days
 *     from today, not 365. Satisfying at `now` moves every backdated entry's
 *     next due date forward by however long the person took to record it, so
 *     the more honest they are about the date, the more wrong the cadence gets.
 *   - **Re-transitions.** Correcting a mis-filed visit — DONE, then NO_SHOW,
 *     then DONE again — is a transition each way, so the status gate alone
 *     does not stop a second satisfy. At `now` the second one is strictly
 *     later and advances the cadence again; at the visit instant it is not
 *     strictly after the first, and the primitive's forward-only guard makes
 *     it the no-op it should always have been.
 *
 * Bounded by `now` because a visit can be booked into the future: a
 * PLANNED-to-DONE correction on tomorrow's appointment must not stamp a
 * satisfy the engine would read as ahead of its own clock.
 *
 * This also matches how the rest of the engine is fed — the cron and the
 * ingest worker pass the EVENT instant, not the moment they happened to run.
 */
export async function closeCheckupForVisit(
  tx: Prisma.TransactionClient,
  reminder: SatisfiableReminder,
  timezone: string,
  occurredAt: Date,
  now: Date,
): Promise<void> {
  const satisfiedAt = occurredAt.getTime() < now.getTime() ? occurredAt : now;
  await satisfyReminder(
    tx as unknown as PrismaClient,
    reminder,
    timezone,
    satisfiedAt,
    "encounter",
  );
}

/**
 * The live appointment reminder this visit owns, found by the relation rather
 * than by reading the visit's foreign key.
 *
 * The distinction is the whole of the orphan defect. Reading `reminderId` and
 * checking its origin answers "what does this visit point at", which stops
 * being the same question the moment the column is re-pointed at a checkup:
 * the appointment row is still live, still armed, and now invisible to the
 * code that owns it, so the next reschedule mints a second one. Asking the
 * engine table which of ITS rows this visit owns cannot drift that way, and it
 * filters the origin and the tombstone in SQL instead of in a branch.
 */
export async function findOwnAppointmentReminderId(
  tx: Prisma.TransactionClient,
  userId: string,
  encounterId: string,
): Promise<string | null> {
  const row = await tx.measurementReminder.findFirst({
    where: {
      userId,
      origin: "ENCOUNTER",
      deletedAt: null,
      encounters: { some: { id: encounterId } },
    },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Retire every live appointment reminder this account owns that no visit
 * points at.
 *
 * A reminder nobody points at still fires — the cron reads the engine table,
 * not the visit list — so an orphan pushes notifications for an appointment
 * the person can no longer see, edit or cancel. The refusal in the edit route
 * stops the one sequence that produced them; this makes the state itself
 * unreachable, so a future path that finds a new way to strand one cannot
 * leave it armed.
 *
 * A soft-deleted VISIT still points at its reminder, so this never reaps a
 * deleted visit's row — that retirement belongs to the delete route, which
 * knows it is deliberate.
 */
export async function retireOrphanedAppointmentReminders(
  tx: Prisma.TransactionClient,
  userId: string,
  at: Date,
): Promise<number> {
  const result = await tx.measurementReminder.updateMany({
    where: {
      userId,
      origin: "ENCOUNTER",
      deletedAt: null,
      encounters: { none: {} },
    },
    data: { deletedAt: at, enabled: false, nextDueAt: null },
  });
  return result.count;
}

/**
 * Retire the appointment reminder a visit owns, alongside the visit.
 *
 * Takes the visit rather than a reminder id, and resolves the row by the
 * relation: deleting a visit must reach the reminder it owns even if its
 * foreign key is pointing somewhere else.
 */
export async function retireAppointmentReminderForVisit(
  tx: Prisma.TransactionClient,
  userId: string,
  encounterId: string,
  at: Date,
): Promise<void> {
  const reminderId = await findOwnAppointmentReminderId(
    tx,
    userId,
    encounterId,
  );
  if (!reminderId) return;
  await deleteAppointmentReminder(tx, reminderId, at);
}

/**
 * The practitioner a visit names, re-narrowed to the caller.
 *
 * Returns `undefined` when the id names nothing this account owns, which the
 * routes turn into a 404 — the same refusal shape a foreign encounter id gets.
 */
export async function resolveOwnedPractitioner(
  tx: Prisma.TransactionClient,
  userId: string,
  practitionerId: string,
): Promise<{ id: string; name: string; location: string | null } | undefined> {
  const row = await tx.practitioner.findUnique({
    where: { id: practitionerId },
    select: {
      id: true,
      name: true,
      location: true,
      userId: true,
      deletedAt: true,
    },
  });
  if (!row || row.userId !== userId || row.deletedAt !== null) return undefined;
  return { id: row.id, name: row.name, location: row.location };
}
