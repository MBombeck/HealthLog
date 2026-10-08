/** The `t` from `useTranslations()`, injected so this stays pure. */
type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * What somebody did in your record, in a sentence.
 *
 * ## Why this exists
 *
 * The activity view renders every non-read row as one generic line: "somebody
 * made a change in your record". That was honest while sharing was read-only
 * and no delegate could make one. Now a delegate can enter a reading, a lab
 * result, an illness entry, a biomarker, a side effect, a medication, and can
 * mark a dose taken — and "made a change" for seven different things is a way
 * of answering nothing. An owner reading this at breakfast wants the verb.
 *
 * The map keeps a line for a tracked value even though a delegate can no
 * longer add one: rows written while it was admitted sit in the same table and
 * still have to render as something, which is the same reason the fallback
 * below exists.
 *
 * ## v1.37.0 — the MANAGE half
 *
 * A WRITE delegate can only add, so the generic line was at least the right
 * shape of fact. A MANAGE delegate changes and removes entries the owner made
 * themselves, and there "somebody made a change in your record" withholds the
 * only part that matters: whether a reading was corrected or deleted, whether
 * a medication was stopped, whether a whole dose history was purged. The level
 * ships under "reconstructable or refused", and a feed that cannot say which
 * verb ran reconstructs nothing.
 *
 * So every action a MANAGE-declared route files has an arm below, and
 * `src/__tests__/manage-activity-inventory.test.ts` reads the routes to prove
 * it — by CALLING this function, not by matching `case` in its source, so an
 * action that quietly falls through to the fallback fails there.
 *
 * ## What a line may say
 *
 * The verb and the kind of thing, never the value. Every sentence here takes
 * `name` and nothing else, and the inventory guard holds that across all six
 * bundles. The activity feed reads out of the audit table, which is not
 * encrypted and has its own retention: "changed your weight from 81 to 78"
 * would put a health figure in a second store with no rotation story. What
 * changed is a question the record itself answers.
 *
 * ## Why unknown actions fall back rather than fail
 *
 * The action string comes from the audit row, which outlives this map: a
 * release that admits a twelfth verb writes rows this map has never heard of,
 * and rows written by an older image sit in the same table. So an unmapped
 * action renders the generic line it renders today. A blank row would be the
 * one outcome worse than a vague one.
 *
 * Pure and translator-injected so the mapping can be pinned without rendering
 * a card, and so the keys stay literal for the i18n call-site guard.
 */
export function recordActivityVerbLine(
  t: Translator,
  action: string,
  name: string,
): string {
  switch (action) {
    case "measurement.create":
      return t("recordSharing.activityVerb.measurementCreate", { name });
    case "labResult.create":
      return t("recordSharing.activityVerb.labResultCreate", { name });
    case "allergy.create":
      return t("recordSharing.activityVerb.allergyCreate", { name });
    case "family-history.create":
      return t("recordSharing.activityVerb.familyHistoryCreate", { name });
    case "illness.episode.create":
      return t("recordSharing.activityVerb.illnessEpisodeCreate", { name });
    case "symptoms.event.create":
      return t("recordSharing.activityVerb.symptomEventCreate", { name });
    case "encounter.visit.create":
      return t("recordSharing.activityVerb.encounterVisitCreate", { name });
    case "vaccination.record.create":
      return t("recordSharing.activityVerb.vaccinationRecordCreate", { name });
    case "vaccination.custom.create":
      return t("recordSharing.activityVerb.customVaccineCreate", { name });
    case "practitioner.contact.create":
      return t("recordSharing.activityVerb.practitionerContactCreate", {
        name,
      });
    case "biomarker.create":
      return t("recordSharing.activityVerb.biomarkerCreate", { name });
    case "customMetricEntry.create":
      return t("recordSharing.activityVerb.customMetricEntryCreate", { name });
    case "medication.sideEffect.create":
      return t("recordSharing.activityVerb.medicationSideEffectCreate", {
        name,
      });
    case "medication.create":
      return t("recordSharing.activityVerb.medicationCreate", { name });
    // Both spellings, and the reason is worth keeping. The web client posts to
    // `POST /api/medications/[id]/intake`, which has audited as
    // `medication.intake` since v1.0.0; `medications.intake.update` is the
    // canonical route's action and the one the plan's copy deck named. Mapping
    // only the second meant the single most-used delegated act — a caregiver
    // marking a dose — rendered as the generic "made a change" for the person
    // whose tablets they are.
    case "medication.intake":
    case "medications.intake.update":
      return t("recordSharing.activityVerb.medicationIntake", { name });
    // The refused half of the same route, and it earns a line of its own for
    // the reason the whole panel exists. Deferring a reminder and rewriting a
    // dose the owner already recorded are the two things that request can
    // express and delegation does not cover. Folding them into "marked a dose"
    // is what made the gap dangerous in the first place: the owner would have
    // seen the sentence for a contribution against an attempt to switch their
    // reminders off. An attempt that was refused is still something the person
    // whose record it is should be able to see.
    case "medications.intake.update.refused":
      return t("recordSharing.activityVerb.medicationIntakeRefused", { name });
    // A batch post is still readings arriving; the owner does not care that the
    // client sent them together.
    case "measurement.create.batch":
      return t("recordSharing.activityVerb.measurementCreate", { name });

    /* ---------------------------------------------------------------- */
    /* v1.37.0 — MANAGE. Everything below can change or remove something */
    /* the owner put there themselves.                                   */
    /* ---------------------------------------------------------------- */

    case "measurement.update":
      return t("recordSharing.activityVerb.measurementUpdate", { name });
    case "measurement.delete":
      return t("recordSharing.activityVerb.measurementDelete", { name });
    // Its own line rather than the singular one. "Removed a reading" for a
    // bulk delete is the sentence that would let a month of readings go
    // missing while the feed reported a tidy-up.
    case "measurement.delete.bulk":
      return t("recordSharing.activityVerb.measurementDeleteBulk", { name });
    case "measurement.restore":
      return t("recordSharing.activityVerb.measurementRestore", { name });
    case "measurementReminder.create":
      return t("recordSharing.activityVerb.measurementReminderCreate", {
        name,
      });
    case "measurementReminder.update":
      return t("recordSharing.activityVerb.measurementReminderUpdate", {
        name,
      });
    case "measurementReminder.delete":
      return t("recordSharing.activityVerb.measurementReminderDelete", {
        name,
      });
    case "measurementReminder.complete":
      return t("recordSharing.activityVerb.measurementReminderComplete", {
        name,
      });
    case "measurementReminder.satisfy":
      return t("recordSharing.activityVerb.measurementReminderSatisfy", {
        name,
      });
    // v1.37.20 (#223) — the honest skip and the snooze read differently in
    // the feed on purpose: one says a cycle was let go, the other that a due
    // date moved. Neither reads as "done".
    case "measurementReminder.skip":
      return t("recordSharing.activityVerb.measurementReminderSkip", {
        name,
      });
    case "measurementReminder.snooze":
      return t("recordSharing.activityVerb.measurementReminderSnooze", {
        name,
      });

    case "labResult.update":
      return t("recordSharing.activityVerb.labResultUpdate", { name });
    case "labResult.delete":
      return t("recordSharing.activityVerb.labResultDelete", { name });
    case "labResult.restore":
      return t("recordSharing.activityVerb.labResultRestore", { name });
    case "biomarker.update":
      return t("recordSharing.activityVerb.biomarkerUpdate", { name });
    case "biomarker.delete":
      return t("recordSharing.activityVerb.biomarkerDelete", { name });

    case "allergy.update":
      return t("recordSharing.activityVerb.allergyUpdate", { name });
    case "allergy.delete":
      return t("recordSharing.activityVerb.allergyDelete", { name });
    case "family-history.update":
      return t("recordSharing.activityVerb.familyHistoryUpdate", { name });
    case "family-history.delete":
      return t("recordSharing.activityVerb.familyHistoryDelete", { name });

    case "illness.episode.update":
      return t("recordSharing.activityVerb.illnessEpisodeUpdate", { name });
    case "illness.episode.delete":
      return t("recordSharing.activityVerb.illnessEpisodeDelete", { name });
    case "illness.episode.resolve":
      return t("recordSharing.activityVerb.illnessEpisodeResolve", { name });
    case "illness.episode.restore":
      return t("recordSharing.activityVerb.illnessEpisodeRestore", { name });
    case "illness.day-log.upsert":
      return t("recordSharing.activityVerb.illnessDayLogUpsert", { name });
    case "symptoms.definition.create":
      return t("recordSharing.activityVerb.symptomDefinitionCreate", { name });
    case "symptoms.definition.update":
      return t("recordSharing.activityVerb.symptomDefinitionUpdate", { name });
    case "symptoms.definition.delete":
      return t("recordSharing.activityVerb.symptomDefinitionDelete", { name });
    case "symptoms.event.update":
      return t("recordSharing.activityVerb.symptomEventUpdate", { name });
    case "symptoms.event.delete":
      return t("recordSharing.activityVerb.symptomEventDelete", { name });

    case "encounter.visit.update":
      return t("recordSharing.activityVerb.encounterVisitUpdate", { name });
    case "encounter.visit.delete":
      return t("recordSharing.activityVerb.encounterVisitDelete", { name });
    case "encounter.visit.restore":
      return t("recordSharing.activityVerb.encounterVisitRestore", { name });
    case "vaccination.record.update":
      return t("recordSharing.activityVerb.vaccinationRecordUpdate", { name });
    case "vaccination.record.delete":
      return t("recordSharing.activityVerb.vaccinationRecordDelete", { name });
    case "vaccination.record.restore":
      return t("recordSharing.activityVerb.vaccinationRecordRestore", { name });
    case "vaccination.custom.update":
      return t("recordSharing.activityVerb.customVaccineUpdate", { name });
    case "vaccination.custom.delete":
      return t("recordSharing.activityVerb.customVaccineDelete", { name });
    case "vaccination.booster.planned":
      return t("recordSharing.activityVerb.vaccinationBoosterPlanned", {
        name,
      });
    case "practitioner.contact.update":
      return t("recordSharing.activityVerb.practitionerContactUpdate", {
        name,
      });
    case "practitioner.contact.delete":
      return t("recordSharing.activityVerb.practitionerContactDelete", {
        name,
      });
    case "practitioner.contact.restore":
      return t("recordSharing.activityVerb.practitionerContactRestore", {
        name,
      });

    case "medication.update":
      return t("recordSharing.activityVerb.medicationUpdate", { name });
    case "medication.category.custom.create":
      return t("recordSharing.activityVerb.medicationCategoryCreate", {
        name,
      });
    case "medication.delete":
      return t("recordSharing.activityVerb.medicationDelete", { name });
    case "medication.glp1.update":
      return t("recordSharing.activityVerb.medicationGlp1Update", { name });
    case "medication.schedule_revision.created":
      return t("recordSharing.activityVerb.medicationScheduleCreate", { name });
    case "medication.schedule_revision.updated":
      return t("recordSharing.activityVerb.medicationScheduleUpdate", { name });
    case "medication.schedule_revision.deleted":
      return t("recordSharing.activityVerb.medicationScheduleDelete", { name });
    case "medication.inventory.create":
      return t("recordSharing.activityVerb.medicationInventoryCreate", {
        name,
      });
    case "medication.inventory.update":
      return t("recordSharing.activityVerb.medicationInventoryUpdate", {
        name,
      });
    case "medication.inventory.delete":
      return t("recordSharing.activityVerb.medicationInventoryDelete", {
        name,
      });
    case "medication.sideEffect.delete":
      return t("recordSharing.activityVerb.medicationSideEffectDelete", {
        name,
      });
    case "medication.intake.update":
      return t("recordSharing.activityVerb.medicationIntakeUpdate", { name });
    case "medication.intake.delete":
      return t("recordSharing.activityVerb.medicationIntakeDelete", { name });
    case "medication.intake.bulk_delete":
      return t("recordSharing.activityVerb.medicationIntakeBulkDelete", {
        name,
      });
    // The one that empties a medication's whole history in one request. It
    // says so, because "removed several doses" would read as a correction.
    case "medication.intake.purge":
      return t("recordSharing.activityVerb.medicationIntakePurge", { name });
    case "medication.intake.import.kickoff":
      return t("recordSharing.activityVerb.medicationIntakeImport", { name });
    case "medication.intake.history.import.kickoff":
      return t("recordSharing.activityVerb.medicationIntakeHistoryImport", {
        name,
      });

    case "moodEntry.create":
      return t("recordSharing.activityVerb.moodEntryCreate", { name });
    case "moodEntry.update":
      return t("recordSharing.activityVerb.moodEntryUpdate", { name });
    case "moodEntry.delete":
      return t("recordSharing.activityVerb.moodEntryDelete", { name });
    case "mood.delete.bulk":
      return t("recordSharing.activityVerb.moodDeleteBulk", { name });
    case "mood.restore":
      return t("recordSharing.activityVerb.moodRestore", { name });
    case "mental-health.create":
      return t("recordSharing.activityVerb.mentalHealthCreate", { name });

    case "cycle.cycle.delete":
      return t("recordSharing.activityVerb.cycleDelete", { name });
    case "cycle.day-log.upsert":
      return t("recordSharing.activityVerb.cycleDayLogUpsert", { name });
    case "cycle.day-log.update":
      return t("recordSharing.activityVerb.cycleDayLogUpdate", { name });
    case "cycle.day-log.delete":
      return t("recordSharing.activityVerb.cycleDayLogDelete", { name });
    case "cycle.period.boundary":
      return t("recordSharing.activityVerb.cyclePeriodBoundary", { name });
    case "cycle.symptom.custom.create":
      return t("recordSharing.activityVerb.cycleSymptomCreate", { name });

    case "nutrient.water.write":
      return t("recordSharing.activityVerb.nutrientWaterWrite", { name });

    // Not a change to the record, and the one act on this list that takes a
    // copy of all of it out of the instance. Named plainly for that reason.
    case "health-record.export":
      return t("recordSharing.activityVerb.healthRecordExport", { name });

    /* ---------------------------------------------------------------- */
    /* Attempts that were REFUSED, and things that happened around them. */
    /*                                                                   */
    /* Every delegable route files a `*.validation-failed` breadcrumb    */
    /* when a request does not parse, and it files it through            */
    /* `auditLog()` deliberately — that helper is what stamps            */
    /* `actorUserId`, and without the stamp a delegate's malformed       */
    /* request would read as the owner's own. So the rows are MEANT to   */
    /* reach the feed, and until this block existed every one of them    */
    /* rendered as "made a change in your record". Nothing changed. The  */
    /* one on a READ route is the sharpest case: a person with           */
    /* view-only access was reported to the owner as having edited       */
    /* something.                                                        */
    /*                                                                   */
    /* The language below never says "changed" or "added". A refusal is  */
    /* an attempt, and the sentence has to be one an owner can read      */
    /* without reaching for a phone.                                     */
    /* ---------------------------------------------------------------- */

    case "measurements.list.validation-failed":
    case "measurements.series.validation-failed":
      return t("recordSharing.activityVerb.rejectedMeasurementQuery", { name });
    case "medications.intake.list.validation-failed":
      return t("recordSharing.activityVerb.rejectedDoseQuery", { name });
    case "mood-entries.list.validation-failed":
      return t("recordSharing.activityVerb.rejectedMoodQuery", { name });

    case "measurements.create.validation-failed":
      return t("recordSharing.activityVerb.rejectedMeasurementCreate", {
        name,
      });
    case "measurements.create.batch.validation-failed":
      return t("recordSharing.activityVerb.rejectedMeasurementBatch", { name });
    case "measurements.update.validation-failed":
      return t("recordSharing.activityVerb.rejectedMeasurementUpdate", {
        name,
      });
    case "labs.create.validation-failed":
      return t("recordSharing.activityVerb.rejectedLabCreate", { name });
    case "labs.update.validation-failed":
      return t("recordSharing.activityVerb.rejectedLabUpdate", { name });
    case "labs.biomarker.create.validation-failed":
      return t("recordSharing.activityVerb.rejectedBiomarkerCreate", { name });
    case "labs.biomarker.update.validation-failed":
      return t("recordSharing.activityVerb.rejectedBiomarkerUpdate", { name });
    case "measurement-reminders.create.validation-failed":
      return t("recordSharing.activityVerb.rejectedReminderCreate", { name });
    case "measurement-reminders.update.validation-failed":
      return t("recordSharing.activityVerb.rejectedReminderUpdate", { name });
    case "mood-entries.create.validation-failed":
      return t("recordSharing.activityVerb.rejectedMoodCreate", { name });
    case "mood-entries.update.validation-failed":
      return t("recordSharing.activityVerb.rejectedMoodUpdate", { name });
    case "medications.intake.create.validation-failed":
      return t("recordSharing.activityVerb.rejectedDoseCreate", { name });
    // Both spellings of the same refusal, for the same reason the admitted
    // pair above carries both: the canonical route and the per-medication
    // one audit under different names and have since v1.0.0.
    case "medications.intake.update.validation-failed":
    case "medications.intake.event.update.validation-failed":
      return t("recordSharing.activityVerb.rejectedDoseUpdate", { name });
    case "medications.intake.import.validation-failed":
      return t("recordSharing.activityVerb.rejectedDoseImport", { name });
    case "custom-metric.entry.create.validation-failed":
      return t("recordSharing.activityVerb.rejectedTrackedValue", { name });
    // Not a validation failure: the request was well-formed and admitted,
    // and the queue would not take it. The owner sees an import that never
    // ran rather than one that was refused, because those need different
    // next steps.
    case "medication.intake.import.kickoff.denied":
      return t("recordSharing.activityVerb.deniedDoseImport", { name });

    /* ---------------------------------------------------------------- */
    /* Acts a delegable module performs outside its own route file.      */
    /*                                                                   */
    /* The two below are filed by library modules the routes import — a  */
    /* background worker's completion row and a lifecycle reconciliation */
    /* — and a guard that walked only `route.ts` could not see either.   */
    /* Both carry the actor through, so both reach the owner's feed.     */
    /* ---------------------------------------------------------------- */

    case "medication.intake.import":
      return t("recordSharing.activityVerb.medicationIntakeImportFinished", {
        name,
      });
    case "medication.oneShot.reconciled":
      return t("recordSharing.activityVerb.medicationOneShotReconciled", {
        name,
      });

    case "anamnesis.fact.create":
      return t("recordSharing.activityVerb.anamnesisFactCreate", { name });
    case "customMetric.create":
      return t("recordSharing.activityVerb.customMetricCreate", { name });
    case "customMetric.update":
      return t("recordSharing.activityVerb.customMetricUpdate", { name });
    case "customMetric.delete":
      return t("recordSharing.activityVerb.customMetricDelete", { name });
    case "documents.inbound.store":
      return t("recordSharing.activityVerb.documentStore", { name });
    case "documents.inbound.update":
      return t("recordSharing.activityVerb.documentUpdate", { name });
    case "documents.inbound.discard":
      return t("recordSharing.activityVerb.documentDiscard", { name });

    default:
      return t("recordSharing.activity.acted", { name });
  }
}
