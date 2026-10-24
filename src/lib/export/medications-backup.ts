/**
 * The medications domain's export half: every drug with everything that hangs
 * off it, the account's own categories, and the dose history. The restore
 * half lives in `medications-restore.ts`.
 */
import { Buffer } from "node:buffer";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { readNote } from "@/lib/crypto/note-cipher";
import {
  BULK_PAGE_SIZE,
  collect,
  deferredRows,
} from "@/lib/export/deferred-rows";
import type {
  BackupExportContext,
  BackupExportPart,
} from "@/lib/export/export-context";
import {
  getMedicationCategories,
  readMedicationCategoryLabelsForBackup,
} from "@/lib/medication-category";
import { dayKeyOfDate } from "@/lib/medications/course-window";

// Side effects ride INSIDE their medication, exactly as the schedules
// beside them do. The alternative — a top-level array carrying
// `medicationId` — would have to survive a restore that mints new
// medication ids for a portable file, which is the id-remap the intake
// events already have to work around by drug name. A nested create has
// no id to remap: Prisma binds the child to whatever id the parent row
// actually got.
const MEDICATION_BACKUP_INCLUDE = {
  schedules: { orderBy: [{ windowStart: "asc" }, { id: "asc" }] },
  sideEffects: { orderBy: [{ occurredAt: "desc" }, { id: "asc" }] },
  pauseEras: { orderBy: [{ pausedAt: "asc" }, { id: "asc" }] },
  courses: { orderBy: [{ startsOn: "asc" }, { id: "asc" }] },
  doseChanges: { orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }] },
  inventoryItems: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
  inventoryEvents: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] },
  phaseConfig: true,
  // The composition per unit; ordered so two exports of the
  // same account write it identically.
  ingredients: { orderBy: [{ nutrient: "asc" }, { id: "asc" }] },
  // The archived schedule eras. Ordered TOTALLY, not just by the column
  // that reads like the sort key: the position in this list is the
  // identifier the supersede pointer travels as, so two eras sharing a
  // `validFrom` must not be free to swap places between two exports of
  // the same account.
  scheduleRevisions: {
    orderBy: [
      { validFrom: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ] as const,
  },
  // When the category was last set. Read for the disaster-recovery file,
  // which gives the assignment back with its own timestamp.
  categoryAssignment: { select: { updatedAt: true } },
  // What the drug was supposed to move. The biomarker is read by NAME
  // rather than by id, exactly as the lab results beside it are: a
  // portable restore mints a fresh biomarker id, and `(userId, name)` is
  // the natural key the catalogue is already unique on.
  efficacyTargets: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { biomarker: { select: { name: true } } },
  },
} satisfies Prisma.MedicationInclude;

type BackupMedicationRow = Prisma.MedicationGetPayload<{
  include: typeof MEDICATION_BACKUP_INCLUDE;
}>;

/** The drug's own columns, before the rows that hang off it. */
function serialiseMedicationRow(
  m: BackupMedicationRow,
  disasterRecovery: boolean,
  category: string,
) {
  return {
    ...(disasterRecovery
      ? {
          id: m.id,
          treatmentClass: m.treatmentClass,
          dosesPerUnit: m.dosesPerUnit,
          unitsPerDose: m.unitsPerDose.toString(),
          notificationsEnabled: m.notificationsEnabled,
          pausedAt: m.pausedAt?.toISOString() ?? null,
          snoozedUntil: m.snoozedUntil?.toISOString() ?? null,
          startsOn: m.startsOn?.toISOString() ?? null,
          endsOn: m.endsOn?.toISOString() ?? null,
          oneShot: m.oneShot,
          asNeeded: m.asNeeded,
          deliveryForm: m.deliveryForm,
          trackInjectionSites: m.trackInjectionSites,
          allowedInjectionSites: m.allowedInjectionSites,
          liveActivityEnabled: m.liveActivityEnabled,
          criticalAlarmEnabled: m.criticalAlarmEnabled,
          atcCode: m.atcCode,
          rxNormCode: m.rxNormCode,
          lowStockNotifiedAt: m.lowStockNotifiedAt?.toISOString() ?? null,
          lowStockNotifiedThresholdDays: m.lowStockNotifiedThresholdDays,
          reorderLeadDays: m.reorderLeadDays,
          externalSource: m.externalSource,
          externalId: m.externalId,
          updatedAt: m.updatedAt.toISOString(),
          categoryUpdatedAt:
            m.categoryAssignment?.updatedAt.toISOString() ?? null,
        }
      : // No id: a portable restore mints a fresh one. The relation links
        // still name this drug, so the file says which row they mean.
        { ref: m.id }),
    name: m.name,
    dose: m.dose,
    active: m.active,
    // The person's decision to keep this medication as a
    // record only. Both purposes carry it: a restore that dropped it would
    // start reminding them about a medication they chose not to track.
    trackIntake: m.trackIntake,
    // The person's choice to have doses recorded for them, and
    // the floor before which none is. Both purposes: a restore without
    // them would start reminding again, or fill history it never owned.
    autoMarkTaken: m.autoMarkTaken,
    autoMarkTakenSince: m.autoMarkTakenSince?.toISOString() ?? null,
    // Both purposes: the category is something the person chose.
    category,
    // Both purposes carry the creation instant: it is the floor of the
    // medication's expected slots, so a restore stamped with the restore
    // time would read the whole restored history as predating the
    // medication and drop its misses from every rate (#1028).
    createdAt: m.createdAt.toISOString(),
  };
}

/** What was planned, recorded and changed: schedules to dose changes. */
function serialiseMedicationHistory(
  m: BackupMedicationRow,
  disasterRecovery: boolean,
) {
  return {
    schedules: m.schedules.map((s) => ({
      ...(disasterRecovery
        ? {
            id: s.id,
            daysOfWeek: s.daysOfWeek,
            timesOfDay: s.timesOfDay,
            reminderGraceMinutes: s.reminderGraceMinutes,
            rrule: s.rrule,
            rollingIntervalDays: s.rollingIntervalDays,
            scheduleType: s.scheduleType,
            cyclicOnWeeks: s.cyclicOnWeeks,
            cyclicOffWeeks: s.cyclicOffWeeks,
            doseWindows: s.doseWindows,
            // #219 — per-schedule units per dose. Decimal → string like the
            // medication-level column; NULL (inherit) stays NULL.
            unitsPerDose:
              s.unitsPerDose == null ? null : s.unitsPerDose.toString(),
          }
        : {}),
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      label: s.label,
      dose: s.dose,
    })),
    // What the person recorded against the drug, and the reason a drug may
    // have been stopped. `notes` is the same dual-column arrangement
    // `Measurement` has and gets the same treatment: a portable export
    // carries the DECRYPTED note and no ciphertext, a disaster-recovery
    // payload carries the ciphertext verbatim plus whatever legacy plaintext
    // the row still holds, and the restore re-encrypts the plaintext case.
    sideEffects: m.sideEffects.map((s) => ({
      ...(disasterRecovery
        ? {
            id: s.id,
            notes: s.notes,
            notesEncrypted: s.notesEncrypted
              ? Buffer.from(s.notesEncrypted).toString("base64")
              : null,
            createdAt: s.createdAt.toISOString(),
          }
        : { notes: readNote(s.notesEncrypted, s.notes) }),
      occurredAt: s.occurredAt.toISOString(),
      category: s.category,
      entry: s.entry,
      severity: s.severity,
    })),
    // Nested for the same reason the two above are: a pause era is bound to
    // its medication by id, and a nested create binds it to whatever id the
    // parent actually got.
    //
    // These spans are what separates "stopped taking it" from "was told to
    // stop taking it". Without them the compliance recomputation counts a
    // deliberate pause as missed doses, so a restored account reads as
    // non-adherent for a stretch during which it did exactly what it was
    // told. Nothing else in the payload can reconstruct them: an era is a
    // decision, not an observation, and no intake row records its absence.
    //
    // `resumedAt` stays nullable end to end — an open era means the
    // medication is still paused, and readers run it to `now`.
    pauseEras: m.pauseEras.map((p) => ({
      ...(disasterRecovery ? { id: p.id } : {}),
      pausedAt: p.pausedAt.toISOString(),
      resumedAt: p.resumedAt ? p.resumedAt.toISOString() : null,
      createdAt: p.createdAt.toISOString(),
    })),
    // The courses: "when did I last take this" lives here
    // and nowhere else once a second course exists. The medication's own
    // window above is the projection of the latest one.
    // What one unit contains. Both purposes: it is something the
    // person typed off a label, and without it the supplement's doses stop
    // counting toward the day's micronutrients. Canonical amount plus the
    // amount as entered, so the form shows what was typed.
    ingredients: m.ingredients.map((i) => ({
      ...(disasterRecovery
        ? { id: i.id, updatedAt: i.updatedAt.toISOString() }
        : {}),
      nutrient: i.nutrient,
      amountPerUnit: i.amountPerUnit,
      unit: i.unit,
      enteredAmount: i.enteredAmount,
      enteredUnit: i.enteredUnit,
      source: i.source,
      createdAt: i.createdAt.toISOString(),
    })),
    // The note follows the contract of every other sealed column: the
    // disaster-recovery file carries the ciphertext verbatim (and the row's
    // own last write), a portable file the decrypted text.
    courses: m.courses.map((c) => ({
      startsOn: dayKeyOfDate(c.startsOn),
      endsOn: c.endsOn ? dayKeyOfDate(c.endsOn) : null,
      // #1280 — when "End course" ended it. Both purposes: without it the
      // restored course runs to midnight of its last day and expects the
      // doses the person had stopped.
      endedAt: c.endedAt ? c.endedAt.toISOString() : null,
      ...(disasterRecovery
        ? {
            note: null,
            noteEncrypted: c.noteEncrypted
              ? Buffer.from(c.noteEncrypted).toString("base64")
              : null,
            updatedAt: c.updatedAt.toISOString(),
          }
        : { note: c.noteEncrypted ? decryptFromBytes(c.noteEncrypted) : null }),
      createdAt: c.createdAt.toISOString(),
    })),
    // Titration: when the dose moved, to what, and why. The drug comes
    // back at today's dose either way; without these the ramp that led to
    // it is gone, and that ramp is what a prescriber asks about.
    //
    // The note follows the side-effect contract beside it: a portable
    // export carries the DECRYPTED note and no ciphertext, a
    // disaster-recovery payload carries the ciphertext verbatim plus
    // whatever legacy plaintext the row still holds.
    doseChanges: m.doseChanges.map((d) => ({
      ...(disasterRecovery
        ? {
            id: d.id,
            note: d.note,
            noteEncrypted: d.noteEncrypted
              ? Buffer.from(d.noteEncrypted).toString("base64")
              : null,
          }
        : { note: readNote(d.noteEncrypted, d.note) }),
      effectiveFrom: d.effectiveFrom.toISOString(),
      doseValue: d.doseValue,
      doseUnit: d.doseUnit,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}

/**
 * The stock, the phase timings, the archived schedule eras and the targets.
 * `revisionIndex` is where each era sits in this drug's own ordered list.
 */
function serialiseMedicationStock(
  m: BackupMedicationRow,
  disasterRecovery: boolean,
  revisionIndex: ReadonlyMap<string, number> | undefined,
) {
  return {
    // The packs on the shelf, and the ledger behind the number on them.
    //
    // `unitsRemaining` is carried VERBATIM rather than recomputed from the
    // events, for the same reason `nextDueAt` is: it is what the server had
    // resolved and what the person was shown. Recomputing on the way back
    // would silently correct a count the account may have adjusted by hand,
    // and would disagree with every low-stock reminder already sent.
    //
    // Both Decimal columns cross the wire as strings. A pack of 0.5 mg
    // halves is a real prescription, and JSON numbers would round it.
    inventoryItems: m.inventoryItems.map((i) => ({
      ...(disasterRecovery
        ? {
            id: i.id,
            notes: i.notes,
            notesEncrypted: i.notesEncrypted
              ? Buffer.from(i.notesEncrypted).toString("base64")
              : null,
          }
        : { notes: readNote(i.notesEncrypted, i.notes) }),
      state: i.state,
      containerType: i.containerType,
      unitsTotal: i.unitsTotal.toString(),
      unitsRemaining: i.unitsRemaining.toString(),
      firstUseAt: i.firstUseAt?.toISOString() ?? null,
      expiresAt: i.expiresAt?.toISOString() ?? null,
      printedExpiry: i.printedExpiry?.toISOString() ?? null,
      purchasedAt: i.purchasedAt?.toISOString() ?? null,
      manufacturer: i.manufacturer,
      doseStrength: i.doseStrength,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    })),
    // The four reminder phase thresholds this drug was tuned to. One row or
    // none, so it rides as an object rather than a list — and null means the
    // person never tuned it, which is a different statement from "the file
    // forgot to say".
    phaseConfig: m.phaseConfig
      ? {
          ...(disasterRecovery ? { id: m.phaseConfig.id } : {}),
          greenValue: m.phaseConfig.greenValue,
          greenMode: m.phaseConfig.greenMode,
          yellowValue: m.phaseConfig.yellowValue,
          yellowMode: m.phaseConfig.yellowMode,
          orangeValue: m.phaseConfig.orangeValue,
          orangeMode: m.phaseConfig.orangeMode,
          redValue: m.phaseConfig.redValue,
          redMode: m.phaseConfig.redMode,
        }
      : null,
    inventoryEvents: m.inventoryEvents.map((e) => ({
      ...(disasterRecovery ? { id: e.id } : {}),
      delta: e.delta,
      reason: e.reason,
      occurredAt: e.occurredAt.toISOString(),
    })),
    // How the schedule got to where it is. The drug comes back on today's
    // plan either way; without these the record of when the dose or the
    // timing moved is gone, and the era minter reads every past day against
    // the CURRENT schedule instead of the one that was live then — so a
    // restored account's own compliance history quietly changes.
    //
    // `supersededByRevisionId` travels as a POSITION in this list rather
    // than as an id. See the restore for the whole argument; the short form
    // is that a portable restore mints fresh ids, so an id would point at
    // nothing, and the list this array IS is the only stable thing both ends
    // agree on. A pointer at a row outside this drug's own list cannot be
    // expressed and is written as null — the schema allows it, no code path
    // produces it, and inventing an index for it would be worse than saying
    // nothing.
    scheduleRevisions: m.scheduleRevisions.map((r) => ({
      ...(disasterRecovery ? { id: r.id } : {}),
      validFrom: r.validFrom.toISOString(),
      validUntil: r.validUntil.toISOString(),
      payload: r.payload,
      source: r.source,
      supersededByIndex: r.supersededByRevisionId
        ? (revisionIndex?.get(r.supersededByRevisionId) ?? null)
        : null,
      createdAt: r.createdAt.toISOString(),
    })),
    // What the drug is FOR, in the person's own words rather than the
    // resolver's. A row exists only where they overrode the derived
    // ATC / name inference, so it is the one durable statement of intent
    // the "Wirkung" view holds — and the drug restores with no statement of
    // what it was for without it.
    //
    // The lab arm travels as a NAME, the way a lab result's does. The id is
    // fresh on a portable restore, and `Biomarker` is unique on
    // `(userId, name)`, so the name is the only thing that survives the
    // trip. It is resolved on the way back against the biomarkers the
    // restore wrote.
    efficacyTargets: m.efficacyTargets.map((t) => ({
      ...(disasterRecovery
        ? {
            id: t.id,
            createdAt: t.createdAt.toISOString(),
            updatedAt: t.updatedAt.toISOString(),
          }
        : {}),
      measurementType: t.measurementType,
      biomarkerName: t.biomarker?.name ?? null,
      primary: t.primary,
    })),
  };
}

type BackupIntakeEvent = Prisma.MedicationIntakeEventGetPayload<{
  include: { medication: { select: { name: true } } };
}>;

/** One intake event, as it rides the wire. */
function serialiseIntakeEvent(e: BackupIntakeEvent, disasterRecovery: boolean) {
  return {
    ...(disasterRecovery
      ? {
          id: e.id,
          medicationId: e.medicationId,
          autoMissed: e.autoMissed,
          attributionSource: e.attributionSource,
          idempotencyKey: e.idempotencyKey,
          createdAt: e.createdAt.toISOString(),
          injectionSite: e.injectionSite,
          doseTaken: e.doseTaken,
          inventoryConsumption: e.inventoryConsumption,
          externalId: e.externalId,
          updatedAt: e.updatedAt.toISOString(),
          syncVersion: e.syncVersion,
          deletedAt: e.deletedAt?.toISOString() ?? null,
        }
      : {}),
    medication: e.medication.name,
    scheduledFor: e.scheduledFor.toISOString(),
    takenAt: e.takenAt?.toISOString() ?? null,
    skipped: e.skipped,
    source: e.source,
    // Both purposes: the history labels the dose "recorded
    // automatically", and a restore that dropped the marker would relabel
    // it as one the person confirmed.
    autoRecorded: e.autoRecorded,
  };
}

/**
 * Every backup intake event, one serialised row at a time.
 *
 * The sort is TOTAL — `scheduledFor desc` then `id desc` — where the
 * materialising read used to order by the timestamp alone. A keyset cursor
 * needs a total order to page correctly, and a partial one also let two
 * exports of the same account emit two different files whenever two doses
 * shared a scheduled minute, which every multi-dose day has.
 */
export async function* iterateBackupIntakeEvents(
  prisma: PrismaClient,
  userId: string,
  disasterRecovery: boolean,
): AsyncGenerator<Record<string, unknown>, void, void> {
  let cursorId: string | null = null;
  for (;;) {
    const page: BackupIntakeEvent[] =
      await prisma.medicationIntakeEvent.findMany({
        where: disasterRecovery ? { userId } : { userId, deletedAt: null },
        include: { medication: { select: { name: true } } },
        orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
        take: BULK_PAGE_SIZE,
        ...(cursorId !== null ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });
    if (page.length === 0) return;
    for (const e of page) yield serialiseIntakeEvent(e, disasterRecovery);
    if (page.length < BULK_PAGE_SIZE) return;
    cursorId = page[page.length - 1]!.id;
  }
}

/** Totals of the rows nested in the drugs, for the audit trail. */
function nestedCounts(medications: BackupMedicationRow[]) {
  const total = (rows: (m: BackupMedicationRow) => number) =>
    medications.reduce((sum, m) => sum + rows(m), 0);
  return {
    medicationSideEffects: total((m) => m.sideEffects.length),
    medicationPauseEras: total((m) => m.pauseEras.length),
    medicationDoseChanges: total((m) => m.doseChanges.length),
    medicationInventoryItems: total((m) => m.inventoryItems.length),
    medicationInventoryEvents: total((m) => m.inventoryEvents.length),
    reminderPhaseConfigs: medications.filter((m) => m.phaseConfig).length,
    medicationEfficacyTargets: total((m) => m.efficacyTargets.length),
    medicationScheduleRevisions: total((m) => m.scheduleRevisions.length),
  };
}

/**
 * The medications slice of the payload: the account's own categories, the
 * drugs, and the dose history (rows, or a marker for them).
 */
export async function buildMedicationsBackupPart(
  ctx: BackupExportContext,
): Promise<BackupExportPart> {
  const { prisma, userId, disasterRecovery } = ctx;
  const [medications, intakeEvents] = await Promise.all([
    prisma.medication.findMany({
      where: { userId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: MEDICATION_BACKUP_INCLUDE,
    }),
    ctx.deferBulk
      ? null
      : collect(iterateBackupIntakeEvents(prisma, userId, disasterRecovery)),
  ]);
  // The clinical category lives in its own table rather than on the
  // medication row and is read through the one helper that normalises it.
  // Before v1.39.4 no backup carried it and every restored medication came
  // back as "Other".
  const categoryByMedication = await getMedicationCategories(
    medications.map((m) => m.id),
    prisma,
  );
  // The account's own categories, restored before the medications that name
  // them by key. Every one is carried, hidden ones included, because a
  // medication can still be filed under it. A portable file carries the
  // label decrypted, so it restores on an instance with another key; a
  // disaster-recovery file carries the ciphertext verbatim, like every other
  // sealed column, and the row's own last write.
  const customMedicationCategories =
    await readMedicationCategoryLabelsForBackup(userId, prisma, {
      disasterRecovery,
    });
  // Where each archived era sits in its OWN drug's ordered list. Built once
  // here rather than per row, and scoped per medication because the
  // supersede pointer never crosses a drug — every route that writes it
  // scopes the update to the medication it belongs to.
  const revisionIndexByMedication = new Map(
    medications.map((m) => [
      m.id,
      new Map(
        m.scheduleRevisions.map((revision, index) => [revision.id, index]),
      ),
    ]),
  );
  return {
    section: {
      customMedicationCategories,
      medications: medications.map((m) => ({
        ...serialiseMedicationRow(
          m,
          disasterRecovery,
          categoryByMedication[m.id] ?? "OTHER",
        ),
        ...serialiseMedicationHistory(m, disasterRecovery),
        ...serialiseMedicationStock(
          m,
          disasterRecovery,
          revisionIndexByMedication.get(m.id),
        ),
      })),
      intakeEvents: ctx.deferBulk
        ? deferredRows(() =>
            iterateBackupIntakeEvents(prisma, userId, disasterRecovery),
          )
        : intakeEvents!,
    },
    counts: {
      medications: medications.length,
      intakeEvents: intakeEvents?.length ?? 0,
      ...nestedCounts(medications),
    },
  };
}
