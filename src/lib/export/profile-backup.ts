/**
 * Durable self-context, user-defined metrics, and persisted pattern decisions,
 * with both backup ends in one file.
 *
 * These account-owned models cannot be reconstructed from an integration:
 * `UserHealthProfile`, `CustomMetric` / `CustomMetricEntry`, and
 * `CorrelationPattern`. The last model carries stable finding identity and the
 * evidence baseline that makes a dismissal survive recomputation and restore.
 *
 * The builder and the restore live together deliberately, the way
 * `src/lib/cycle/backup.ts` does. A reader asking "is this carried at both
 * ends?" answers it in one file, and — the reason it matters — a reader who
 * greps only the restore ROUTE gets a false negative, because the route
 * delegates. That mistake has already been made once about the cycle data and
 * had to be retracted; keeping the pair adjacent is what makes the answer
 * cheap enough to get right.
 *
 * Encrypted columns follow the established split. A portable export is the
 * human-readable artefact, so the profile's free text is decrypted into it. A
 * disaster-recovery payload carries the AES-256-GCM envelope verbatim as
 * base64 and never decrypts, so the same instance's key reads it back
 * unchanged and no plaintext is duplicated into the file.
 */
import { Buffer } from "node:buffer";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { getEvent } from "@/lib/logging/context";
import {
  DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
  isHealthProfileFactValue,
  type HealthProfileAiSection,
  type HealthProfileFactKind,
} from "@/lib/validations/health-profile-facts";
import type {
  AdvanceDirectiveStatusValue,
  EmergencyBloodTypeValue,
  OrganDonorStatusValue,
} from "@/lib/validations/emergency-profile";

export interface ProfileBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/**
 * The account's durable self-context. One row per user, so there is no
 * reference to resolve on the way back in — the owner is the key.
 */
export interface HealthProfileBackupEntry {
  /** Present in canonical DR payloads so the row keeps a stable identity. */
  id?: string;
  /**
   * Portable exports carry the decrypted text; DR payloads carry `null` here
   * and the ciphertext below. Never both — a DR file must not duplicate the
   * plaintext of a column it is already carrying encrypted.
   */
  aboutMe: string | null;
  conditions: string | null;
  allergies: string | null;
  coachFocus: string | null;
  /** Base64 of the already-encrypted BYTEA value. DR payloads only. */
  aboutMeEncrypted?: string | null;
  conditionsEncrypted?: string | null;
  allergiesEncrypted?: string | null;
  coachFocusEncrypted?: string | null;
  aiIncludedSections: HealthProfileAiSection[];
  /**
   * Emergency ("Notfalldaten") profile. The three enums are plaintext closed
   * sets, carried by value in both purposes exactly like `aiIncludedSections`.
   * The three free-text columns follow the same split as the self-context above:
   * a portable export decrypts them into `emergency*`, a DR payload leaves those
   * null and carries the ciphertext in `emergency*Encrypted`.
   */
  emergencyBloodType: EmergencyBloodTypeValue | null;
  organDonorStatus: OrganDonorStatusValue | null;
  advanceDirectiveStatus: AdvanceDirectiveStatusValue | null;
  emergencyContacts: string | null;
  emergencyImplants: string | null;
  emergencyNote: string | null;
  emergencyContactsEncrypted?: string | null;
  emergencyImplantsEncrypted?: string | null;
  emergencyNoteEncrypted?: string | null;
  /**
   * Server-derived clarifying questions awaiting an answer, encrypted JSON.
   *
   * DR only, and deliberately: they are not the person's own words, they are
   * regenerated after the next profile save, and a portable export that is
   * meant to be readable gains nothing from an opaque envelope. Carried in the
   * canonical payload because a DR restore should land the account in the
   * state it was in, pending prompts included.
   */
  pendingQuestionsEncrypted?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface HealthProfileFactBackupEntry {
  id: string;
  kind: HealthProfileFactKind;
  /** Portable exports carry readable plaintext; DR payloads leave this null. */
  value: string | null;
  /** Base64 encrypted envelope, present only in disaster-recovery payloads. */
  valueEncrypted?: string;
  validFrom: string;
  validUntil: string | null;
  provenance: "USER_REPORTED" | "USER_CORRECTION";
  supersededByRevisionId: string | null;
  createdAt: string;
}

/** One reading of a user-defined metric. */
export interface CustomMetricEntryBackupEntry {
  /** Present in canonical DR payloads so the row keeps a stable identity. */
  id?: string;
  value: number;
  /** Unit snapshot taken from the metric at write time, not a live join. */
  unit: string;
  measuredAt: string;
  /**
   * The readable note: portable exports, and DR payloads for a row the
   * free-text backfill had not reached yet. Null otherwise.
   */
  note: string | null;
  /**
   * v1.39.3 — base64 ciphertext of the note, present only in disaster-recovery
   * payloads (null when the reading has no note).
   */
  noteEncrypted?: string | null;
  createdAt?: string;
  /** v1.37.20 (A3-11) — soft-delete tombstone; DR payloads only. */
  deletedAt?: string | null;
}

/**
 * A metric the account defined, with its readings nested inside it.
 *
 * Nested rather than a flat array keyed by metric name, and that is a
 * deliberate difference from the intake-event section next door. A flat array
 * needs the restore to resolve every row's parent by a natural key, which is
 * the exact shape that produces a lookup miss — and a lookup miss is a row
 * that either vanishes quietly or stops the restore. Nesting removes the
 * reference, so an entry cannot dangle and there is nothing to drop.
 */
export interface CustomMetricBackupEntry {
  /** Present in canonical DR payloads so the row keeps a stable identity. */
  id?: string;
  name: string;
  unit: string;
  targetLow: number | null;
  targetHigh: number | null;
  decimals: number | null;
  description: string | null;
  correlationEnabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  /** Tombstone, DR payloads only — a portable export never carries deleted rows. */
  deletedAt?: string | null;
  entries: CustomMetricEntryBackupEntry[];
}

/** Persisted accepted correlation evidence and its dismissal decision. */
export interface CorrelationPatternBackupEntry {
  id?: string;
  canonicalKey: string;
  family: string;
  factorKey: string;
  outcomeKey: string;
  lagDays: number;
  sampleSize: number;
  effectSize: number;
  pValue: number;
  qValue: number | null;
  evidenceHash: string;
  isCurrent: boolean;
  lastComputedAt: string;
  dismissedAt: string | null;
  dismissedEvidenceHash: string | null;
  dismissedEffectSize: number | null;
  dismissedSampleSize: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProfileBackupSection {
  healthProfile: HealthProfileBackupEntry | null;
  customMetrics: CustomMetricBackupEntry[];
  healthProfileFacts: HealthProfileFactBackupEntry[];
  correlationPatterns: CorrelationPatternBackupEntry[];
  /**
   * v1.37.19 (A6-9) — field paths whose ciphertext this instance could not
   * open while building a PORTABLE export (fail-soft nulls). Disclosed in
   * the file itself so an export with a nulled emergency field no longer
   * reads byte-identical to one where the field was never written — the
   * person restoring elsewhere can see exactly what was lost. Always empty
   * on the disaster-recovery path (DR carries ciphertext verbatim and
   * never decrypts).
   */
  decryptFailures: string[];
}

export interface ProfileBackupCounts {
  healthProfile: number;
  customMetrics: number;
  customMetricEntries: number;
  healthProfileFactRevisions: number;
  correlationPatterns: number;
}

/**
 * Decrypt one profile field fail-soft.
 *
 * Fail-soft here and NOT on the restore side, which is the asymmetry that
 * matters: a field this instance can no longer read is already lost, and
 * refusing to build the rest of the backup over it would turn one unreadable
 * column into no backup at all. The warning rides the wide event so the
 * operator sees it. On the way back in, by contrast, an unresolvable
 * reference throws — absence must read as absence, not as a quiet drop.
 */
function decryptProfileFieldSoft(
  buf: Uint8Array | null,
  field: string,
  /** v1.37.19 (A6-9) — collector for the file's decryptFailures manifest. */
  failures?: string[],
): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptFromBytes(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `health profile ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    failures?.push(`healthProfile.${field}`);
    return null;
  }
}

/**
 * v1.39.3 — a custom-metric reading's note for a portable export: ciphertext
 * first, the legacy readable column for a row the backfill has not reached.
 * An unreadable ciphertext is recorded in the manifest and exported as no
 * note, never replaced by the readable column.
 */
function readEntryNoteSoft(
  entry: { id: string; note: string | null; noteEncrypted: Uint8Array | null },
  failures: string[],
): string | null {
  if (entry.noteEncrypted && entry.noteEncrypted.byteLength > 0) {
    try {
      return decryptFromBytes(entry.noteEncrypted);
    } catch (err) {
      getEvent()?.addWarning(
        `custom metric entry note decrypt failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      failures.push(`customMetricEntry.${entry.id}.note`);
      return null;
    }
  }
  return entry.note;
}

function toBase64(buf: Uint8Array | null): string | null {
  return buf && buf.byteLength > 0 ? Buffer.from(buf).toString("base64") : null;
}

/**
 * Build the profile + custom-metric slice of a user's full backup.
 *
 * Takes the delegates it uses rather than a whole `PrismaClient` so the route's
 * global client and the worker's local one share one read, matching
 * `buildCycleBackupSection` and `buildRecordsBackupSection`.
 */
export async function buildProfileBackupSection(
  prisma: Pick<
    PrismaClient,
    | "userHealthProfile"
    | "healthProfileFactRevision"
    | "customMetric"
    | "correlationPattern"
  >,
  userId: string,
  options: ProfileBackupOptions = {},
): Promise<ProfileBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  // v1.37.19 (A6-9) — every fail-soft decrypt below records its field path
  // here; the list rides the exported file as its decryptFailures manifest.
  const decryptFailures: string[] = [];

  const [profileRow, metricRows, factRows, patternRows] = await Promise.all([
    prisma.userHealthProfile.findUnique({ where: { userId } }),
    prisma.customMetric.findMany({
      // A portable export never resurrects a tombstone; a DR payload restores
      // the account exactly as it stood, deletions included.
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { name: "asc" },
      include: {
        // v1.37.20 (A3-11) — entries soft-delete now: a portable export
        // omits tombstoned readings (a restore must not resurrect them); a
        // DR payload carries them, tombstone included, like the parent.
        entries: {
          where: disasterRecovery ? {} : { deletedAt: null },
          orderBy: { measuredAt: "asc" },
        },
      },
    }),
    prisma.healthProfileFactRevision.findMany({
      where: { userId },
      orderBy: [{ kind: "asc" }, { validFrom: "asc" }],
    }),
    prisma.correlationPattern.findMany({
      where: { userId },
      orderBy: { canonicalKey: "asc" },
    }),
  ]);

  const healthProfile: HealthProfileBackupEntry | null = profileRow
    ? disasterRecovery
      ? {
          id: profileRow.id,
          aboutMe: null,
          conditions: null,
          allergies: null,
          coachFocus: null,
          aiIncludedSections: (profileRow.aiIncludedSections as
            HealthProfileAiSection[] | undefined) ?? [
            ...DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
          ],
          emergencyBloodType: profileRow.emergencyBloodType ?? null,
          organDonorStatus: profileRow.organDonorStatus ?? null,
          advanceDirectiveStatus: profileRow.advanceDirectiveStatus ?? null,
          emergencyContacts: null,
          emergencyImplants: null,
          emergencyNote: null,
          emergencyContactsEncrypted: toBase64(
            profileRow.emergencyContactsEncrypted,
          ),
          emergencyImplantsEncrypted: toBase64(
            profileRow.emergencyImplantsEncrypted,
          ),
          emergencyNoteEncrypted: toBase64(profileRow.emergencyNoteEncrypted),
          aboutMeEncrypted: toBase64(profileRow.aboutMeEncrypted),
          conditionsEncrypted: toBase64(profileRow.conditionsEncrypted),
          allergiesEncrypted: toBase64(profileRow.allergiesEncrypted),
          coachFocusEncrypted: toBase64(profileRow.coachFocusEncrypted),
          pendingQuestionsEncrypted: toBase64(
            profileRow.pendingQuestionsEncrypted,
          ),
          createdAt: profileRow.createdAt.toISOString(),
          updatedAt: profileRow.updatedAt.toISOString(),
        }
      : {
          aboutMe: decryptProfileFieldSoft(
            profileRow.aboutMeEncrypted,
            "aboutMe",
            decryptFailures,
          ),
          conditions: decryptProfileFieldSoft(
            profileRow.conditionsEncrypted,
            "conditions",
            decryptFailures,
          ),
          allergies: decryptProfileFieldSoft(
            profileRow.allergiesEncrypted,
            "allergies",
            decryptFailures,
          ),
          coachFocus: decryptProfileFieldSoft(
            profileRow.coachFocusEncrypted,
            "coachFocus",
            decryptFailures,
          ),
          aiIncludedSections: (profileRow.aiIncludedSections as
            HealthProfileAiSection[] | undefined) ?? [
            ...DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
          ],
          emergencyBloodType: profileRow.emergencyBloodType ?? null,
          organDonorStatus: profileRow.organDonorStatus ?? null,
          advanceDirectiveStatus: profileRow.advanceDirectiveStatus ?? null,
          emergencyContacts: decryptProfileFieldSoft(
            profileRow.emergencyContactsEncrypted,
            "emergencyContacts",
            decryptFailures,
          ),
          emergencyImplants: decryptProfileFieldSoft(
            profileRow.emergencyImplantsEncrypted,
            "emergencyImplants",
            decryptFailures,
          ),
          emergencyNote: decryptProfileFieldSoft(
            profileRow.emergencyNoteEncrypted,
            "emergencyNote",
            decryptFailures,
          ),
        }
    : null;

  const healthProfileFacts: HealthProfileFactBackupEntry[] = [];
  if (disasterRecovery) {
    for (const fact of factRows) {
      healthProfileFacts.push({
        id: fact.id,
        kind: fact.kind as HealthProfileFactKind,
        value: null,
        valueEncrypted: toBase64(fact.valueEncrypted)!,
        validFrom: fact.validFrom.toISOString(),
        validUntil: fact.validUntil?.toISOString() ?? null,
        provenance: fact.provenance,
        supersededByRevisionId: fact.supersededByRevisionId,
        createdAt: fact.createdAt.toISOString(),
      });
    }
  } else {
    const sourceById = new Map(factRows.map((fact) => [fact.id, fact]));
    const readableById = new Map<string, HealthProfileFactBackupEntry>();
    for (const fact of factRows) {
      const value = decryptProfileFieldSoft(
        fact.valueEncrypted,
        `fact.${fact.kind}`,
        decryptFailures,
      );
      const kind = fact.kind as HealthProfileFactKind;
      if (
        value === null ||
        !isHealthProfileFactValue(kind, value) ||
        (fact.validUntil !== null && fact.validUntil <= fact.validFrom)
      ) {
        continue;
      }
      readableById.set(fact.id, {
        id: fact.id,
        kind,
        value,
        validFrom: fact.validFrom.toISOString(),
        validUntil: fact.validUntil?.toISOString() ?? null,
        provenance: fact.provenance,
        supersededByRevisionId: null,
        createdAt: fact.createdAt.toISOString(),
      });
    }

    for (const fact of factRows) {
      const readable = readableById.get(fact.id);
      if (!readable) continue;

      if (fact.supersededByRevisionId !== null) {
        const successor = sourceById.get(fact.supersededByRevisionId);
        if (
          fact.validUntil !== null &&
          successor &&
          successor.kind === fact.kind &&
          successor.validFrom.getTime() === fact.validUntil.getTime() &&
          readableById.has(successor.id)
        ) {
          readable.supersededByRevisionId = successor.id;
        }
      }
      healthProfileFacts.push(readable);
    }
  }
  const customMetrics: CustomMetricBackupEntry[] = metricRows.map((metric) => ({
    ...(disasterRecovery
      ? {
          id: metric.id,
          createdAt: metric.createdAt.toISOString(),
          updatedAt: metric.updatedAt.toISOString(),
          deletedAt: metric.deletedAt?.toISOString() ?? null,
        }
      : {}),
    name: metric.name,
    unit: metric.unit,
    targetLow: metric.targetLow,
    targetHigh: metric.targetHigh,
    decimals: metric.decimals,
    description: metric.description,
    correlationEnabled: metric.correlationEnabled,
    entries: metric.entries.map((entry) => ({
      ...(disasterRecovery
        ? {
            id: entry.id,
            createdAt: entry.createdAt.toISOString(),
            deletedAt: entry.deletedAt?.toISOString() ?? null,
            // v1.39.3 — the ciphertext rides verbatim. A row the free-text
            // backfill has not reached yet carries its old readable note in
            // `note` instead, as stored; the restore seals it. Sealing it
            // here would make the export non-deterministic.
            noteEncrypted: toBase64(entry.noteEncrypted),
          }
        : {}),
      value: entry.value,
      unit: entry.unit,
      measuredAt: entry.measuredAt.toISOString(),
      note: disasterRecovery
        ? entry.noteEncrypted
          ? null
          : entry.note
        : readEntryNoteSoft(entry, decryptFailures),
    })),
  }));

  const correlationPatterns: CorrelationPatternBackupEntry[] = patternRows.map(
    (pattern) => ({
      ...(disasterRecovery
        ? {
            id: pattern.id,
            updatedAt: pattern.updatedAt.toISOString(),
          }
        : {}),
      // Carried in every export, not only DR: when a finding was first made
      // is part of what it means. The correlation surface reads it to tell a
      // finding of the earlier engine from one of the seasonally adjusted
      // engine, and a restore that reset it to the restore day would drop
      // that note for good.
      createdAt: pattern.createdAt.toISOString(),
      canonicalKey: pattern.canonicalKey,
      family: pattern.family,
      factorKey: pattern.factorKey,
      outcomeKey: pattern.outcomeKey,
      lagDays: pattern.lagDays,
      sampleSize: pattern.sampleSize,
      effectSize: pattern.effectSize,
      pValue: pattern.pValue,
      qValue: pattern.qValue,
      evidenceHash: pattern.evidenceHash,
      isCurrent: pattern.isCurrent,
      lastComputedAt: pattern.lastComputedAt.toISOString(),
      dismissedAt: pattern.dismissedAt?.toISOString() ?? null,
      dismissedEvidenceHash: pattern.dismissedEvidenceHash,
      dismissedEffectSize: pattern.dismissedEffectSize,
      dismissedSampleSize: pattern.dismissedSampleSize,
    }),
  );

  return {
    healthProfile,
    healthProfileFacts,
    customMetrics,
    correlationPatterns,
    decryptFailures,
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countProfileBackupSection(
  section: ProfileBackupSection,
): ProfileBackupCounts {
  return {
    healthProfile: section.healthProfile ? 1 : 0,
    customMetrics: section.customMetrics.length,
    healthProfileFactRevisions: section.healthProfileFacts.length,
    customMetricEntries: section.customMetrics.reduce(
      (sum, metric) => sum + metric.entries.length,
      0,
    ),
    correlationPatterns: section.correlationPatterns.length,
  };
}

/** Counts the profile restore wiped, for the audit trail. */
export interface ProfileRestoreCleared {
  healthProfile: number;
  healthProfileFactRevisions: number;
  customMetrics: number;
  correlationPatterns: number;
}

/**
 * The slice of a parsed backup this restore consumes.
 *
 * Both fields are REQUIRED rather than optional. `BackupPayload` defaults them,
 * so every caller already satisfies this — and a caller that stops satisfying
 * it fails to compile instead of passing `undefined` into a loop that iterates
 * zero times and reports success.
 */
export interface ProfileRestoreInput {
  healthProfile: HealthProfileBackupEntry | null;
  healthProfileFacts: HealthProfileFactBackupEntry[];
  customMetrics: CustomMetricBackupEntry[];
  correlationPatterns: CorrelationPatternBackupEntry[];
}

/**
 * Decode a base64 ciphertext field, refusing a value that is not decodable
 * rather than writing an envelope no key can ever open.
 */
function decodeEncryptedField(
  encoded: string,
  field: string,
): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength === 0) {
    throw new Error(
      `Health profile field '${field}' carries an unreadable ciphertext value. ` +
        "Restoring it would write an envelope no key can open, which reads as " +
        "a present-but-empty answer rather than as the missing one it is.",
    );
  }
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}

/**
 * Resolve one encrypted profile column from the payload.
 *
 * Mirrors the lab-note contract: ciphertext wins when the DR payload carried
 * it, plaintext is re-encrypted when a portable export carried that instead,
 * and an absent column comes back absent.
 */
function resolveProfileColumn(
  ciphertext: string | null | undefined,
  plaintext: string | null,
  field: string,
): Uint8Array<ArrayBuffer> | null {
  if (ciphertext !== undefined) {
    return ciphertext === null ? null : decodeEncryptedField(ciphertext, field);
  }
  return plaintext == null ? null : encryptToBytes(plaintext);
}

function resolveEntryNote(entry: {
  note?: string | null;
  noteEncrypted?: string | null;
}): Uint8Array<ArrayBuffer> | null {
  if (entry.noteEncrypted !== undefined && entry.noteEncrypted !== null) {
    return decodeEncryptedField(entry.noteEncrypted, "customMetricEntry.note");
  }
  return encryptNote(entry.note);
}

function resolveFactValue(
  entry: HealthProfileFactBackupEntry,
): Uint8Array<ArrayBuffer> {
  if (entry.valueEncrypted !== undefined) {
    return decodeEncryptedField(entry.valueEncrypted, `fact.${entry.kind}`);
  }
  if (
    entry.value === null ||
    !isHealthProfileFactValue(entry.kind, entry.value)
  ) {
    throw new Error(
      `Health profile fact '${entry.kind}' has no valid readable value`,
    );
  }
  return encryptToBytes(entry.value);
}

/**
 * One fact revision's prompt-affecting identity: everything the AI prompt
 * would see differently if this revision changed. `createdAt` is
 * deliberately excluded — it never reaches the model, so two revisions that
 * differ only in when they were inserted still count as unchanged scope.
 */
interface HealthProfileFactScopeRow {
  id: string;
  kind: string;
  valueEncrypted: Uint8Array;
  validFrom: Date | string;
  validUntil: Date | string | null;
  provenance: string;
  supersededByRevisionId: string | null;
}

function factScopeSignature(row: HealthProfileFactScopeRow): string {
  const validFrom =
    typeof row.validFrom === "string"
      ? row.validFrom
      : row.validFrom.toISOString();
  const validUntil =
    row.validUntil === null
      ? ""
      : typeof row.validUntil === "string"
        ? row.validUntil
        : row.validUntil.toISOString();
  return [
    row.id,
    row.kind,
    validFrom,
    validUntil,
    row.provenance,
    row.supersededByRevisionId ?? "",
    toBase64(row.valueEncrypted) ?? "",
  ].join("|");
}

/** True when the two prompt-scope signature sets are not identical. */
function scopeSignaturesDiffer(
  live: Set<string>,
  restored: Set<string>,
): boolean {
  if (live.size !== restored.size) return true;
  for (const signature of live) {
    if (!restored.has(signature)) return true;
  }
  return false;
}

/**
 * Re-create the account's self-context and user-defined metrics.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. The metric delete cascades its entries, so the readings are wiped
 * and rebuilt with their parent rather than orphaned against it.
 */
export async function restoreProfileData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: ProfileRestoreInput,
): Promise<ProfileRestoreCleared> {
  // Snapshot the live AI-prompt scope before any restore write touches it,
  // so it can be compared with what this restore leaves behind. A restore
  // that narrows `aiIncludedSections` or changes which facts are live means
  // a cached briefing may reference content this account no longer has —
  // that comparison decides whether to clear it below, inside this same
  // transaction so the clear can never outlive a rolled-back restore.
  const liveProfileScope = await tx.userHealthProfile.findUnique({
    where: { userId: ownerId },
    select: { aiIncludedSections: true },
  });
  const liveFacts = await tx.healthProfileFactRevision.findMany({
    where: { userId: ownerId },
    select: {
      id: true,
      kind: true,
      valueEncrypted: true,
      validFrom: true,
      validUntil: true,
      provenance: true,
      supersededByRevisionId: true,
    },
  });
  const liveSections = (
    (liveProfileScope?.aiIncludedSections as
      HealthProfileAiSection[] | undefined) ??
    DEFAULT_HEALTH_PROFILE_AI_SECTIONS
  )
    .slice()
    .sort();
  const liveFactSignatures = new Set(
    liveFacts.map((fact) => factScopeSignature(fact)),
  );

  const factsCleared = await tx.healthProfileFactRevision.deleteMany({
    where: { userId: ownerId },
  });
  const profileCleared = await tx.userHealthProfile.deleteMany({
    where: { userId: ownerId },
  });
  const metricsCleared = await tx.customMetric.deleteMany({
    where: { userId: ownerId },
  });
  const patternsCleared = await tx.correlationPattern.deleteMany({
    where: { userId: ownerId },
  });

  if (payload.healthProfile) {
    const p = payload.healthProfile;
    await tx.userHealthProfile.create({
      data: {
        ...(p.id ? { id: p.id } : {}),
        userId: ownerId,
        aiIncludedSections: p.aiIncludedSections,
        aboutMeEncrypted: resolveProfileColumn(
          p.aboutMeEncrypted,
          p.aboutMe,
          "aboutMe",
        ),
        conditionsEncrypted: resolveProfileColumn(
          p.conditionsEncrypted,
          p.conditions,
          "conditions",
        ),
        allergiesEncrypted: resolveProfileColumn(
          p.allergiesEncrypted,
          p.allergies,
          "allergies",
        ),
        coachFocusEncrypted: resolveProfileColumn(
          p.coachFocusEncrypted,
          p.coachFocus,
          "coachFocus",
        ),
        // Emergency profile. The enums restore by value (null clears);
        // the three free-text columns follow the same ciphertext-or-plaintext
        // resolution as the self-context columns above.
        emergencyBloodType: p.emergencyBloodType,
        organDonorStatus: p.organDonorStatus,
        advanceDirectiveStatus: p.advanceDirectiveStatus,
        emergencyContactsEncrypted: resolveProfileColumn(
          p.emergencyContactsEncrypted,
          p.emergencyContacts,
          "emergencyContacts",
        ),
        emergencyImplantsEncrypted: resolveProfileColumn(
          p.emergencyImplantsEncrypted,
          p.emergencyImplants,
          "emergencyImplants",
        ),
        emergencyNoteEncrypted: resolveProfileColumn(
          p.emergencyNoteEncrypted,
          p.emergencyNote,
          "emergencyNote",
        ),
        // Portable exports do not carry the pending questions at all, so
        // `undefined` means "this file has nothing to say" and the account
        // comes back with no prompts pending — which the next profile save
        // regenerates. Only a DR payload can restore them.
        pendingQuestionsEncrypted:
          p.pendingQuestionsEncrypted == null
            ? null
            : decodeEncryptedField(
                p.pendingQuestionsEncrypted,
                "pendingQuestions",
              ),
        ...(p.createdAt ? { createdAt: new Date(p.createdAt) } : {}),
        ...(p.updatedAt ? { updatedAt: new Date(p.updatedAt) } : {}),
      },
    });
  }

  const restoredSections = [
    ...(payload.healthProfile?.aiIncludedSections ??
      DEFAULT_HEALTH_PROFILE_AI_SECTIONS),
  ].sort();

  const factIds = new Set<string>();
  const restoredFactSignatures = new Set<string>();
  for (const fact of payload.healthProfileFacts) {
    if (factIds.has(fact.id)) {
      throw new Error(`Duplicate health profile fact revision id: ${fact.id}`);
    }
    factIds.add(fact.id);
    const valueEncrypted = resolveFactValue(fact);
    restoredFactSignatures.add(
      factScopeSignature({
        id: fact.id,
        kind: fact.kind,
        valueEncrypted,
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        provenance: fact.provenance,
        supersededByRevisionId: fact.supersededByRevisionId,
      }),
    );
    await tx.healthProfileFactRevision.create({
      data: {
        id: fact.id,
        userId: ownerId,
        kind: fact.kind,
        valueEncrypted,
        validFrom: new Date(fact.validFrom),
        validUntil: fact.validUntil ? new Date(fact.validUntil) : null,
        provenance: fact.provenance,
        supersededByRevisionId: null,
        createdAt: new Date(fact.createdAt),
      },
    });
  }
  for (const fact of payload.healthProfileFacts) {
    if (!fact.supersededByRevisionId) continue;
    if (!factIds.has(fact.supersededByRevisionId)) {
      throw new Error(
        `Health profile fact revision '${fact.id}' points to a missing successor`,
      );
    }
    await tx.healthProfileFactRevision.update({
      where: { id: fact.id },
      data: { supersededByRevisionId: fact.supersededByRevisionId },
    });
  }

  // `(userId, name)` is unique, so two metrics sharing a name in one file
  // would collide on insert and abort the transaction with a constraint error
  // that names a column rather than the problem. Say what is wrong instead.
  const seenNames = new Set<string>();
  for (const metric of payload.customMetrics) {
    if (seenNames.has(metric.name)) {
      throw new Error(
        `Duplicate custom metric name: ${metric.name}. ` +
          "A backup cannot carry two metrics with the same name for one " +
          "account, and picking a winner here would silently discard the " +
          "readings of the other.",
      );
    }
    seenNames.add(metric.name);

    await tx.customMetric.create({
      data: {
        ...(metric.id ? { id: metric.id } : {}),
        userId: ownerId,
        name: metric.name,
        unit: metric.unit,
        targetLow: metric.targetLow,
        targetHigh: metric.targetHigh,
        decimals: metric.decimals,
        description: metric.description,
        correlationEnabled: metric.correlationEnabled,
        ...(metric.createdAt ? { createdAt: new Date(metric.createdAt) } : {}),
        ...(metric.updatedAt ? { updatedAt: new Date(metric.updatedAt) } : {}),
        deletedAt: metric.deletedAt ? new Date(metric.deletedAt) : null,
        entries: {
          create: metric.entries.map((entry) => ({
            ...(entry.id ? { id: entry.id } : {}),
            userId: ownerId,
            value: entry.value,
            unit: entry.unit,
            measuredAt: new Date(entry.measuredAt),
            // v1.39.3 — ciphertext wins when a DR payload carried it; a
            // portable file's readable note is sealed under this instance's
            // key. The readable column is never written.
            noteEncrypted: resolveEntryNote(entry),
            deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
            ...(entry.createdAt
              ? { createdAt: new Date(entry.createdAt) }
              : {}),
          })),
        },
      },
    });
  }

  const seenPatternKeys = new Set<string>();
  for (const pattern of payload.correlationPatterns) {
    if (seenPatternKeys.has(pattern.canonicalKey)) {
      throw new Error(
        `Duplicate correlation pattern key: ${pattern.canonicalKey}`,
      );
    }
    seenPatternKeys.add(pattern.canonicalKey);
    await tx.correlationPattern.create({
      data: {
        ...(pattern.id ? { id: pattern.id } : {}),
        userId: ownerId,
        canonicalKey: pattern.canonicalKey,
        family: pattern.family,
        factorKey: pattern.factorKey,
        outcomeKey: pattern.outcomeKey,
        lagDays: pattern.lagDays,
        sampleSize: pattern.sampleSize,
        effectSize: pattern.effectSize,
        pValue: pattern.pValue,
        qValue: pattern.qValue,
        evidenceHash: pattern.evidenceHash,
        isCurrent: pattern.isCurrent,
        lastComputedAt: new Date(pattern.lastComputedAt),
        dismissedAt: pattern.dismissedAt ? new Date(pattern.dismissedAt) : null,
        dismissedEvidenceHash: pattern.dismissedEvidenceHash,
        dismissedEffectSize: pattern.dismissedEffectSize,
        dismissedSampleSize: pattern.dismissedSampleSize,
        // A file from before portable exports carried `createdAt` falls back
        // to the last computation, the latest instant the finding certainly
        // existed: still earlier than this restore, which is what keeps a
        // finding of the earlier engine counted as one.
        createdAt: new Date(pattern.createdAt ?? pattern.lastComputedAt),
        ...(pattern.updatedAt
          ? { updatedAt: new Date(pattern.updatedAt) }
          : {}),
      },
    });
  }

  const sectionsChanged =
    restoredSections.length !== liveSections.length ||
    restoredSections.some((section, index) => section !== liveSections[index]);
  const factsChanged = scopeSignaturesDiffer(
    liveFactSignatures,
    restoredFactSignatures,
  );
  if (sectionsChanged || factsChanged) {
    // A narrower or altered AI-prompt scope means any cached briefing may
    // reference profile content this restore just removed or changed.
    // Clearing it here — inside the same transaction as the write that
    // changed scope — keeps the clear atomic: a failed restore leaves the
    // cache exactly as it was, and a committed one can never serve a
    // pre-restore briefing against a narrower post-restore scope.
    await tx.user.update({
      where: { id: ownerId },
      data: {
        insightsCachedText: null,
        insightsCachedAt: null,
        insightsCachedLocale: null,
      },
    });
  }

  return {
    healthProfile: profileCleared.count,
    healthProfileFactRevisions: factsCleared.count,
    customMetrics: metricsCleared.count,
    correlationPatterns: patternsCleared.count,
  };
}
