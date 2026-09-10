/**
 * The one declaration of what a backup contains, and what it deliberately does
 * not.
 *
 * The wipe plan next door ({@link ../data-wipe/wipe-plan}) answers the mirror
 * question and got the same treatment for the same reason: a list that was
 * right the day it was written, then quietly stopped being right every time a
 * model was added. On the delete side that meant data survived a wipe. On this
 * side it means data does not survive a restore, which is worse, because a
 * wipe at least tells you it happened.
 *
 * ── Why this list is longer than the wipe list ──────────────────────────────
 *
 * The wipe may lean on the database: deleting a `Medication` cascades to its
 * schedules, dose changes and inventory events, so the wipe plan never has to
 * name them. **A restore has no cascade.** Every child has to be carried
 * explicitly and re-inserted explicitly, so sixteen models the wipe plan never
 * needed to mention are decisions here.
 *
 * ── The three verdicts ──────────────────────────────────────────────────────
 *
 * `BACKED_UP`   — the account would lose something real if this were missing.
 *
 *                 Split in two below, because "must be carried" and "is
 *                 carried" are different claims and this file used to make
 *                 only the first. {@link TWO_ENDED_MODELS} names the models
 *                 with BOTH a payload reader and a restore branch, checked by
 *                 the guard beside this file. {@link COVERAGE_PENDING} names
 *                 the rest, each with what an account loses meanwhile.
 *
 *                 An earlier draft of this comment claimed the two-ended guard
 *                 in the present tense. It did not exist then. That is the same
 *                 defect this file was written to prevent, so it is recorded
 *                 rather than quietly corrected — and it is why the guard now
 *                 reads the source rather than trusting a list.
 *
 *                 Reading the source is still not the same as watching the data
 *                 move: a restore branch wrapped in `if (false)` reads exactly
 *                 like one that works. So the claim is settled end to end in
 *                 `tests/integration/backup-round-trip.test.ts`, which seeds a
 *                 row of every model named here, exports it, deletes the
 *                 account and counts the row back out of the real restore.
 * `DERIVED`     — recomputable from `BACKED_UP` rows. Leaving it out keeps the
 *                 file smaller and cannot lose anything; the reason names what
 *                 recomputes it.
 * `NOT_IN_BACKUP` — deliberately excluded. Credentials that must not travel,
 *                 provider handshake state that is meaningless on another
 *                 host, ledgers whose value is that they were written here.
 *
 * Every entry carries its reason in prose. "Obvious" is not a reason: the
 * whole class of defect here is someone deciding something was obvious and
 * nobody being able to check afterwards.
 */

/** A model whose absence from a restore would lose something the account owns. */
export const BACKED_UP_MODELS = [
  // ── Measurements ──────────────────────────────────────────────────────────
  "Measurement",
  // Not derived, despite looking it. The hourly shape of a cumulative day is
  // folded out of the per-sample rows in the same transaction that deletes
  // them, so past the 36-hour grace window there is nothing left to rebuild it
  // from. A restore without it silently resets the same-time baseline to
  // "still learning" for two weeks.
  "IntradayCumulativeProfile",

  // ── Medications, and everything hanging off one ───────────────────────────
  // The parent alone restores a drug list with no schedule, no history and no
  // stock — a shape the app renders without complaint, which is why this was
  // easy to miss.
  "Medication",
  "MedicationSchedule",
  "MedicationScheduleRevision",
  "MedicationDoseChange",
  "MedicationIntakeEvent",
  "MedicationPauseEra",
  "MedicationSideEffect",
  "MedicationEfficacyTarget",
  "MedicationInventoryItem",
  "MedicationInventoryEvent",

  // ── Mood ──────────────────────────────────────────────────────────────────
  "MoodEntry",
  "MoodContext",
  "MoodEntryTagLink",
  "MoodTag",
  "MoodTagCategory",
  "MoodTagHidden",

  // ── Clinical record ───────────────────────────────────────────────────────
  "MentalHealthAssessment",
  "LabResult",
  "Biomarker",
  "Allergy",
  "FamilyHistoryEntry",
  "IllnessEpisode",
  "IllnessDayLog",
  "IllnessSymptomLink",
  "EcgRecording",
  "UserHealthProfile",
  "HealthProfileFactRevision",
  "MeasurementReminder",
  // The Vorsorge completion ledger (v1.37.20, #223 / iOS #68). Looks derived
  // and is the opposite: the reminder engine is single-cursor, so each satisfy
  // overwrites the previous one on the reminder row and this table is the only
  // copy of everything before the latest. Nothing can rebuild it, which is the
  // exact test for BACKED_UP.
  "MeasurementReminderEvent",

  // ── Cycle ─────────────────────────────────────────────────────────────────
  "CycleProfile",
  "MenstrualCycle",
  "CycleDayLog",
  "CycleSymptom",
  "CycleSymptomLink",

  // ── Custom metrics ────────────────────────────────────────────────────────
  "CustomMetric",
  "CustomMetricEntry",
  "CorrelationPattern",
  // Reads like a derived tier and is not one. The live computation always
  // answers for today from today's rows, so once the readings behind a past
  // day have been corrected, re-synced or simply grown, nothing can reproduce
  // what that day said. The row is the only copy of the number the account
  // actually saw, which is exactly the test for BACKED_UP rather than DERIVED.
  "HealthScoreRecord",

  // ── Activity and nutrition ────────────────────────────────────────────────
  "Workout",
  "WorkoutRoute",
  "WorkoutSamples",
  "NutrientIntakeDay",
  "PersonalRecord",
  "UserAchievement",

  // ── Environment ───────────────────────────────────────────────────────────
  "EnvironmentContext",
  "EnvironmentTravelLocation",

  // ── Documents ─────────────────────────────────────────────────────────────
  "InboundDocument",
  "DocumentConditionLink",
  "ExtractedFact",

  // ── Visits ────────────────────────────────────────────────────────────────
  "Practitioner",
  "Encounter",
  "EncounterDocumentLink",
  "EncounterLabLink",
  "EncounterConditionLink",

  // ── Vaccinations ──────────────────────────────────────────────────────────
  // An immunization history is the one part of a health record that has no
  // other copy: the paper Pass is the original, and once it has been
  // transcribed the transcription is what the person relies on. Nothing
  // re-syncs it from a provider.
  "VaccinationRecord",
  "VaccinationDocumentLink",

  // ── Coach ─────────────────────────────────────────────────────────────────
  // The transcript — conversation, message, attachment — travels; see
  // `src/lib/export/coach-backup.ts`. What is still owed is the Coach's
  // MEMORY: the facts, plans and reminders it carries between threads. Each of
  // those addresses a conversation by `sourceConversationId`, so they follow
  // the transcript rather than lead it.
  "CoachConversation",
  "CoachMessage",
  "CoachConversationDocument",
  "CoachFact",
  "CoachPlan",
  "CoachReminder",

  // ── Preferences and consent ───────────────────────────────────────────────
  // `NotificationPreference` used to sit here. It moved to the deliberate
  // exclusions: it addresses a notification channel by a hard foreign key, and
  // the channel itself is excluded for carrying secrets, so there is nothing
  // for a restored preference to attach to.
  "ReminderPhaseConfig",
  "ConsentReceipt",
  // The setup answers. Nothing recomputes them: the module map they produced
  // survives on the `User` row, but the map says what is switched on, not that
  // the person said they take medication daily and have a visit next month. A
  // restore without the row opens a blank questionnaire for somebody who has
  // already answered it.
  "OnboardingRecord",
] as const;

/**
 * The files that carry a backed-up model OUT of the database, and the files
 * that put one back.
 *
 * Declared rather than discovered, because discovery is what keeps going
 * wrong here. A previous review grepped the restore ROUTE, concluded the cycle
 * data was never restored, and had to retract it publicly: the route delegates
 * to `restoreCycleData`, and a grep of the route alone lies. The profile and
 * custom-metric pair added later delegates the same way, on purpose.
 *
 * Keeping both lists here means a new section has to say where its two ends
 * live, and the guard reads those files instead of guessing which ones matter.
 */
export const BACKUP_WRITER_FILES: readonly string[] = [
  "src/lib/export/full-backup-payload.ts",
  // Measurements are read through this pager, not directly. The guard caught
  // its absence from this list on the first run — the same "the caller
  // delegates" mistake the list exists to prevent, made while writing the list.
  "src/lib/export/paged-measurements.ts",
  "src/lib/export/records-backup.ts",
  // The illness day-log's symptom include is a shared constant living here,
  // not a literal in the records writer. Same "the caller delegates" shape as
  // the measurement pager above, found the same way: by a check that stopped
  // accepting one model's relation write as proof about another's.
  "src/lib/illness/dto.ts",
  "src/lib/export/profile-backup.ts",
  "src/lib/export/intraday-profile-backup.ts",
  "src/lib/export/health-score-backup.ts",
  // Visits, the address book and the three link tables. Each model reads
  // through its OWN delegate here rather than riding a relation, because
  // `documentLinks` is a field name on two different models and a
  // relation-shaped proof would be attributed to whichever one a matcher found
  // first — the `symptomLinks` confusion, avoided by construction.
  "src/lib/export/visits-backup.ts",
  // The immunization log and its document link, same arrangement for the same
  // reason: `documentLinks` is a field name on three models now, so each of
  // these reads through its OWN delegate here.
  "src/lib/export/vaccinations-backup.ts",
  // The Vorsorge reminders and their completion ledger, both ends beside each
  // other like the visits and vaccinations above.
  "src/lib/export/reminders-backup.ts",
  // The Coach transcript, same arrangement. `attachments` is a relation name
  // this file shares with nothing else, but each model still reads through its
  // own delegate here for the reason the visits comment gives.
  "src/lib/export/coach-backup.ts",
  // The screener history and the consent record, disaster-recovery only. The
  // reasons for that live in the module itself.
  "src/lib/export/sensitive-backup.ts",
  // What a document was filed against and what was read out of it. The
  // documents themselves are read by `records-backup.ts`; these two read
  // through their OWN delegates here, for the reason the visits comment gives.
  "src/lib/export/document-filing-backup.ts",
  // The bests and the badges, and the environmental history with the location
  // periods that explain it. Two files rather than one because they are two
  // unrelated parts of the record, both with their ends beside each other for
  // the reason the visits comment gives.
  "src/lib/export/awards-backup.ts",
  "src/lib/export/environment-backup.ts",
  // The needs-based setup answers, both ends beside each other for the reason
  // the visits comment gives.
  "src/lib/export/onboarding-backup.ts",
  // The ECG strips, same arrangement again. The recording reads through its
  // OWN delegate here rather than riding the measurement it references,
  // because that reference is a pointer between two independently carried
  // tables and not a parent-child ride.
  "src/lib/export/ecg-backup.ts",
  "src/lib/cycle/backup.ts",
];

export const BACKUP_RESTORE_FILES: readonly string[] = [
  "src/app/api/admin/backups/[id]/restore/route.ts",
  "src/lib/export/profile-backup.ts",
  "src/lib/export/intraday-profile-backup.ts",
  "src/lib/export/health-score-backup.ts",
  "src/lib/export/visits-backup.ts",
  "src/lib/export/vaccinations-backup.ts",
  "src/lib/export/reminders-backup.ts",
  "src/lib/export/coach-backup.ts",
  "src/lib/export/sensitive-backup.ts",
  "src/lib/export/document-filing-backup.ts",
  "src/lib/export/awards-backup.ts",
  "src/lib/export/environment-backup.ts",
  "src/lib/export/onboarding-backup.ts",
  "src/lib/export/ecg-backup.ts",
  "src/lib/cycle/backup.ts",
];

/**
 * Backed-up models that genuinely travel BOTH ways.
 *
 * The guard checks each of these against the files above: a read in a writer
 * file and a write in a restore file, counting a relation carried inside its
 * parent (`include: { schedules: true }` out, `schedules: { create: … }` back)
 * as covered, because that is how the child rows actually ride.
 *
 * A model moves onto this list when its two ends land, never before. That is
 * the whole point of the split — a verdict of `BACKED_UP` is an intention, and
 * an intention is what the nutrient day totals had while a restore was throwing
 * them away and reporting success.
 *
 * Frozen as a literal tuple so {@link TwoEndedModel} can key the round-trip
 * test's seed registry. Adding a name here without seeding a row for it is then
 * a compile error rather than a silently unproven claim.
 */
export const TWO_ENDED_MODELS = [
  "Measurement",
  "IntradayCumulativeProfile",
  "Medication",
  "MedicationSchedule",
  "MedicationIntakeEvent",
  "MedicationSideEffect",
  "MedicationPauseEra",
  "MedicationDoseChange",
  "MoodEntry",
  "MoodContext",
  "MoodEntryTagLink",
  "MoodTag",
  "LabResult",
  "Biomarker",
  "Allergy",
  "FamilyHistoryEntry",
  "IllnessEpisode",
  "IllnessDayLog",
  "IllnessSymptomLink",
  "UserHealthProfile",
  "HealthProfileFactRevision",
  "CycleProfile",
  "MenstrualCycle",
  "CycleDayLog",
  "CycleSymptom",
  "CycleSymptomLink",
  "CustomMetric",
  "CustomMetricEntry",
  "CorrelationPattern",
  "HealthScoreRecord",
  "Workout",
  "NutrientIntakeDay",
  "InboundDocument",
  // Visits travel both ways from the release that introduces them. A
  // COVERAGE_PENDING neighbour already says what the alternative costs — the
  // filing between documents and conditions is lost. Leaving the visit links
  // pending would return visits and documents with nothing between them — the
  // same loss, one layer deeper — so the links land carried rather than owed.
  "Practitioner",
  "Encounter",
  "EncounterDocumentLink",
  "EncounterLabLink",
  "EncounterConditionLink",
  // Doses travel both ways from the release that introduces them, and the
  // link with them. `DocumentConditionLink` was the register entry that said
  // what the alternative costs — documents and conditions both restore, the
  // filing between them does not — and it has since landed carried itself, at
  // the bottom of this list. Repeating that debt here would have returned a
  // restored Impfpass scan and a restored dose with nothing between them,
  // which is the same regret against a record a person cannot reconstruct
  // from anywhere else.
  "VaccinationRecord",
  "VaccinationDocumentLink",
  // The Vorsorge reminders, off the debt register at last (v1.37.20, #223 /
  // iOS #68), and the completion ledger carried with them from the release
  // that introduces it. The pairing is deliberate: the ledger arriving is
  // what turned "a restore leaves the account silent" from an inconvenience
  // into a history loss, because the single-cursor engine keeps no other copy
  // of past satisfies and skips. Restoring the reminder without its ledger
  // would hand back a cadence with no evidence it was ever followed; the two
  // land together. The encounter and vaccination `reminderId` references stop
  // dropping to NULL in the same release — the rows they name come back now.
  "MeasurementReminder",
  "MeasurementReminderEvent",
  // The Coach's transcript. The register entry for the messages called them
  // "the largest volume of free text an account owns after its documents",
  // and until now a restored account got a Coach that had never spoken to it.
  // The three travel together because two of them are meaningless alone: a
  // turn without its thread has nowhere to hang, and an attachment names a
  // pairing rather than a thing.
  //
  // `documentScoped` is the field that makes this more than history. It is a
  // permanent fence — no code path lowers it — so a restore that let it
  // default to false would hand the tool loop back to precisely the
  // conversations the fence exists to keep away from it, invisibly. It is
  // carried and asserted, not defaulted.
  "CoachConversation",
  "CoachMessage",
  "CoachConversationDocument",
  // And what the Coach keeps between threads. The transcript alone restores an
  // account with every word of every conversation and a Coach that has to be
  // told its own history again.
  //
  // Both of the references here — `sourceConversationId` on all three,
  // `relatedPlanId` on the reminder — are bare id columns with no foreign key,
  // so a value pointing at nothing costs no error and just stops meaning
  // anything. The restore resolves them against what it wrote and reports what
  // it could not, rather than writing a pointer it knows is dead.
  "CoachFact",
  "CoachPlan",
  "CoachReminder",
  // The packs on the shelf and the ledger behind their counts. The two travel
  // together because the register itself paired them: without the events the
  // count "cannot be rebuilt even in principle", and without the packs the
  // events are a list of deltas against nothing.
  //
  // `unitsRemaining` is restored verbatim rather than recomputed from the
  // ledger. It is the value the server had resolved and the person was shown,
  // and every low-stock reminder already sent was computed from it — a restore
  // that recalculated would disagree with the account's own history.
  "MedicationInventoryItem",
  "MedicationInventoryEvent",
  // The mood taxonomy the account shaped for itself. The category is not a
  // nicety: `MoodTag.categoryId` is a real foreign key, so a category the
  // person created and the file did not carry made the restore violate a
  // constraint and roll the WHOLE account back. The register described this as
  // custom tags landing in a grouping that no longer exists; measured, it was
  // a 500 and an empty account.
  //
  // The hidden set travels by KEY rather than id, because what people hide is
  // almost always a seeded tag whose id differs on every instance.
  "MoodTagCategory",
  "MoodTagHidden",
  // Per-drug reminder phase timings: one row per medication, nested inside it,
  // needing nothing the drug does not already bring. The register filed it
  // next to the notification preferences as "the same shape of loss". It is
  // not the same shape at all — this one hangs off something that travels,
  // which is exactly why it could be cleared in an afternoon and the other
  // could not be cleared at all.
  "ReminderPhaseConfig",
  // Two models that ride in a disaster-recovery file and deliberately not in a
  // portable one. Everywhere else that split is about ENCODING; here it is
  // about whether the row should leave the instance at all, and the two
  // reasons are different from each other. Both are written out in
  // `src/lib/export/sensitive-backup.ts`, and the portable file discloses the
  // omission in its own manifest rather than reporting an account that has
  // neither.
  "MentalHealthAssessment",
  "ConsentReceipt",
  // What the vault was sorted into, and what was read out of it. The register
  // called the first "a restored vault is unsorted" and the second
  // "re-derivable only by re-running the extraction against a provider, at the
  // operator's cost". The second understated it: what a re-run cannot produce
  // is the REVIEW DECISION on each fact, and every column holding one defaults
  // to "nobody has looked at this yet". The confirm endpoint acts on a PENDING
  // fact by committing it into the structured store, so a restore that
  // defaulted them would offer an already-committed reading for approval a
  // second time and write a second lab result behind it.
  //
  // Both references are real foreign keys, unlike the Coach's, so the failure
  // they guard against is not a dead pointer but an aborted transaction: the
  // builder carries a filing or a fact only when both of its ends are carried,
  // and the restore drops and names what a hand-edited file still cannot
  // place. `committedRecordId` is the one bare id column here, and it is
  // nulled together with its type when it resolves to nothing.
  "DocumentConditionLink",
  "ExtractedFact",
  // What the account earned. The register called the bests "recomputable in
  // principle", which is true and does not help: nothing recomputes them, and
  // a recomputation over a restored history would not find the same rows:
  // sample series and GPS routes never travel, a portable file omits deleted
  // readings, and a best found in a reading that has since been corrected is
  // not findable twice. The badge's unlock date is worse than that. The
  // evaluator prefers a persisted date over a derived one, and several of the
  // dates it can derive come from counters this backup deliberately excludes,
  // so a dropped row does not relock the badge, it re-earns it today.
  //
  // `PersonalRecord.sourceMeasurementId` is the reference that needs care, and
  // it is the dangerous kind: the schema declares no relation, but migration
  // 0054 created the column as a real foreign key against `measurements`. The
  // restore therefore runs after the measurements and nulls what it cannot
  // resolve, because the alternative is not a dangling pointer, it is Postgres
  // refusing the file and handing back an empty account.
  "PersonalRecord",
  "UserAchievement",
  // The per-day readings and the location periods, which travel as a pair
  // because the register's own two lines say why: the readings are "joined to
  // the record", and the periods are "what makes the environmental readings
  // mean anything". Measured, the pairing is stronger than context. Carrying
  // the readings alone would let the nightly seven-day refresh re-resolve every
  // trip day to the home location and UPSERT over it, so an account would come
  // back with a fortnight abroad and then quietly have it rewritten as a
  // fortnight at home, days after a restore that reported success.
  "EnvironmentContext",
  "EnvironmentTravelLocation",
  // How a schedule got to where it is. The register said a restored
  // medication keeps today's schedule and loses the record of when the dose or
  // the timing moved. Measured, it costs more than a record: the era minter
  // reads past days against the schedule that was live THEN, so an account
  // that came back without its eras has its own compliance history rewritten
  // against a plan it was not on.
  //
  // `supersededByRevisionId` is the reference that made this its own problem.
  // It is a bare id column with no `@relation`, so a dangling value costs no
  // error and simply stops meaning anything — and every era consumer skips a
  // row that carries it, which means losing the pointer puts a corrected era
  // back on the timeline beside its own correction. It travels as a POSITION
  // in the drug's own ordered era list, because a portable restore mints fresh
  // ids and the list is the only address space both ends share.
  "MedicationScheduleRevision",
  // What each drug was supposed to move. The register said the drug comes
  // back with no statement of what it was for, and that is exactly the row:
  // one exists ONLY where the person overrode the derived ATC / name
  // resolution, so it is a decision and never a computation.
  //
  // It travels by biomarker NAME rather than by id, the way a lab result's
  // cross-reference does, because a portable restore mints a fresh catalogue
  // id and `(userId, name)` is what the catalogue is unique on. The reference
  // is a real foreign key, so a name the restore cannot resolve is dropped and
  // reported rather than written — a dangling id here would fail the
  // constraint and cost the whole account.
  "MedicationEfficacyTarget",
  // The ECG strips. The register said the originating device may still hold
  // them, which is true for about as long as the phone beside it does — and
  // is not true at all once a Withings connection is revoked, because the
  // signal id stops resolving with it.
  //
  // `measurementId` is the reference that made this more than a copy job. It
  // is a REAL foreign key against the EVENT measurement the strip was filed
  // with, so a value the restore cannot resolve does not dangle quietly the
  // way the Coach's `sourceConversationId` does: it violates the constraint
  // and takes the whole account down with it. A portable export omits
  // soft-deleted measurements, so that case is reachable rather than
  // theoretical. The reference is resolved against what the restore wrote,
  // nulled when it cannot be, and reported either way.
  "EcgRecording",
  // The setup answers, carried from the release that introduces them. There is
  // no debt entry to write instead: the row is one small object with no
  // reference to resolve, so "carried" and "owed" would have cost the same
  // afternoon and only one of them returns a record that can say "set up
  // again" and mean it.
  //
  // `modulesDerivedAt` is the field that makes this more than history. It is
  // the once-only latch on the module derivation, so a restore that let it
  // default to null would hand the next confirm permission to re-apply the
  // questionnaire over every module decision taken in Settings since. It is
  // carried and asserted, not defaulted.
  "OnboardingRecord",
] as const;

/** One model claimed to travel both ways. */
export type TwoEndedModel = (typeof TWO_ENDED_MODELS)[number];

/**
 * Two-ended models whose coverage the structural check cannot ATTRIBUTE, with
 * the reason each defeats it.
 *
 * Not an exemption from being carried — every model here is carried, and the
 * round-trip test proves it by seeding a row, exporting, emptying the account
 * and reading the row back out of the restore. It is an exemption from being
 * proven by reading source text, and it exists so the limit is written down in
 * one place instead of showing up as a green check that means nothing.
 *
 * A model earns a line here only when a same-file grep genuinely cannot tell
 * two tables apart. The guard beside this file checks that each one is covered
 * by the round trip, so naming a model here moves the burden of proof rather
 * than dropping it.
 */
export const STRUCTURALLY_UNATTRIBUTABLE: Readonly<Record<string, string>> = {
  IllnessSymptomLink:
    "Read out through `dayLogSymptomInclude`, a shared include constant in `src/lib/illness/dto.ts` that names `symptomLinks` with no query beside it. `symptomLinks` is also `CycleDayLog`'s field for `CycleSymptomLink`, so the name alone cannot say which table a line is about, and the parent that would disambiguate it — `IllnessDayLog` — is reached transitively through the episode's `dayLogs` include in another file. Deleting the illness branch from the restore route left the old check green on the strength of the cycle write; the round trip is what notices now.",
};

/**
 * Backed-up models that do NOT travel yet, each with what an account loses
 * until it does.
 *
 * This is a debt register, not a design. Every line is a restore that comes
 * back short without saying so, which is the failure mode the whole file
 * exists to make visible. The reasons say what goes missing rather than
 * "not yet", so the next person can order the work by what it costs a person
 * rather than by what is cheapest to write.
 */
export const COVERAGE_PENDING: Readonly<Record<string, string>> = {
  WorkoutRoute:
    "GPS traces. Deliberately absent from the payload today and DISCLOSED as absent in the file's own manifest, which is why this is a documented exclusion rather than a silent one — but it is still a loss for a self-hoster with no other copy.",
  WorkoutSamples:
    "Per-sample heart-rate and pace series behind a workout summary. Same disclosed-exclusion status as the routes above, same cost.",
};

/**
 * Recomputable from backed-up rows. The reason names what rebuilds it, so a
 * future reader can check the claim rather than trust it.
 */
export const DERIVED_MODELS: Readonly<Record<string, string>> = {
  MeasurementRollup:
    "A per-day, per-metric reconstruction of `Measurement`. The boot-time rollup backfill rebuilds it for an account that has none.",
  MedicationComplianceRollup:
    "Recomputed from `MedicationIntakeEvent` against the schedule by the compliance analytics tier.",
  MoodEntryRollup:
    "A per-day reconstruction of `MoodEntry`, rebuilt by the same rollup tier that rebuilds the measurement one.",
  MoodPrediction:
    "What the account's own past days imply about a day, fitted from `MoodEntry` + `MoodContext` and the linked modules. The nightly `mood-prognosis-refresh` job rebuilds it after a restore, and rebuilding it is better than carrying it: a restored row would state a forecast made by a model version that may no longer exist, against data the restore has just moved.",
  CyclePrediction:
    "A forecast derived from `MenstrualCycle` history; regenerated on the next cycle read.",
  StrainTrimpCache:
    "A cache of a pure function over `Workout` and heart-rate samples.",
  WorkoutInsight:
    "Generated narrative over `Workout`; regenerates on demand. Carrying it would restore an interpretation of data rather than the data.",
  WorkoutInsightGenerationClaim:
    "A concurrency claim guarding the generator above. Meaningless outside the run that took it.",
  InsightNarrative:
    "Generated prose over measurements. Same reasoning as WorkoutInsight — the record restores, the essay about it does not.",
  DocumentContentIndex:
    "A search index over `InboundDocument` text; rebuilt by the indexer.",
  DocumentThumbnail:
    "Rendered from the stored document bytes on demand. Those bytes travel in a disaster-recovery payload, so the picture rebuilds itself on first view; a portable export carries metadata only, and there the thumbnail has nothing to rebuild from — but neither does the document, so nothing is lost that the export did not already disclose.",
  ArrivalReaction:
    "Derived from what changed since the last visit; recomputed per visit.",
  DismissedPriorityItem:
    "A per-item dismissal of a recomputed priority list. The list regenerates; a stale dismissal would suppress an item the new list means to raise.",
};

/**
 * Deliberately excluded, with the reason. These are the entries most likely to
 * be argued with later, so each says what it would cost to include.
 */
export const NOT_IN_BACKUP_MODELS: Readonly<Record<string, string>> = {
  // Provider credentials and handshake state.
  WithingsConnection:
    "An OAuth grant bound to this deployment's client registration. Restored elsewhere it is a dead token that makes the integration look connected while it silently fails — the exact shape of defect this release is about.",
  WithingsOAuthState:
    "A CSRF nonce for a handshake that is valid for minutes and is already over by the time any backup is read.",
  WhoopConnection:
    "An OAuth grant bound to this deployment's client registration; on another host it is a dead token that reads as connected.",
  WhoopOAuthState:
    "A CSRF nonce for a handshake that is valid for minutes and is already over by the time any backup is read.",
  WhoopConnectTicket:
    "A single-use ticket that binds one connect attempt to one browser; spent or expired long before a restore.",
  FitbitConnection:
    "An OAuth grant bound to this deployment's client registration; on another host it is a dead token that reads as connected.",
  FitbitOAuthState:
    "A CSRF nonce for a handshake that is valid for minutes and is already over by the time any backup is read.",
  GoogleHealthConnection:
    "An OAuth grant bound to this deployment's client registration; on another host it is a dead token that reads as connected.",
  GoogleHealthOAuthState:
    "A CSRF nonce for a handshake that is valid for minutes and is already over by the time any backup is read.",
  McpOAuthConnection:
    "A grant issued to a client that was registered against this instance.",
  IntegrationStatus:
    "A ledger of what this deployment's syncs did. Restoring it onto another host would assert a sync history that host never had.",

  // Credentials and device identity.
  ApiToken:
    "Bearer credentials. A backup file is not a credential store, and a leaked file must not become a set of working tokens.",
  Device:
    "An APNs token identifying one install on one phone. Restored elsewhere it addresses a device that will never receive from this host.",
  PushSubscription:
    "A Web Push endpoint issued by one browser for one origin. Another host cannot send to it, and the browser that owns it re-subscribes on its own.",
  NotificationChannel:
    "Carries channel secrets (Telegram chat binding, ntfy topic). Same reasoning as ApiToken.",
  // Moved here from the coverage-pending register. The entry there read "a
  // restore reverts to defaults, so an account that had deliberately silenced
  // a category starts being notified again", which implies the tuning is
  // recoverable and merely unbuilt. It is not. A preference addresses ONE
  // channel by a hard foreign key, the restore deletes every channel, and the
  // channel model is deliberately excluded right above this line. A carried
  // preference would point at a row that cannot exist — the same constraint
  // violation the custom mood categories were causing, waiting to happen.
  // Re-applying somebody's tuning to a channel they add AFTER a restore is a
  // feature about channel TYPES, not a backup contract about rows.
  NotificationPreference:
    "Per-event choices, each bound to one notification channel by a foreign key. The channel is excluded above and the restore deletes every one, so a carried preference would address a channel that will never exist.",
  UserKnownDevice:
    "A device-recognition ledger. Restoring it would pre-trust devices on a host that has never seen them.",
  StepUpElevation:
    "Proof that a second factor was satisfied minutes ago. Carrying it would let a restored file re-grant an elevation nobody performed.",

  // Ledgers whose meaning is local to the deployment.
  PushAttempt:
    "A 90-day delivery ledger for this host's sends. Restoring it onto another host would assert sends it never made.",
  NotificationEvent:
    "A local notification dedup anchor. Restoring it onto another host would suppress reminders and safety notices that host still owes.",
  NotificationEgressAuthorization:
    "A short-lived, deployment-local Guardian egress ledger. It retains no notification content, credentials, or deduplication key, and its outcome is observation rather than authorization; restoring it would nevertheless carry stale send history to a host that must recheck the live grant before every send. Exclude it so a backup never exports notification-derived privacy metadata or makes a restored host reason from another host's delivery work.",
  AuditLog:
    "An append-only record of actions taken on this instance. Merging one instance's audit trail into another's would make the trail untrue.",
  CoachUsage:
    "Spend metering against this operator's own AI budget. Restoring it would charge one instance's consumption against another instance's cap.",
  ProviderHealth:
    "What this host observed when it called its providers. Another host has its own network, keys and rate limits, so the observation does not transfer.",
  IdempotencyKey:
    "Replay protection for requests this host already answered. Restoring it would suppress a legitimate new request.",
  DataBackup:
    "The backup catalogue itself. A backup that contains the list of backups is a recursion with no reader.",
  OffhostBackupState:
    "When this host last put this account's copy in this operator's bucket, and how big it was. It describes one deployment's relationship with one bucket, so restoring it elsewhere would assert an off-host copy that host has never written.",
  ImportJob:
    "A job record pointing at an uploaded file that the backup does not carry, so restoring it would resurrect a task with nothing to work on.",
  InviteToken:
    "The instance's registration ledger, minted by the operator rather than by the person, and already declared instance-scoped by the wipe plan. Restoring one account's backup must not re-open a registration code the operator retired, and the creator relation is the only thing that makes this look account-scoped at all. It surfaced here when the classification check learned to read a relation by type instead of by field name.",
  MedicationIntakeImportJob:
    "A job record pointing at an uploaded dose-history file that is not carried in the backup, so restoring the job would resurrect a task with nothing to work on.",
  TelegramPromptContext:
    "Records which reminder a Telegram reply refers to, keyed by a message id in one chat on one bot. Meaningless against any other chat, and the conversation it belongs to is not carried either.",

  // Sharing and outbound links.
  AccountGrant:
    "Live authorization over another person's health record. A backup is a snapshot of DATA, and rolling data back is a decision the owner's admin makes; rolling an authorization back is a decision nobody makes — the grant an owner revoked on Tuesday would come back alive out of Monday's file, silently, with no notification and nobody aware that access resumed. Every credential-shaped row in this file is excluded for that reason (ApiToken, TrustedDevice, StepUpElevation, UserKnownDevice) and a share link for the closest one (ClinicianShareLink). The cost is stated rather than hidden: after a disaster restore, sharing is OFF and the owner has to invite again and the delegate has to accept again. That is the fail-safe direction — access lost, never access resumed — and re-consenting after a restore is the correct amount of ceremony for handing someone your health record a second time.",
  ClinicianShareLink:
    "A live URL handed to a practice. Restoring it would resurrect a link the account may have revoked deliberately — and it points at a host that may not be this one.",
  ClinicianShareLinkDocument:
    "Names which documents a share link exposed. Without the link it grants nothing, and with it, it would re-expose files through a URL the account may have revoked.",

  // Transient notification bookkeeping.
  MoodReminderDispatch:
    "A per-day record of whether this host already sent today's prompt. The next day writes its own, and a restored one would suppress a send.",
  TelegramScheduledDeletion:
    "A pending delete addressed at message ids in one chat on one bot. Those ids mean something else, or nothing, anywhere the messages do not exist.",
  TelegramReminderMessage:
    "Message ids in one chat on one bot, used to edit or clean up a sent reminder. They address messages that a restored instance never sent.",
  RecommendationFeedback:
    "Feedback on generated recommendations that are themselves DERIVED. Restoring the feedback without the item it judged leaves an orphan.",
};

/** Auth material: not user data, and excluded from the wipe for the same reason. */
export const AUTH_MODELS_OUT_OF_SCOPE: readonly string[] = [
  "Session",
  "RefreshToken",
  "Passkey",
  "WebauthnMfaCredential",
  "MfaRecoveryCode",
  "MfaChallenge",
  "AuthChallenge",
  "TrustedDevice",
  "OidcNativeHandoff",
  "InviteRedemption",
];

export type BackupVerdict = "BACKED_UP" | "DERIVED" | "NOT_IN_BACKUP" | "AUTH";

/**
 * The verdict for a model, or `null` when the schema carries a model this file
 * has never ruled on. The guard turns that `null` into a failing test, which
 * is the whole point: a new model gets a decision, not a default.
 */
export function backupVerdict(model: string): BackupVerdict | null {
  if ((BACKED_UP_MODELS as readonly string[]).includes(model)) {
    return "BACKED_UP";
  }
  if (model in DERIVED_MODELS) return "DERIVED";
  if (model in NOT_IN_BACKUP_MODELS) return "NOT_IN_BACKUP";
  if (AUTH_MODELS_OUT_OF_SCOPE.includes(model)) return "AUTH";
  return null;
}
