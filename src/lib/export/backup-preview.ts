/**
 * What the restore preview shows for a stored backup, worked out while the
 * copy is written and kept on its row (`DataBackup.preview`).
 *
 * Why. The preview used to read the whole stored copy inside the request that
 * asked for it: open every piece, parse every measurement, validate the rest.
 * For an account of 1.8 million readings on slow hardware that took two
 * minutes, the dialog gave up long before, and the operator was told the
 * contents could not be read (#1031). The copy passes through this process
 * once anyway, on its way into the pieces, so the counts are taken there:
 * the weekly copy's from its writer's own counts and the sections it is
 * about to write, an upload's from the file the upload route has already
 * validated. Neither parses the copy a second time; the v1.39.6 scanner that
 * did kept every section but the bulk tables parsed beside the writer's own,
 * a second copy of the record inside the weekly job.
 *
 * What is kept. The `summarizeBackup` counts of the copy, its schema version,
 * and the inner key ids with the sections they sit in and the shortest
 * value of each section. The verdicts are not kept: whether this release can restore the
 * schema version, and whether this server holds the keys the copy needs, can
 * both change after the copy was written, so the route takes them again from
 * these inputs on every read.
 *
 * Which copy. A preview names the copy it describes (`copy`), and a reader
 * ignores one that names another: a copy replaced by a writer that does not
 * know about previews (an older release, after a downgrade) must not be
 * described by the numbers of the one it replaced.
 */
import { createHash } from "node:crypto";
import { z } from "zod/v4";

import {
  BackupKeyIdCollector,
  type StoredKeyUse,
} from "@/lib/export/backup-key-ids";
import type { FullBackupCounts } from "@/lib/export/full-backup-payload";
import type { StoredBackupRef } from "@/lib/export/stored-backup";
import {
  BACKUP_SCHEMA_VERSION,
  type BackupSummary,
} from "@/lib/validations/backup-summary";

export interface BackupPreview {
  version: 1;
  /** The copy this describes (`storedCopyIdentity`). */
  copy: string;
  summary: BackupSummary;
  keys: StoredKeyUse[];
}

const storedPreviewSchema = z.object({
  version: z.literal(1),
  copy: z.string().min(1),
  summary: z
    .object({
      schemaVersion: z.string(),
      userId: z.string(),
      exportedAt: z.string(),
      measurements: z.number(),
    })
    .catchall(z.union([z.string(), z.number()])),
  keys: z.array(
    z.object({
      keyId: z.string(),
      count: z.number().int().nonnegative(),
      sections: z.array(z.string()),
      samples: z
        .array(
          z.object({
            value: z.string(),
            form: z.enum(["string", "bytes-string", "binary"]),
            section: z.string().optional(),
            member: z.string().optional(),
          }),
        )
        .optional(),
      // A preview stored by v1.40.0 or earlier kept one sample per key.
      sample: z
        .object({
          value: z.string(),
          form: z.enum(["string", "bytes-string", "binary"]),
        })
        .nullable()
        .optional(),
    }),
  ),
});

/**
 * How a single stored value is told apart from another: its length and its
 * first characters, which carry the key id and the random nonce of the
 * envelope. Hashed, so the preview does not repeat the envelope's head.
 */
export function singleValueIdentity(length: number, head: string): string {
  return `value:${createHash("sha256").update(`${length}:${head}`).digest("hex")}`;
}

/** How many leading characters of a single stored value the identity reads. */
export const SINGLE_VALUE_IDENTITY_HEAD = 128;

/**
 * The name of the copy a row holds now, or null for a row nothing may
 * describe: one holding both forms, or neither.
 */
export function storedCopyIdentity(
  backup: Pick<StoredBackupRef, "data" | "chunkCount" | "chunkStreamId">,
): string | null {
  if (backup.data != null && backup.chunkStreamId != null) return null;
  if (backup.chunkStreamId != null) {
    return `chunks:${backup.chunkStreamId}:${backup.chunkCount ?? ""}`;
  }
  if (backup.data != null) {
    return singleValueIdentity(
      backup.data.length,
      backup.data.slice(0, SINGLE_VALUE_IDENTITY_HEAD),
    );
  }
  return null;
}

export function buildBackupPreview(
  copy: string,
  summary: BackupSummary,
  keys: BackupKeyIdCollector,
): BackupPreview {
  return { version: 1, copy, summary, keys: keys.toStored() };
}

/**
 * The stored preview of a row, when it describes the copy the row holds now;
 * null when there is none, it is malformed, or it describes another copy.
 */
export function storedPreviewFor(
  stored: unknown,
  backup: Pick<StoredBackupRef, "data" | "chunkCount" | "chunkStreamId">,
): BackupPreview | null {
  const copy = storedCopyIdentity(backup);
  if (copy === null || stored == null) return null;
  const parsed = storedPreviewSchema.safeParse(stored);
  if (!parsed.success || parsed.data.copy !== copy) return null;
  return parsed.data as unknown as BackupPreview;
}

/**
 * The summary fields that are counts, each also counted by the writer
 * (`FullBackupCounts`). The type below fails to compile when the summary
 * gains a count the writer does not report.
 */
const SUMMARY_COUNTS = [
  "measurements",
  "medications",
  "intakeEvents",
  "medicationSideEffects",
  "medicationEfficacyTargets",
  "medicationScheduleRevisions",
  "moodEntries",
  "cycles",
  "cycleDayLogs",
  "labResults",
  "nutrientDays",
  "biomarkers",
  "illnessEpisodes",
  "illnessDayLogs",
  "allergies",
  "familyHistory",
  "workouts",
  "documents",
  "documentConditionLinks",
  "extractedFacts",
  "healthProfile",
  "healthProfileFactRevisions",
  "customMetrics",
  "customMetricEntries",
  "correlationPatterns",
  "intradayProfiles",
  "healthScoreRecords",
  "onboardingRecords",
  "practitioners",
  "encounters",
  "encounterLinks",
  "vaccinations",
  "vaccinationLinks",
  "measurementReminders",
  "measurementReminderEvents",
  "coachConversations",
  "coachMessages",
  "coachFacts",
  "coachPlans",
  "coachReminders",
  "mentalHealthAssessments",
  "consentReceipts",
  "personalRecords",
  "userAchievements",
  "environmentContexts",
  "environmentTravelLocations",
  "ecgRecordings",
] as const satisfies readonly (keyof BackupSummary & keyof FullBackupCounts)[];

type UncountedSummaryField = Exclude<
  keyof BackupSummary,
  (typeof SUMMARY_COUNTS)[number] | "schemaVersion" | "userId" | "exportedAt"
>;
const everySummaryCountIsCounted: [UncountedSummaryField] extends [never]
  ? true
  : UncountedSummaryField = true;
void everySummaryCountIsCounted;

export interface BackupPreviewCollector {
  /** Pass as `observe` to `streamFullBackupJson`. */
  observe(member: string, value: unknown): void;
  /**
   * The counts and key uses, once the writer has finished; null when the
   * copy did not name its schema version, owner and date, or when a section
   * did not pass the backup schema. A null preview sends the preview route
   * to read the copy itself, which then says why it cannot be restored.
   */
  finish(counts: FullBackupCounts): {
    summary: BackupSummary;
    keys: BackupKeyIdCollector;
  } | null;
}

type SchemaModule = typeof import("@/lib/validations/backup");

/**
 * A check of one member of the payload against `backupPayloadSchema`, as the
 * writer shows it: a whole section, or one row of a bulk table. An array
 * section is checked an element at a time, so the check holds one element's
 * copy at most, never a section's. Each value is checked in its JSON form,
 * exactly as it lands in the copy. A member the schema does not name passes,
 * as it does under the schema's passthrough.
 */
function sectionChecker(
  mod: SchemaModule,
): (member: string, value: unknown) => boolean {
  const shape = mod.backupPayloadSchema.shape as Record<string, z.ZodType>;
  const asWritten = (value: unknown): unknown =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const unwrap = (schema: z.ZodType): z.ZodType =>
    schema instanceof z.ZodDefault
      ? unwrap(schema.unwrap() as z.ZodType)
      : schema;
  return (member, value) => {
    const declared = shape[member];
    if (!declared) return true;
    const section = unwrap(declared);
    if (section instanceof z.ZodArray) {
      const element = section.element as z.ZodType;
      const rows = Array.isArray(value) ? value : [value];
      return rows.every((row) => element.safeParse(asWritten(row)).success);
    }
    return declared.safeParse(asWritten(value)).success;
  };
}

/**
 * Work out a weekly copy's preview from what its writer already has in hand:
 * each section as it is written, for the key uses and the schema check, and
 * the writer's own counts. Nothing is parsed back and nothing is kept but the
 * key samples, so the preview costs the pass no memory that grows with the
 * record. The check loads the backup schema (`backup-summary.ts` says why it
 * is loaded on first use), a fixed cost of the module, not of the record.
 */
export async function createBackupPreviewCollector(): Promise<BackupPreviewCollector> {
  const check = sectionChecker(await import("@/lib/validations/backup"));
  const keys = new BackupKeyIdCollector();
  const header: Partial<
    Record<"schemaVersion" | "userId" | "exportedAt", string>
  > = {};
  let valid = true;
  let measurementWithoutId = false;
  return {
    observe(member, value) {
      if (valid && !check(member, value)) valid = false;
      if (member === "measurements") {
        const rows: unknown[] = Array.isArray(value) ? value : [value];
        if (rows.some((row) => !(row as { id?: unknown } | null)?.id)) {
          measurementWithoutId = true;
        }
      }
      if (
        (member === "schemaVersion" ||
          member === "userId" ||
          member === "exportedAt") &&
        typeof value === "string"
      ) {
        header[member] = value;
        return;
      }
      keys.visit(value, member);
    },
    finish(counts) {
      const { schemaVersion, userId, exportedAt } = header;
      if (!schemaVersion || !userId || !exportedAt) return null;
      if (!valid) return null;
      // The schema's one whole-document rule: a canonical copy names every
      // measurement by a stable id.
      if (schemaVersion === BACKUP_SCHEMA_VERSION && measurementWithoutId) {
        return null;
      }
      const summary = { schemaVersion, userId, exportedAt } as BackupSummary;
      for (const field of SUMMARY_COUNTS) summary[field] = counts[field];
      return { summary, keys };
    },
  };
}
