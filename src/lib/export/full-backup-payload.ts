/**
 * The shared builder for the user-scoped full-backup payload.
 *
 * Extracted so both the plaintext `GET /api/export/full-backup` route and the
 * passphrase-encrypted `POST /api/export/encrypted` route emit the byte-for-byte
 * same shape — the one that the pg-boss `data-backup` worker writes and that
 * `parseBackupPayload()` round-trips on admin restore. Keep this writer in sync
 * with the `data-backup` worker (`src/lib/jobs/reminder-worker.ts`).
 *
 * The decrypted notes are surfaced here (the backup is the human-readable
 * artefact); an admin restore re-encrypts them on re-insert.
 *
 * Two writers read this file, not one. `buildFullBackupPayload` materialises
 * the whole payload, which is what the two export routes and every test want.
 * `streamFullBackupJson` (`full-backup-stream.ts`) asks for the same payload
 * with `deferBulk`, which leaves the unbounded tables (and the two whose rows
 * carry stored bytes) as markers and pulls their rows through itself — the
 * weekly job takes that path because materialising a large record is what
 * used to exhaust the container's heap. Both go through the same per-row
 * serialisers, each in its domain's module, so a column that reaches one
 * reaches the other; the integration suite pins the two outputs byte for
 * byte rather than trusting that sentence.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { AwardsBackupCounts } from "@/lib/export/awards-backup";
import {
  BACKUP_EXPORT_COUNT_ORDER,
  BACKUP_EXPORT_SECTIONS,
} from "@/lib/export/backup-export-sections";
import type {
  CoachBackupCounts,
  CoachMemoryBackupCounts,
} from "@/lib/export/coach-backup";
import type { DocumentFilingBackupCounts } from "@/lib/export/document-filing-backup";
import type { EcgBackupCounts } from "@/lib/export/ecg-backup";
import type { EnvironmentBackupCounts } from "@/lib/export/environment-backup";
import type { BackupExportContext } from "@/lib/export/export-context";
import type { HealthScoreBackupCounts } from "@/lib/export/health-score-backup";
import type { IntradayProfileBackupCounts } from "@/lib/export/intraday-profile-backup";
import type { LifeEventsBackupCounts } from "@/lib/export/life-events-backup";
import type { OnboardingBackupCounts } from "@/lib/export/onboarding-backup";
import type { ProfileBackupCounts } from "@/lib/export/profile-backup";
import type { RecordsBackupCounts } from "@/lib/export/records-backup";
import type { RelationLinksBackupCounts } from "@/lib/export/relation-links-backup";
import type { RemindersBackupCounts } from "@/lib/export/reminders-backup";
import type { SensitiveBackupCounts } from "@/lib/export/sensitive-backup";
import type { SymptomsBackupCounts } from "@/lib/export/symptoms-backup";
import type { SeizuresBackupCounts } from "@/lib/export/seizures-backup";
import type { ImagingBackupCounts } from "@/lib/export/imaging-backup";
import type { VaccinationsBackupCounts } from "@/lib/export/vaccinations-backup";
import type { VisitsBackupCounts } from "@/lib/export/visits-backup";
import { BACKUP_SCHEMA_VERSION } from "@/lib/validations/backup-summary";
import { ownRecord } from "@/lib/own-key";

export { isDeferredRows } from "@/lib/export/deferred-rows";

export interface FullBackupCounts
  extends
    RecordsBackupCounts,
    ProfileBackupCounts,
    IntradayProfileBackupCounts,
    HealthScoreBackupCounts,
    VisitsBackupCounts,
    VaccinationsBackupCounts,
    RemindersBackupCounts,
    CoachBackupCounts,
    CoachMemoryBackupCounts,
    SensitiveBackupCounts,
    DocumentFilingBackupCounts,
    RelationLinksBackupCounts,
    AwardsBackupCounts,
    EnvironmentBackupCounts,
    OnboardingBackupCounts,
    EcgBackupCounts,
    SymptomsBackupCounts,
    SeizuresBackupCounts,
    ImagingBackupCounts,
    LifeEventsBackupCounts {
  measurements: number;
  medications: number;
  intakeEvents: number;
  medicationSideEffects: number;
  medicationPauseEras: number;
  medicationDoseChanges: number;
  medicationInventoryItems: number;
  medicationInventoryEvents: number;
  reminderPhaseConfigs: number;
  medicationEfficacyTargets: number;
  medicationScheduleRevisions: number;
  moodEntries: number;
  customMoodTagCategories: number;
  hiddenMoodTags: number;
  cycles: number;
  cycleDayLogs: number;
  nutrientDays: number;
}

export interface FullBackupResult {
  /** Keyed by section name, with no prototype (see `own-key.ts`). */
  payload: Record<string, unknown>;
  counts: FullBackupCounts;
}

export interface FullBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
  exportedAt?: Date;
  /**
   * Declare the large tables instead of reading them.
   *
   * `measurements`, `intakeEvents` and `moodEntries` (unbounded in rows) and
   * `documents` and `ecgRecordings` (large in bytes) come back as
   * `DeferredRows` markers and their counts as 0. Only `streamFullBackupJson`
   * sets this; every other caller wants the arrays and gets them.
   */
  deferBulk?: boolean;
}

/**
 * Build the canonical full-backup payload for `userId`. Portable exports omit
 * tombstones and document ciphertext; disaster-recovery payloads preserve
 * both so weekly and off-host snapshots share one restorable wire format.
 *
 * Every domain reads its own slice (`backup-export-sections.ts`), all of them
 * at once; the slices are then laid out in the file's key order. A key two
 * slices write is merged where it first appears (`manifest`).
 */
export async function buildFullBackupPayload(
  prisma: PrismaClient,
  userId: string,
  options: FullBackupOptions = {},
): Promise<FullBackupResult> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const ctx: BackupExportContext = {
    prisma,
    userId,
    disasterRecovery,
    purpose: disasterRecovery ? "disaster-recovery" : "portable-export",
    deferBulk: options.deferBulk === true,
  };
  const parts = await Promise.all(
    BACKUP_EXPORT_SECTIONS.map((section) => section.build(ctx)),
  );

  const payload = ownRecord<unknown>();
  payload.schemaVersion = BACKUP_SCHEMA_VERSION;
  payload.exportedAt = (options.exportedAt ?? new Date()).toISOString();
  payload.userId = userId;
  for (const part of parts) {
    for (const [key, value] of Object.entries(part.section)) {
      payload[key] =
        key === "manifest" && key in payload
          ? { ...(payload.manifest as object), ...(value as object) }
          : value;
    }
  }

  const partByName = new Map(
    BACKUP_EXPORT_SECTIONS.map((section, index) => [
      section.name,
      parts[index],
    ]),
  );
  const counts = Object.assign(
    {},
    ...BACKUP_EXPORT_COUNT_ORDER.map((name) => partByName.get(name)!.counts),
  ) as FullBackupCounts;
  return { payload, counts };
}
