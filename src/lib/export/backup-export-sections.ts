/**
 * The slices of a backup file, in the order their keys appear in it.
 *
 * Each domain builds its own slice in its own module; this file lays them
 * out. The order is every backup file's key order so far, and the restore's
 * dependency order lives beside it in `backup-domains.ts`.
 */
import { buildCycleBackupSection } from "@/lib/cycle/backup";
import { buildAccountSettingsBackupSection } from "@/lib/export/account-settings-backup";
import { buildAppSettingsBackupPart } from "@/lib/export/app-settings-backup";
import {
  buildAwardsBackupSection,
  countAwardsBackupSection,
} from "@/lib/export/awards-backup";
import {
  buildCoachBackupSection,
  buildCoachMemoryBackupSection,
  countCoachBackupSection,
  countCoachMemoryBackupSection,
} from "@/lib/export/coach-backup";
import { deferredRows } from "@/lib/export/deferred-rows";
import {
  buildDocumentFilingBackupSection,
  countDocumentFilingBackupSection,
} from "@/lib/export/document-filing-backup";
import { iterateBackupDocuments } from "@/lib/export/documents-backup";
import {
  buildEcgBackupSection,
  countEcgBackupSection,
  iterateBackupEcgRecordings,
} from "@/lib/export/ecg-backup";
import {
  buildEnvironmentBackupSection,
  countEnvironmentBackupSection,
} from "@/lib/export/environment-backup";
import type {
  BackupExportContext,
  BackupExportPart,
} from "@/lib/export/export-context";
import {
  buildHealthScoreBackupSection,
  countHealthScoreBackupSection,
} from "@/lib/export/health-score-backup";
import {
  buildIntradayProfileBackupSection,
  countIntradayProfileBackupSection,
} from "@/lib/export/intraday-profile-backup";
import {
  buildLifeEventsBackupSection,
  countLifeEventsBackupSection,
} from "@/lib/export/life-events-backup";
import { buildMeasurementsBackupPart } from "@/lib/export/measurements-backup";
import { buildMedicationsBackupPart } from "@/lib/export/medications-backup";
import { buildMoodBackupPart } from "@/lib/export/mood-backup";
import { buildNutrientsBackupPart } from "@/lib/export/nutrients-backup";
import {
  buildOnboardingBackupSection,
  countOnboardingBackupSection,
} from "@/lib/export/onboarding-backup";
import {
  buildProfileBackupSection,
  countProfileBackupSection,
} from "@/lib/export/profile-backup";
import {
  buildRecordsBackupSection,
  countRecordsBackupSection,
} from "@/lib/export/records-backup";
import {
  buildRelationLinksBackupSection,
  countRelationLinksBackupSection,
} from "@/lib/export/relation-links-backup";
import {
  buildRemindersBackupSection,
  countRemindersBackupSection,
} from "@/lib/export/reminders-backup";
import {
  buildSensitiveBackupSection,
  countSensitiveBackupSection,
} from "@/lib/export/sensitive-backup";
import {
  buildSymptomsBackupSection,
  countSymptomsBackupSection,
} from "@/lib/export/symptoms-backup";
import {
  buildSeizuresBackupSection,
  countSeizuresBackupSection,
} from "@/lib/export/seizures-backup";
import {
  buildImagingBackupSection,
  countImagingBackupSection,
} from "@/lib/export/imaging-backup";
import {
  buildVaccinationsBackupSection,
  countVaccinationsBackupSection,
} from "@/lib/export/vaccinations-backup";
import {
  buildVisitsBackupSection,
  countVisitsBackupSection,
} from "@/lib/export/visits-backup";

/** One domain's slice of the file. */
export interface BackupExportSection {
  /** The slice's name in `BACKUP_EXPORT_COUNT_ORDER`. */
  readonly name: string;
  build(ctx: BackupExportContext): Promise<BackupExportPart>;
}

/** A section module's slice and counts, as a part. */
function part(section: object, counts: object = {}): BackupExportPart {
  return {
    section: { ...section } as Record<string, unknown>,
    counts: { ...counts } as Record<string, number>,
  };
}

/**
 * The slices of the file, in the order their keys appear in it. Every section
 * is SPREAD, not hand-picked key by key: hand-picking is what lost the custom
 * cycle symptoms, whose builder returned them while the list of keys copied
 * out of it was never extended, so every backup carried `customSymptoms: []`.
 * Spreading makes each section's own interface the declaration of what rides
 * the wire.
 *
 * A key two slices both write is merged where it first appears: `manifest`,
 * which the records slice opens and the sensitive slice adds its disclosures
 * to.
 */
export const BACKUP_EXPORT_SECTIONS: readonly BackupExportSection[] = [
  // The host's own settings, in a disaster-recovery payload only.
  { name: "appSettings", build: buildAppSettingsBackupPart },
  {
    // The account's own settings: units, language, modules, thresholds, the
    // AI choices without the keys.
    name: "accountSettings",
    build: async (ctx) =>
      part(
        await buildAccountSettingsBackupSection(ctx.prisma, ctx.userId, {
          purpose: ctx.purpose,
        }),
      ),
  },
  { name: "measurements", build: buildMeasurementsBackupPart },
  { name: "medications", build: buildMedicationsBackupPart },
  { name: "mood", build: buildMoodBackupPart },
  {
    name: "cycle",
    build: async (ctx) => {
      const cycle = await buildCycleBackupSection(ctx.prisma, ctx.userId, {
        purpose: ctx.purpose,
      });
      return part(cycle, {
        cycles: cycle.cycles.length,
        cycleDayLogs: cycle.cycleDayLogs.length,
      });
    },
  },
  {
    // Labs, illness, allergies, family history, workouts and documents, with
    // the manifest that discloses what the file leaves out. Deferred, the
    // documents keep their position (a key that already exists keeps its
    // place when it is assigned again) and are read a document at a time by
    // the streaming writer (#1239).
    name: "records",
    build: async (ctx) => {
      const records = await buildRecordsBackupSection(ctx.prisma, ctx.userId, {
        purpose: ctx.purpose,
        deferDocuments: ctx.deferBulk,
      });
      return part(
        {
          ...records,
          ...(ctx.deferBulk
            ? {
                documents: deferredRows(() =>
                  iterateBackupDocuments(ctx.prisma, ctx.userId, {
                    purpose: ctx.purpose,
                  }),
                ),
              }
            : {}),
        },
        countRecordsBackupSection(records),
      );
    },
  },
  {
    // Durable self-context, user-defined metrics, and persisted pattern
    // decisions.
    name: "profile",
    build: async (ctx) => {
      const profile = await buildProfileBackupSection(ctx.prisma, ctx.userId, {
        purpose: ctx.purpose,
      });
      return part(profile, countProfileBackupSection(profile));
    },
  },
  {
    // The hourly shape of a cumulative day.
    name: "intradayProfiles",
    build: async (ctx) => {
      const intraday = await buildIntradayProfileBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(intraday, countIntradayProfileBackupSection(intraday));
    },
  },
  {
    // The score as it was SHOWN on each local day.
    name: "healthScoreRecords",
    build: async (ctx) => {
      const score = await buildHealthScoreBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(score, countHealthScoreBackupSection(score));
    },
  },
  {
    // The needs-based setup answers.
    name: "onboardingRecord",
    build: async (ctx) => {
      const onboarding = await buildOnboardingBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(onboarding, countOnboardingBackupSection(onboarding));
    },
  },
  {
    // Visits, the address book behind them, and the three link tables.
    name: "visits",
    build: async (ctx) => {
      const visits = await buildVisitsBackupSection(ctx.prisma, ctx.userId, {
        purpose: ctx.purpose,
      });
      return part(visits, countVisitsBackupSection(visits));
    },
  },
  {
    // The immunization log and the pages it was transcribed from.
    name: "vaccinations",
    build: async (ctx) => {
      const vaccinations = await buildVaccinationsBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(vaccinations, countVaccinationsBackupSection(vaccinations));
    },
  },
  {
    // Imaging exams and their filed documents.
    name: "imaging",
    build: async (ctx) => {
      const imaging = await buildImagingBackupSection(ctx.prisma, ctx.userId, {
        purpose: ctx.purpose,
      });
      return part(imaging, countImagingBackupSection(imaging));
    },
  },
  {
    // The Vorsorge reminders and their completion ledger.
    name: "reminders",
    build: async (ctx) => {
      const reminders = await buildRemindersBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(reminders, countRemindersBackupSection(reminders));
    },
  },
  {
    // The Coach's conversations, turns and document links.
    name: "coach",
    build: async (ctx) => {
      const coach = await buildCoachBackupSection(ctx.prisma, ctx.userId, {
        purpose: ctx.purpose,
      });
      return part(coach, countCoachBackupSection(coach));
    },
  },
  {
    // What the Coach keeps BETWEEN threads.
    name: "coachMemory",
    build: async (ctx) => {
      const memory = await buildCoachMemoryBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(memory, countCoachMemoryBackupSection(memory));
    },
  },
  {
    // The screener history and the consent record, disaster-recovery only;
    // its manifest entries join the records slice's manifest.
    name: "sensitive",
    build: async (ctx) => {
      const sensitive = await buildSensitiveBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(
        {
          mentalHealthAssessments: sensitive.mentalHealthAssessments,
          consentReceipts: sensitive.consentReceipts,
          manifest: sensitive.manifest,
        },
        countSensitiveBackupSection(sensitive),
      );
    },
  },
  {
    // Which conditions a document was filed against, and what the
    // extraction pass read out of it.
    name: "documentFiling",
    build: async (ctx) => {
      const filing = await buildDocumentFilingBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(filing, countDocumentFilingBackupSection(filing));
    },
  },
  {
    // The bests and the badges. No `purpose`: neither model tombstones and
    // neither holds ciphertext, so both purposes carry the same bytes.
    name: "awards",
    build: async (ctx) => {
      const awards = await buildAwardsBackupSection(ctx.prisma, ctx.userId);
      return part(awards, countAwardsBackupSection(awards));
    },
  },
  {
    // The per-day readings and the location periods that explain them.
    name: "environment",
    build: async (ctx) => {
      const environment = await buildEnvironmentBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(environment, countEnvironmentBackupSection(environment));
    },
  },
  {
    // The ECG strips, their rhythm verdicts and their traces; deferred, read
    // a page of strips at a time by the streaming writer.
    name: "ecg",
    build: async (ctx) => {
      const ecg = await buildEcgBackupSection(ctx.prisma, ctx.userId, {
        purpose: ctx.purpose,
        defer: ctx.deferBulk,
      });
      return part(
        {
          ...ecg,
          ...(ctx.deferBulk
            ? {
                ecgRecordings: deferredRows(() =>
                  iterateBackupEcgRecordings(ctx.prisma, ctx.userId, {
                    purpose: ctx.purpose,
                  }),
                ),
              }
            : {}),
        },
        countEcgBackupSection(ecg),
      );
    },
  },
  {
    // The person's own symptoms with their occurrences nested inside.
    name: "symptoms",
    build: async (ctx) => {
      const symptoms = await buildSymptomsBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(symptoms, countSymptomsBackupSection(symptoms));
    },
  },
  {
    // The seizure diary: types, seizures with their rescue doses, the rule.
    name: "seizures",
    build: async (ctx) => {
      const seizures = await buildSeizuresBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(seizures, countSeizuresBackupSection(seizures));
    },
  },
  {
    // The person's life events.
    name: "lifeEvents",
    build: async (ctx) => {
      const lifeEvents = await buildLifeEventsBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(lifeEvents, countLifeEventsBackupSection(lifeEvents));
    },
  },
  {
    // The five relation links that close the relation matrix.
    name: "relationLinks",
    build: async (ctx) => {
      const links = await buildRelationLinksBackupSection(
        ctx.prisma,
        ctx.userId,
        { purpose: ctx.purpose },
      );
      return part(links, countRelationLinksBackupSection(links));
    },
  },
  { name: "nutrients", build: buildNutrientsBackupPart },
];

/**
 * The order the audit trail lists the slices' row counts in. It is not the
 * file's order: the counts were laid out before most sections existed, and
 * every backup job's audit row since reads this way.
 */
export const BACKUP_EXPORT_COUNT_ORDER: readonly string[] = [
  "measurements",
  "medications",
  "mood",
  "cycle",
  "nutrients",
  "records",
  "profile",
  "intradayProfiles",
  "healthScoreRecords",
  "onboardingRecord",
  "visits",
  "vaccinations",
  "reminders",
  "coach",
  "coachMemory",
  "sensitive",
  "documentFiling",
  "awards",
  "environment",
  "ecg",
  "symptoms",
  "lifeEvents",
  "relationLinks",
  "seizures",
  "imaging",
];
