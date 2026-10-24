/**
 * The restore half of the medications domain: the account's own categories,
 * each drug with everything that hangs off it, the courses and archived
 * schedule eras, the dose history, and (once the markers exist) what each
 * drug was supposed to move. The export half lives in
 * `medications-backup.ts`.
 */
import type { Prisma } from "@/generated/prisma/client";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { toJson } from "@/lib/db";
import { restoredMedicationCreatedAt } from "@/lib/export/medication-created-at";
import {
  decodeEncryptedBytes,
  type RestoreContext,
} from "@/lib/export/restore-context";
import { recordUnknownKeys } from "@/lib/export/restore-skips";
import {
  encryptCategoryLabel,
  mintCustomMedicationCategoryKey,
  setMedicationCategory,
} from "@/lib/medication-category";
import {
  courseFromWindow,
  dateOfDayKey,
  projectCourseWindow,
} from "@/lib/medications/course-window";
import { DEFAULT_TIMEZONE, userDayKey, validTimezoneOr } from "@/lib/tz/format";
import type { BackupPayload } from "@/lib/validations/backup";

type BackupMedication = BackupPayload["medications"][number];
/** The columns of a just-written medication its course derivation reads. */
interface RestoredMedication {
  id: string;
  startsOn: Date | null;
  endsOn: Date | null;
  createdAt: Date;
}

export async function clearIntakeEvents(ctx: RestoreContext): Promise<void> {
  const intake = await ctx.tx.medicationIntakeEvent.deleteMany({
    where: { userId: ctx.ownerId },
  });
  ctx.cleared.intakeEvents = intake.count;
}

/** The drugs; their children cascade with them. */
export async function clearMedications(ctx: RestoreContext): Promise<void> {
  const meds = await ctx.tx.medication.deleteMany({
    where: { userId: ctx.ownerId },
  });
  ctx.cleared.medications = meds.count;
}

/**
 * The account's own medication categories, before the medications that name
 * them by key. Delete-then-recreate like the medications themselves. A key
 * held by another account on this instance (a portable file from elsewhere)
 * is re-minted, and the medications are mapped onto the new key.
 */
async function restoreCustomCategories(
  ctx: RestoreContext,
): Promise<Map<string, string>> {
  const { tx, ownerId, payload } = ctx;
  await tx.medicationCategoryLabel.deleteMany({
    where: { userId: ownerId },
  });
  const categoryKeyRemap = new Map<string, string>();
  for (const c of payload.customMedicationCategories) {
    const taken = await tx.medicationCategoryLabel.findUnique({
      where: { key: c.key },
      select: { id: true },
    });
    const key = taken ? mintCustomMedicationCategoryKey() : c.key;
    if (key !== c.key) categoryKeyRemap.set(c.key, key);
    await tx.medicationCategoryLabel.create({
      data: {
        userId: ownerId,
        key,
        // The ciphertext verbatim when the file carries it (a
        // disaster-recovery file), the readable label sealed here otherwise
        // (a portable file, or a recovery file written before the label
        // travelled sealed).
        labelEncrypted:
          c.labelEncrypted !== undefined
            ? decodeEncryptedBytes(c.labelEncrypted)
            : encryptCategoryLabel(c.label ?? ""),
        sortOrder: c.sortOrder,
        isActive: c.isActive,
        ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
        ...(c.updatedAt ? { updatedAt: new Date(c.updatedAt) } : {}),
      },
    });
  }
  return categoryKeyRemap;
}

/** The medication row itself, before the children nested beside it. */
function medicationRowData(
  m: BackupMedication,
  ownerId: string,
  intakeEvents: BackupPayload["intakeEvents"],
  restoreStartedAt: Date,
) {
  return {
    ...(m.id ? { id: m.id } : {}),
    userId: ownerId,
    name: m.name,
    dose: m.dose,
    treatmentClass: m.treatmentClass ?? "GENERIC",
    dosesPerUnit: m.dosesPerUnit ?? null,
    unitsPerDose: m.unitsPerDose ?? "1",
    active: m.active ?? true,
    notificationsEnabled: m.notificationsEnabled ?? true,
    pausedAt: m.pausedAt ? new Date(m.pausedAt) : null,
    snoozedUntil: m.snoozedUntil ? new Date(m.snoozedUntil) : null,
    startsOn: m.startsOn ? new Date(m.startsOn) : null,
    endsOn: m.endsOn ? new Date(m.endsOn) : null,
    oneShot: m.oneShot ?? false,
    asNeeded: m.asNeeded ?? false,
    trackIntake: m.trackIntake ?? true,
    // An option that is on always carries its floor, and a restored floor is
    // never before the restore: a portable file carries no removed doses, so
    // a dose the person deleted in the days before the export would
    // otherwise be filled again as taken by the next auto-take pass.
    autoMarkTaken: m.autoMarkTaken ?? false,
    autoMarkTakenSince: m.autoMarkTaken
      ? new Date(
          Math.max(
            m.autoMarkTakenSince ? Date.parse(m.autoMarkTakenSince) : 0,
            restoreStartedAt.getTime(),
          ),
        )
      : null,
    deliveryForm: m.deliveryForm ?? "ORAL",
    trackInjectionSites: m.trackInjectionSites ?? false,
    allowedInjectionSites: m.allowedInjectionSites ?? [],
    liveActivityEnabled: m.liveActivityEnabled ?? false,
    criticalAlarmEnabled: m.criticalAlarmEnabled ?? false,
    atcCode: m.atcCode ?? null,
    rxNormCode: m.rxNormCode ?? null,
    lowStockNotifiedAt: m.lowStockNotifiedAt
      ? new Date(m.lowStockNotifiedAt)
      : null,
    lowStockNotifiedThresholdDays: m.lowStockNotifiedThresholdDays ?? null,
    reorderLeadDays: m.reorderLeadDays ?? null,
    externalSource: m.externalSource ?? null,
    externalId: m.externalId ?? null,
    // A file from before v1.39.1 carries no creation date, and the restore
    // time would hide every dose-history miss before it. The earliest thing
    // the file records for the drug stands in.
    ...(() => {
      const createdAt = restoredMedicationCreatedAt(
        m,
        intakeEvents,
        restoreStartedAt,
      );
      return createdAt ? { createdAt } : {};
    })(),
    ...(m.updatedAt ? { updatedAt: new Date(m.updatedAt) } : {}),
  };
}

/**
 * The reminder phase timings: one row or none, so `create` on the optional
 * side rather than a list. A file that says nothing leaves the drug untuned,
 * which is what it was.
 */
function phaseConfigData(m: BackupMedication) {
  if (!m.phaseConfig) return {};
  return {
    phaseConfig: {
      create: {
        ...(m.phaseConfig.id ? { id: m.phaseConfig.id } : {}),
        ...(m.phaseConfig.greenValue !== undefined
          ? { greenValue: m.phaseConfig.greenValue }
          : {}),
        ...(m.phaseConfig.greenMode
          ? { greenMode: m.phaseConfig.greenMode }
          : {}),
        ...(m.phaseConfig.yellowValue !== undefined
          ? { yellowValue: m.phaseConfig.yellowValue }
          : {}),
        ...(m.phaseConfig.yellowMode
          ? { yellowMode: m.phaseConfig.yellowMode }
          : {}),
        ...(m.phaseConfig.orangeValue !== undefined
          ? { orangeValue: m.phaseConfig.orangeValue }
          : {}),
        ...(m.phaseConfig.orangeMode
          ? { orangeMode: m.phaseConfig.orangeMode }
          : {}),
        ...(m.phaseConfig.redValue !== undefined
          ? { redValue: m.phaseConfig.redValue }
          : {}),
        ...(m.phaseConfig.redMode ? { redMode: m.phaseConfig.redMode } : {}),
      },
    },
  };
}

/**
 * Everything nested in the medication's own `create`, so each foreign key
 * binds to the id this row actually got. A canonical DR file preserves the
 * medication's id and a portable one mints a fresh cuid; neither case needs
 * the old `medicationId` from the file, which is why the payload does not
 * carry it.
 *
 * Each note follows the measurement contract: ciphertext verbatim when the
 * file has it, legacy plaintext encrypted on the way in, and the plaintext
 * column left null either way.
 */
function medicationChildrenData(m: BackupMedication, ownerId: string) {
  return {
    schedules: {
      create: m.schedules.map((s) => ({
        ...(s.id ? { id: s.id } : {}),
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        label: s.label ?? null,
        dose: s.dose ?? null,
        // #219 — per-schedule units per dose. Prisma coerces the Decimal
        // string; NULL / absent stays NULL (inherit).
        unitsPerDose: s.unitsPerDose ?? null,
        daysOfWeek: s.daysOfWeek ?? null,
        timesOfDay: s.timesOfDay ?? [],
        reminderGraceMinutes: s.reminderGraceMinutes ?? null,
        rrule: s.rrule ?? null,
        rollingIntervalDays: s.rollingIntervalDays ?? null,
        scheduleType: s.scheduleType ?? "SCHEDULED",
        cyclicOnWeeks: s.cyclicOnWeeks ?? null,
        cyclicOffWeeks: s.cyclicOffWeeks ?? null,
        doseWindows: (s.doseWindows ?? null) as never,
      })),
    },
    sideEffects: {
      create: m.sideEffects.map((s) => ({
        ...(s.id ? { id: s.id } : {}),
        userId: ownerId,
        occurredAt: new Date(s.occurredAt),
        category: s.category,
        entry: s.entry,
        severity: s.severity,
        notes: null,
        notesEncrypted:
          s.notesEncrypted == null
            ? encryptNote(s.notes ?? null)
            : decodeEncryptedBytes(s.notesEncrypted),
        ...(s.createdAt ? { createdAt: new Date(s.createdAt) } : {}),
      })),
    },
    // The composition, restored as written; the SUPPLEMENT nutrient rows it
    // produced travel in the nutrient section.
    ingredients: {
      create: m.ingredients.map((i) => ({
        ...(i.id ? { id: i.id } : {}),
        userId: ownerId,
        nutrient: i.nutrient,
        amountPerUnit: i.amountPerUnit,
        unit: i.unit,
        enteredAmount: i.enteredAmount ?? null,
        enteredUnit: i.enteredUnit ?? null,
        source: i.source,
        ...(i.createdAt ? { createdAt: new Date(i.createdAt) } : {}),
        ...(i.updatedAt ? { updatedAt: new Date(i.updatedAt) } : {}),
      })),
    },
    // `resumedAt` passes through as null when the era is open. It is not
    // defaulted to the restore time: a pause that was still running when the
    // backup was taken is still running after the restore, and closing it
    // here would silently convert an ongoing decision into a historical one.
    pauseEras: {
      create: m.pauseEras.map((p) => ({
        ...(p.id ? { id: p.id } : {}),
        userId: ownerId,
        pausedAt: new Date(p.pausedAt),
        resumedAt: p.resumedAt ? new Date(p.resumedAt) : null,
        ...(p.createdAt ? { createdAt: new Date(p.createdAt) } : {}),
      })),
    },
    // The titration steps.
    doseChanges: {
      create: m.doseChanges.map((d) => ({
        ...(d.id ? { id: d.id } : {}),
        effectiveFrom: new Date(d.effectiveFrom),
        doseValue: d.doseValue,
        doseUnit: d.doseUnit,
        note: null,
        noteEncrypted:
          d.noteEncrypted == null
            ? encryptNote(d.note ?? null)
            : decodeEncryptedBytes(d.noteEncrypted),
        ...(d.createdAt ? { createdAt: new Date(d.createdAt) } : {}),
      })),
    },
    // The packs, and the ledger behind their counts. `unitsRemaining` is
    // written VERBATIM rather than recomputed from the events — it is what
    // the server had resolved and what the person was shown, and
    // recomputing here would silently correct a count they may have
    // adjusted by hand.
    inventoryItems: {
      create: m.inventoryItems.map((i) => ({
        ...(i.id ? { id: i.id } : {}),
        userId: ownerId,
        state: (i.state ?? "ACTIVE") as never,
        containerType: (i.containerType ?? "OTHER") as never,
        unitsTotal: i.unitsTotal,
        unitsRemaining: i.unitsRemaining,
        firstUseAt: i.firstUseAt ? new Date(i.firstUseAt) : null,
        expiresAt: i.expiresAt ? new Date(i.expiresAt) : null,
        printedExpiry: i.printedExpiry ? new Date(i.printedExpiry) : null,
        purchasedAt: i.purchasedAt ? new Date(i.purchasedAt) : null,
        manufacturer: i.manufacturer ?? null,
        doseStrength: i.doseStrength ?? null,
        notes: null,
        notesEncrypted:
          i.notesEncrypted == null
            ? encryptNote(i.notes ?? null)
            : decodeEncryptedBytes(i.notesEncrypted),
        ...(i.createdAt ? { createdAt: new Date(i.createdAt) } : {}),
        ...(i.updatedAt ? { updatedAt: new Date(i.updatedAt) } : {}),
      })),
    },
    ...phaseConfigData(m),
    inventoryEvents: {
      create: m.inventoryEvents.map((e) => ({
        ...(e.id ? { id: e.id } : {}),
        delta: e.delta,
        reason: e.reason,
        occurredAt: new Date(e.occurredAt),
      })),
    },
  };
}

/**
 * The courses, then the window they project. A file written before courses
 * existed carries none; the medication's own window then describes its one
 * course, derived exactly as the migration's backfill did (an end-only window
 * runs from creation, or from its end day when that lies earlier).
 */
async function restoreCourses(
  tx: Prisma.TransactionClient,
  ownerId: string,
  m: BackupMedication,
  created: RestoredMedication,
  restoreTz: string,
): Promise<void> {
  const courseRows: Array<{
    startsOn: Date;
    endsOn: Date | null;
    endedAt?: Date | null;
    note: string | null;
    noteEncrypted?: string | null;
    createdAt?: Date;
    updatedAt?: Date;
  }> =
    m.courses !== undefined
      ? m.courses.map((c) => ({
          startsOn: dateOfDayKey(c.startsOn),
          endsOn: c.endsOn ? dateOfDayKey(c.endsOn) : null,
          endedAt: c.endedAt ? new Date(c.endedAt) : null,
          note: c.note ?? null,
          ...(c.noteEncrypted !== undefined
            ? { noteEncrypted: c.noteEncrypted }
            : {}),
          ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
          ...(c.updatedAt ? { updatedAt: new Date(c.updatedAt) } : {}),
        }))
      : (() => {
          const derived = courseFromWindow(
            created.startsOn,
            created.endsOn,
            userDayKey(created.createdAt, restoreTz),
          );
          return derived ? [{ ...derived, note: null }] : [];
        })();
  if (courseRows.length === 0) return;
  await tx.medicationCourse.createMany({
    data: courseRows.map((c) => ({
      medicationId: created.id,
      userId: ownerId,
      startsOn: c.startsOn,
      endsOn: c.endsOn,
      endedAt: c.endedAt ?? null,
      // Ciphertext verbatim from a disaster-recovery file; the readable note
      // of a portable or older file sealed here.
      noteEncrypted:
        c.noteEncrypted !== undefined
          ? c.noteEncrypted === null
            ? null
            : decodeEncryptedBytes(c.noteEncrypted)
          : c.note
            ? encryptToBytes(c.note)
            : null,
      ...(c.createdAt ? { createdAt: c.createdAt } : {}),
      ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}),
    })),
  });
  const window = projectCourseWindow(courseRows);
  await tx.medication.update({
    where: { id: created.id },
    data: {
      startsOn: window.startsOn,
      endsOn: window.endsOn,
      endedAt: window.endedAt,
    },
  });
}

/**
 * The archived schedule eras, in two passes.
 *
 * An era carries `supersededByRevisionId`, the pointer from a corrected
 * ARCHIVED row to the MANUAL one that replaced it. The column has no
 * `@relation`, so a value addressing nothing costs no error — it just stops
 * meaning anything, which is the more dangerous shape here, because every era
 * consumer SKIPS a row that carries the pointer. Lose it and the superseded
 * original goes live again beside its own correction: two overlapping eras
 * for one window, and past days minted against a plan the account had already
 * corrected.
 *
 * A portable restore mints fresh ids, so the pointer cannot travel as one. It
 * travels as a POSITION in this drug's own ordered era list, because that
 * list is the only thing both ends agree on: the builder sorts it totally
 * (validFrom, then createdAt, then id) so two eras sharing an instant cannot
 * swap places between two exports of the same account, and the pointer never
 * crosses a drug — every route that writes it scopes the update to one
 * medication — so the drug's own list is a complete address space.
 *
 * Pass one writes every era with the link NULL, because the row a link
 * addresses is as often written after the row addressing it as before. Pass
 * two patches the links once every position has an id.
 */
async function restoreScheduleRevisions(
  tx: Prisma.TransactionClient,
  m: BackupMedication,
  medicationId: string,
  medicationIndex: number,
  unresolvedRevisionLinks: string[],
): Promise<void> {
  const revisionIds: string[] = [];
  for (const revision of m.scheduleRevisions) {
    const row = await tx.medicationScheduleRevision.create({
      data: {
        ...(revision.id ? { id: revision.id } : {}),
        medicationId,
        validFrom: new Date(revision.validFrom),
        validUntil: new Date(revision.validUntil),
        payload: toJson(revision.payload),
        source: revision.source ?? "ARCHIVED",
        supersededByRevisionId: null,
        ...(revision.createdAt
          ? { createdAt: new Date(revision.createdAt) }
          : {}),
      },
      select: { id: true },
    });
    revisionIds.push(row.id);
  }
  for (const [index, revision] of m.scheduleRevisions.entries()) {
    const to = revision.supersededByIndex;
    if (to === null || to === undefined) continue;
    // A hand-edited file can name a position this drug does not have, or the
    // era's OWN position — and a row that supersedes itself is skipped by
    // every consumer, so the era would disappear from the timeline while
    // still sitting in the table. Neither can be honoured and neither may be
    // guessed at, so the link stays NULL and the position is reported. The
    // era still restores: the window and the plan it held are the history,
    // and the correction pointer is the smaller loss.
    if (
      !Number.isInteger(to) ||
      to < 0 ||
      to >= revisionIds.length ||
      to === index
    ) {
      unresolvedRevisionLinks.push(
        `medications[${medicationIndex}].scheduleRevisions[${index}].supersededByIndex=${to}`,
      );
      continue;
    }
    await tx.medicationScheduleRevision.update({
      where: { id: revisionIds[index] },
      data: { supersededByRevisionId: revisionIds[to] },
    });
  }
}

/**
 * The dose history. An event whose medication did not come back used to be
 * mapped to null and filtered away: the dose history came back short and the
 * restore reported success. That is the same silent-drop shape the cycle
 * symptom links had, and it gets the same answer — name the unresolved
 * reference and stop, so the operator learns from the error rather than from
 * a compliance rate that quietly moved.
 */
async function restoreIntakeEvents(
  ctx: RestoreContext,
  medByName: ReadonlyMap<string, string>,
): Promise<void> {
  const { tx, ownerId, payload } = ctx;
  const restoredMedicationIds = ctx.links.restoredMedicationIds;
  if (payload.intakeEvents.length === 0) return;
  const unresolvedMedications = [
    ...new Set(
      payload.intakeEvents
        .filter(
          (e) =>
            !(e.medicationId && restoredMedicationIds.has(e.medicationId)) &&
            !medByName.has(e.medication),
        )
        .map((e) => e.medicationId ?? e.medication),
    ),
  ];
  if (unresolvedMedications.length > 0) {
    throw new Error(
      `Unknown medication references in intake events: ${unresolvedMedications.join(
        ", ",
      )}. The backup records doses against medications it does not carry.`,
    );
  }
  const rows = payload.intakeEvents
    .map((e) => {
      const medId =
        e.medicationId && restoredMedicationIds.has(e.medicationId)
          ? e.medicationId
          : medByName.get(e.medication);
      if (!medId) return null;
      return {
        ...(e.id ? { id: e.id } : {}),
        userId: ownerId,
        medicationId: medId,
        scheduledFor: new Date(e.scheduledFor),
        takenAt: e.takenAt ? new Date(e.takenAt) : null,
        skipped: e.skipped ?? false,
        autoMissed: e.autoMissed ?? false,
        autoRecorded: e.autoRecorded ?? false,
        attributionSource: e.attributionSource ?? "AUTO",
        source: e.source ?? "WEB",
        idempotencyKey: e.idempotencyKey ?? null,
        ...(e.createdAt ? { createdAt: new Date(e.createdAt) } : {}),
        injectionSite: e.injectionSite ?? null,
        doseTaken: e.doseTaken ?? null,
        inventoryConsumption: (e.inventoryConsumption ?? null) as never,
        externalId: e.externalId ?? null,
        ...(e.updatedAt ? { updatedAt: new Date(e.updatedAt) } : {}),
        syncVersion: e.syncVersion ?? 0,
        deletedAt: e.deletedAt ? new Date(e.deletedAt) : null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length > 0) {
    await tx.medicationIntakeEvent.createMany({ data: rows });
  }
}

/**
 * The medications, each with everything nested in it, then the dose history.
 *
 * The efficacy targets cannot ride inside the medication create beside the
 * schedules and the packs: `biomarkerId` is a foreign key into a catalogue
 * this transaction has not restored yet. They are collected against the id
 * the drug ACTUALLY got and written by `restoreEfficacyTargets` once the
 * biomarkers exist.
 *
 * Supersede pointers the file states and the restore cannot honour are
 * reported as JSON paths into the file rather than as ids: the file is where
 * an operator has to go to see what the position meant, and an id would be
 * one the restore never wrote.
 */
export async function restoreMedications(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload, skips, links } = ctx;
  const medByName = new Map<string, string>();
  const unresolvedRevisionLinks: string[] = [];
  const categoryKeyRemap = await restoreCustomCategories(ctx);

  // The zone a derived course's creation day is read in: the file's own
  // account settings, else the account's stored one.
  const restoreTz = validTimezoneOr(
    payload.accountSettings?.timezone ??
      (
        await tx.user.findUnique({
          where: { id: ownerId },
          select: { timezone: true },
        })
      )?.timezone,
    DEFAULT_TIMEZONE,
  );
  let medicationIndex = 0;
  ctx.reportSection("medications");
  const restoreStartedAt = new Date();
  for (const m of payload.medications) {
    const created = await tx.medication.create({
      data: {
        ...medicationRowData(
          m,
          ownerId,
          payload.intakeEvents,
          restoreStartedAt,
        ),
        ...medicationChildrenData(m, ownerId),
      },
    });
    links.restoredMedicationIds.add(created.id);
    // The id each medication had in the source account, to the id it got
    // here. A disaster-recovery file keeps the id, so this is the identity
    // there; a portable file names the source row only through `ref`, and
    // the relation links (written last) are re-pointed through this map
    // instead of being dropped as "end is gone".
    const medicationSourceId = m.id ?? m.ref;
    if (medicationSourceId) {
      links.medicationIdBySourceId.set(medicationSourceId, created.id);
    }
    if (!medByName.has(m.name)) medByName.set(m.name, created.id);
    // The clinical category lives in its own table keyed on the medication
    // id, so it is written after the row exists and inside the same
    // transaction. OTHER is what a missing row already reads as.
    if (m.category && m.category !== "OTHER") {
      await setMedicationCategory(
        created.id,
        categoryKeyRemap.get(m.category) ?? m.category,
        tx,
      );
      if (m.categoryUpdatedAt) {
        await tx.medicationCategoryAssignment.update({
          where: { medicationId: created.id },
          data: { updatedAt: new Date(m.categoryUpdatedAt) },
        });
      }
    }
    await restoreCourses(tx, ownerId, m, created, restoreTz);
    await restoreScheduleRevisions(
      tx,
      m,
      created.id,
      medicationIndex,
      unresolvedRevisionLinks,
    );
    // The writes above (the course window) moved the row's `updatedAt` to
    // now; a file that carries the row's own last write puts it back.
    if (m.updatedAt) {
      await tx.medication.update({
        where: { id: created.id },
        data: { updatedAt: new Date(m.updatedAt) },
      });
    }
    for (const target of m.efficacyTargets) {
      links.pendingEfficacyTargets.push({ medicationId: created.id, target });
    }
    medicationIndex += 1;
  }
  recordUnknownKeys(
    skips,
    "scheduleRevisionLink",
    [...new Set(unresolvedRevisionLinks)],
    unresolvedRevisionLinks,
  );
  await restoreIntakeEvents(ctx, medByName);
}

/**
 * What each drug was supposed to move, written once both ends exist: the
 * drugs came back in the medications step and the analytes in the labs step,
 * and one of those two had to move for a target to reach the database at
 * all.
 *
 * A second pass wins over hoisting the biomarker restore above the
 * medications, for two reasons. The marker maps are read by the lab-result
 * pass directly after this one, so moving the marker restore would separate a
 * map from its only other consumer. And the direction of the dependency would
 * read backwards: a pinned target is a leaf of the medication tree, and
 * letting a leaf dictate where the clinical record is rebuilt inverts what
 * the file is about. A second pass states the constraint where it applies
 * instead of hiding it in a line order.
 *
 * A named analyte the restore did not put back cannot be written:
 * `biomarkerId` is a real foreign key, so a dangling value would fail the
 * constraint and roll the entire account back over one override. The row is
 * dropped and NAMED. Dropping rather than nulling is deliberate here: the
 * override IS the reference, and a row with neither arm set is what the
 * resolver already reads as "no override", so keeping it would restore
 * something that means nothing while still claiming the primary slot. A
 * target that carried no name in the first place is a genuine live state (the
 * analyte was deleted before the export) and comes back as written.
 */
export async function restoreEfficacyTargets(
  ctx: RestoreContext,
): Promise<void> {
  const { tx, skips } = ctx;
  const { biomarkerByName, pendingEfficacyTargets } = ctx.links;
  const unresolvedTargetAnalytes: string[] = [];
  const writableTargets = pendingEfficacyTargets.filter((pending) => {
    const name = pending.target.biomarkerName;
    if (!name || biomarkerByName.has(name)) return true;
    unresolvedTargetAnalytes.push(name);
    return false;
  });
  if (writableTargets.length > 0) {
    await tx.medicationEfficacyTarget.createMany({
      data: writableTargets.map(({ medicationId, target }) => ({
        ...(target.id ? { id: target.id } : {}),
        medicationId,
        measurementType: target.measurementType ?? null,
        biomarkerId: target.biomarkerName
          ? (biomarkerByName.get(target.biomarkerName) ?? null)
          : null,
        primary: target.primary ?? true,
        ...(target.createdAt ? { createdAt: new Date(target.createdAt) } : {}),
        ...(target.updatedAt ? { updatedAt: new Date(target.updatedAt) } : {}),
      })),
    });
  }
  recordUnknownKeys(
    skips,
    "medicationTarget",
    [...new Set(unresolvedTargetAnalytes)],
    unresolvedTargetAnalytes,
  );
}
