/**
 * The backup's domains, and the order a restore runs them in.
 *
 * Each domain keeps its schema slice, its export and its restore together in
 * its own module (`<domain>-backup.ts`, with `-restore.ts` and
 * `-backup-schema.ts` beside it where those are large). This file only says
 * in which order the restore calls them (the export's order, which is the
 * file's key order, is `backup-export-sections.ts`). The order is the whole
 * content:
 *
 *   - The account is emptied first, child before parent wherever a count
 *     is reported, because a parent's delete cascades into its children and
 *     the child's count would then read zero.
 *   - A step that points into another domain runs after the step that writes
 *     the target, and reads what that step wrote from `ctx.links`. Each
 *     ordering constraint is stated beside the step it binds.
 *
 * Everything runs inside the one restore transaction (`restore-backup.ts`),
 * so a failure in any step leaves the account exactly as it was.
 */
import { restoreCycleData } from "@/lib/cycle/backup";
import { restoreAccountSettings } from "@/lib/export/account-settings-restore";
import {
  clearAllergies,
  restoreAllergies,
} from "@/lib/export/allergies-backup";
import { restoreAppSettings } from "@/lib/export/app-settings-backup";
import { restoreAwardsData } from "@/lib/export/awards-backup";
import {
  restoreCoachData,
  restoreCoachMemoryData,
} from "@/lib/export/coach-backup";
import { restoreDocumentFilingData } from "@/lib/export/document-filing-backup";
import {
  clearDocuments,
  restoreDocuments,
} from "@/lib/export/documents-backup";
import { restoreEcgData } from "@/lib/export/ecg-backup";
import { restoreEnvironmentData } from "@/lib/export/environment-backup";
import {
  clearFamilyHistory,
  restoreFamilyHistory,
} from "@/lib/export/family-history-backup";
import { restoreHealthScoreData } from "@/lib/export/health-score-backup";
import { clearIllness, restoreIllness } from "@/lib/export/illness-backup";
import { restoreIntradayProfileData } from "@/lib/export/intraday-profile-backup";
import {
  clearBiomarkers,
  clearLabResults,
  restoreLabMarkers,
  restoreLabResults,
} from "@/lib/export/labs-backup";
import { restoreLifeEventsData } from "@/lib/export/life-events-backup";
import {
  clearMeasurementRollups,
  clearMeasurements,
  restoreMeasurements,
} from "@/lib/export/measurements-restore";
import {
  clearIntakeEvents,
  clearMedications,
  restoreEfficacyTargets,
  restoreMedications,
} from "@/lib/export/medications-restore";
import {
  clearMoodEntries,
  clearMoodRollups,
  restoreMood,
} from "@/lib/export/mood-restore";
import { clearNotificationChannels } from "@/lib/export/notification-channels-backup";
import {
  clearNutrientDays,
  restoreNutrientDays,
} from "@/lib/export/nutrients-backup";
import { restoreOnboardingData } from "@/lib/export/onboarding-backup";
import { restoreProfileData } from "@/lib/export/profile-backup";
import { restoreRelationLinksData } from "@/lib/export/relation-links-backup";
import { restoreRemindersData } from "@/lib/export/reminders-backup";
import type { RestoreContext } from "@/lib/export/restore-context";
import { restoreSensitiveData } from "@/lib/export/sensitive-backup";
import { restoreSymptomsData } from "@/lib/export/symptoms-backup";
import { restoreVaccinationsData } from "@/lib/export/vaccinations-backup";
import { restoreVisitsData } from "@/lib/export/visits-backup";
import { clearWorkouts, restoreWorkouts } from "@/lib/export/workouts-backup";

/** One step of the restore transaction. */
export interface RestoreStep {
  /** A name for the reader of this list; never shown or stored. */
  readonly name: string;
  run(ctx: RestoreContext): Promise<void>;
}

/**
 * Empty every serialized owner-scoped partition before it is rebuilt in the
 * same transaction. Child rows either go first for counts or cascade from
 * their serialized parent. The sections not named here clear their own
 * tables as their restore step begins.
 */
export const RESTORE_CLEAR_STEPS: readonly RestoreStep[] = [
  { name: "intake events", run: clearIntakeEvents },
  { name: "medications", run: clearMedications },
  { name: "measurements", run: clearMeasurements },
  { name: "mood entries", run: clearMoodEntries },
  { name: "mood rollups", run: clearMoodRollups },
  { name: "measurement rollups", run: clearMeasurementRollups },
  { name: "notification channels", run: clearNotificationChannels },
  { name: "documents", run: clearDocuments },
  { name: "workouts", run: clearWorkouts },
  { name: "family history", run: clearFamilyHistory },
  { name: "allergies", run: clearAllergies },
  { name: "illness", run: clearIllness },
  { name: "lab results", run: clearLabResults },
  { name: "biomarkers", run: clearBiomarkers },
  { name: "nutrient days", run: clearNutrientDays },
];

/** The ids of the documents the file carries, every one of which is written. */
function documentIdsOf(ctx: RestoreContext): Set<string> {
  return new Set(ctx.payload.documents.map((document) => document.id));
}

/** The rebuild, in dependency order. */
export const RESTORE_STEPS: readonly RestoreStep[] = [
  // The instance settings, only when the operator asked for them back.
  { name: "instance settings", run: restoreAppSettings },
  { name: "measurements", run: restoreMeasurements },
  { name: "medications", run: restoreMedications },
  { name: "mood", run: restoreMood },
  {
    // Profile, observed spans, day logs and symptom links; delete-then-
    // recreate, `notesEncrypted` restored as ciphertext verbatim.
    name: "cycles",
    run: async (ctx) => {
      ctx.reportSection("cycles");
      Object.assign(
        ctx.cleared,
        await restoreCycleData(ctx.tx, ctx.ownerId, ctx.payload, ctx.skips),
      );
    },
  },
  {
    // Durable self-context and user-defined metrics.
    name: "profile",
    run: async (ctx) => {
      ctx.reportSection("profile");
      Object.assign(
        ctx.cleared,
        await restoreProfileData(ctx.tx, ctx.ownerId, ctx.payload),
      );
    },
  },
  {
    // The hourly shape of a cumulative day.
    name: "intraday profiles",
    run: async (ctx) => {
      Object.assign(
        ctx.cleared,
        await restoreIntradayProfileData(ctx.tx, ctx.ownerId, ctx.payload),
      );
    },
  },
  {
    // The score as it was shown on each local day.
    name: "health score",
    run: async (ctx) => {
      Object.assign(
        ctx.cleared,
        await restoreHealthScoreData(ctx.tx, ctx.ownerId, ctx.payload),
      );
    },
  },
  {
    // The needs-based setup answers.
    name: "onboarding",
    run: async (ctx) => {
      Object.assign(
        ctx.cleared,
        await restoreOnboardingData(ctx.tx, ctx.ownerId, ctx.payload),
      );
    },
  },
  {
    // The account's own settings, onto the account row, column by column.
    // Only a setting can be written; identity, credentials and this host's
    // bookkeeping stay as the receiving account has them. A value this host
    // will not take is left out and named in the skip report.
    name: "account settings",
    run: async (ctx) => {
      const result = await restoreAccountSettings(
        ctx.tx,
        ctx.ownerId,
        ctx.payload,
        { retargeted: ctx.retargeted },
      );
      for (const column of result.refused) {
        ctx.skips.push({ catalogue: "accountSetting", key: column, links: 1 });
      }
      ctx.outputs.accountSettings = result;
    },
  },
  { name: "lab markers", run: restoreLabMarkers },
  // After the markers: a drug's target names one by a real foreign key.
  { name: "efficacy targets", run: restoreEfficacyTargets },
  { name: "lab results", run: restoreLabResults },
  { name: "illness", run: restoreIllness },
  {
    // The person's own symptoms and their occurrences. After the episodes,
    // because an occurrence may point at one.
    name: "symptoms",
    run: async (ctx) => {
      Object.assign(
        ctx.cleared,
        await restoreSymptomsData(
          ctx.tx,
          ctx.ownerId,
          ctx.payload,
          ctx.links.episodeIds,
          ctx.skips,
        ),
      );
    },
  },
  {
    // The person's life events. They reference nothing but the account.
    name: "life events",
    run: async (ctx) => {
      Object.assign(
        ctx.cleared,
        await restoreLifeEventsData(ctx.tx, ctx.ownerId, ctx.payload),
      );
    },
  },
  { name: "allergies", run: restoreAllergies },
  { name: "family history", run: restoreFamilyHistory },
  { name: "workouts", run: restoreWorkouts },
  { name: "nutrient days", run: restoreNutrientDays },
  { name: "documents", run: restoreDocuments },
  {
    // What the vault was filed against, and what was read out of it. After
    // the documents and the condition episodes because both are foreign keys
    // here — a filing written before either exists does not drop quietly, it
    // violates a constraint and costs the operator the whole restore. After
    // the lab results and the medications for a second reason: an approved
    // fact's `committedRecordId` is resolved against the rows those steps
    // wrote, and resolving before they exist would null every commitment and
    // still report success.
    name: "document filing",
    run: async (ctx) => {
      ctx.reportSection("documents");
      Object.assign(
        ctx.cleared,
        await restoreDocumentFilingData(
          ctx.tx,
          ctx.ownerId,
          ctx.payload,
          {
            documentIds: documentIdsOf(ctx),
            episodeIds: ctx.links.episodeIds,
            committedRecordIds: new Set([
              ...ctx.links.restoredLabResultIds,
              ...ctx.links.episodeIds,
              ...ctx.links.restoredMedicationIds,
            ]),
          },
          ctx.skips,
        ),
      );
    },
  },
  {
    // The Vorsorge reminders and their completion ledger, BEFORE the visits
    // and the vaccinations: both of those remap a `reminderId` against the
    // reminders in the database, so the reminders have to be there first or
    // every appointment and booster reference would read as unresolvable.
    name: "reminders",
    run: async (ctx) => {
      ctx.reportSection("reminders");
      Object.assign(
        ctx.cleared,
        await restoreRemindersData(ctx.tx, ctx.ownerId, ctx.payload, ctx.skips),
      );
    },
  },
  {
    // Visits, the address book and the three link tables. After the
    // documents and the reminders: a link is written only when both of its
    // ends exist.
    name: "visits",
    run: async (ctx) => {
      ctx.reportSection("visits");
      Object.assign(
        ctx.cleared,
        await restoreVisitsData(ctx.tx, ctx.ownerId, ctx.payload, ctx.skips),
      );
    },
  },
  {
    // The immunization log, after the visits: a dose remaps its
    // practitioner, its encounter and its booster reminder against rows the
    // steps above have just written.
    name: "vaccinations",
    run: async (ctx) => {
      ctx.reportSection("vaccinations");
      Object.assign(
        ctx.cleared,
        await restoreVaccinationsData(
          ctx.tx,
          ctx.ownerId,
          ctx.payload,
          ctx.skips,
        ),
      );
    },
  },
  {
    // The five relation links, last of the record sections they join: every
    // end is a foreign key against a lab result, document, visit, dose,
    // medication or condition, all written above.
    name: "relation links",
    run: async (ctx) => {
      Object.assign(
        ctx.cleared,
        await restoreRelationLinksData(
          ctx.tx,
          ctx.ownerId,
          ctx.payload,
          ctx.skips,
          {
            medications: ctx.links.medicationIdBySourceId,
            labResults: ctx.links.labResultIdBySourceId,
          },
        ),
      );
    },
  },
  {
    // The Coach's threads, turns and document links. AFTER the documents: an
    // attachment carries a `documentId` that is a foreign key against them.
    name: "coach",
    run: async (ctx) => {
      ctx.reportSection("coach");
      Object.assign(
        ctx.cleared,
        await restoreCoachData(
          ctx.tx,
          ctx.ownerId,
          ctx.payload,
          documentIdsOf(ctx),
          ctx.skips,
        ),
      );
    },
  },
  {
    // What the Coach keeps between threads. AFTER the transcript, because
    // all three carry a `sourceConversationId` resolved against the threads
    // just written.
    name: "coach memory",
    run: async (ctx) => {
      Object.assign(
        ctx.cleared,
        await restoreCoachMemoryData(
          ctx.tx,
          ctx.ownerId,
          ctx.payload,
          new Set(ctx.payload.coachConversations.map((c) => c.id)),
          new Set(
            ctx.payload.coachConversations.flatMap((c) =>
              c.messages.map((m) => m.id),
            ),
          ),
          ctx.skips,
        ),
      );
    },
  },
  {
    // The screener history and the consent record. Neither references
    // anything but the account.
    name: "sensitive",
    run: async (ctx) => {
      ctx.reportSection("sensitive");
      Object.assign(
        ctx.cleared,
        await restoreSensitiveData(ctx.tx, ctx.ownerId, ctx.payload),
      );
    },
  },
  {
    // The bests and the badges. AFTER the measurements:
    // `PersonalRecord.sourceMeasurementId` is a real foreign key against
    // `measurements` (migration 0054), so a pointer resolved before the
    // measurements exist would make Postgres refuse the insert and roll the
    // whole restore back over one provenance column.
    name: "awards",
    run: async (ctx) => {
      ctx.reportSection("awards");
      Object.assign(
        ctx.cleared,
        await restoreAwardsData(
          ctx.tx,
          ctx.ownerId,
          ctx.payload,
          ctx.links.writtenReferencedMeasurementIds,
          ctx.skips,
        ),
      );
    },
  },
  {
    // The ECG strips. AFTER the measurements: a recording's `measurementId`
    // is a real foreign key against the EVENT row it was filed with.
    name: "ecg",
    run: async (ctx) => {
      ctx.reportSection("ecg");
      Object.assign(
        ctx.cleared,
        await restoreEcgData(
          ctx.tx,
          ctx.ownerId,
          ctx.payload,
          ctx.links.writtenReferencedMeasurementIds,
          ctx.skips,
          (fn) => ctx.streamed.forEachEcgTrace(fn),
        ),
      );
    },
  },
  {
    // The per-day readings and the location periods that explain them, one
    // function for both: readings restored without their periods get
    // re-resolved to the home location and overwritten by the next
    // environment refresh.
    name: "environment",
    run: async (ctx) => {
      ctx.reportSection("environment");
      Object.assign(
        ctx.cleared,
        await restoreEnvironmentData(
          ctx.tx,
          ctx.ownerId,
          ctx.payload,
          ctx.skips,
        ),
      );
    },
  },
];
