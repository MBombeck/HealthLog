/**
 * The lab record: markers with their other spellings, the merge ledger, and
 * the results filed under them. Both backup ends in one file.
 *
 * A result travels with its marker's NAME as well as its id: a portable
 * restore mints fresh marker ids, and `(userId, name)` is what the catalogue
 * is unique on, so the name is what survives the trip.
 */
import { Buffer } from "node:buffer";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  decryptContextFromBytes,
  encryptContextToBytes,
} from "@/lib/labs/biomarker-store";
import { decryptNoteFromBytes, encryptNoteToBytes } from "@/lib/labs/store";
import { foldForMatch } from "@/lib/i18n/fold-for-match";
import { annotate, getEvent } from "@/lib/logging/context";
import { UNREADABLE_EXPORT_MARKER } from "@/lib/export/unreadable-marker";
import {
  decodeEncryptedBytes,
  type RestoreContext,
} from "@/lib/export/restore-context";

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * Decrypt an encrypted free-text column for a portable export, or say plainly
 * that this one could not be read.
 *
 * A fail-soft decrypt answers `null` on a wrong or dropped key. In a list view
 * that is right — one bad row must not take the page down. In an export it is
 * not: `null` is exactly what a column that was never written looks like, so
 * the restore importer writes nothing and a note the person did write
 * disappears without anyone being told. The Coach transcript and the doctor
 * report both refuse that trade, one with a placeholder sentence and one with
 * a rendered flag; this follows the same rule.
 *
 * The warning the soft helpers emitted is kept, so a systemic key gap still
 * shows up in the wide event rather than only in the file.
 */
function readForExport(
  buf: Uint8Array | null,
  label: string,
  decode: (bytes: Uint8Array) => string,
): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decode(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `${label} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return UNREADABLE_EXPORT_MARKER;
  }
}

export interface LabResultBackupEntry {
  /** Present in canonical DR payloads so rows keep a stable identity. */
  id?: string;
  /** The source row's id in a portable payload, for the relation links. */
  ref?: string;
  panel: string | null;
  analyte: string;
  value: number | null;
  valueText: string | null;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  /** The window the reading's own source report printed, verbatim + derived. */
  sourceReferenceLow: number | null;
  sourceReferenceHigh: number | null;
  sourceReferenceText: string | null;
  /**
   * The value and unit the source report printed, kept when a write
   * converted the reading into its marker's unit.
   */
  sourceValue?: number | null;
  sourceUnit?: string | null;
  takenAt: string;
  source: string;
  /** The identity a Health Records reading arrived under (a digest), so a
   *  restored account still recognises it when it arrives again. */
  externalId?: string | null;
  /** Human-readable cross-reference into `biomarkers` below, not an id. */
  /** Stable canonical FK; legacy portable payloads use biomarkerName. */
  biomarkerId?: string | null;
  biomarkerName: string | null;
  note: string | null;
  /** Base64 ciphertext in canonical DR payloads. */
  noteEncrypted?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface BiomarkerBackupEntry {
  /** Present in canonical DR payloads; name remains the natural key. */
  id?: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  hidden: boolean;
  context: string | null;
  /**
   * The context's ciphertext as base64, disaster-recovery files only, where
   * `context` is null. A file without it carries the readable context.
   */
  contextEncrypted?: string | null;
  /** The catalogue key the marker's name and unit resolve to. */
  analyteKey?: string | null;
  /**
   * The other spellings the marker answers to, with where
   * each came from. Absent on files written before them.
   */
  aliases?: BiomarkerAliasBackupEntry[];
  createdAt?: string;
  updatedAt?: string;
}

export interface BiomarkerAliasBackupEntry {
  /** Present in canonical DR payloads. */
  id?: string;
  name: string;
  source: "MERGE" | "IMPORT_CHOICE" | "MANUAL";
  createdAt?: string;
}

/**
 * One marker folded into another. The target travels by id
 * in a disaster-recovery file and by name in both, the way a lab result's
 * marker does; the source is gone, so its id and name are the record.
 */
export interface BiomarkerMergeBackupEntry {
  id?: string;
  targetBiomarkerId?: string;
  targetName: string;
  sourceBiomarkerId: string;
  sourceName: string;
  readingCount: number;
  mergedAt: string;
}

/** The lab slice of the records section: results, markers, merge ledger. */
export async function buildLabsBackupSlice(
  prisma: Pick<
    PrismaClient,
    "labResult" | "biomarker" | "biomarkerAlias" | "biomarkerMerge"
  >,
  userId: string,
  disasterRecovery: boolean,
): Promise<{
  labResults: LabResultBackupEntry[];
  biomarkers: BiomarkerBackupEntry[];
  biomarkerMerges: BiomarkerMergeBackupEntry[];
}> {
  const [labResultRows, biomarkerRows, biomarkerAliasRows, biomarkerMergeRows] =
    await Promise.all([
      prisma.labResult.findMany({
        where: disasterRecovery ? { userId } : { userId, deletedAt: null },
        orderBy: [{ takenAt: "desc" }, { id: "asc" }],
        include: { biomarker: { select: { name: true } } },
      }),
      prisma.biomarker.findMany({
        where: { userId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
      prisma.biomarkerAlias.findMany({
        where: { userId },
        orderBy: [{ biomarkerId: "asc" }, { nameFolded: "asc" }, { id: "asc" }],
        select: {
          id: true,
          biomarkerId: true,
          name: true,
          source: true,
          createdAt: true,
        },
      }),
      prisma.biomarkerMerge.findMany({
        where: { userId },
        orderBy: [{ mergedAt: "asc" }, { id: "asc" }],
        include: { target: { select: { name: true } } },
      }),
    ]);

  const labResults: LabResultBackupEntry[] = labResultRows.map((r) => ({
    ...(disasterRecovery
      ? {
          id: r.id,
          biomarkerId: r.biomarkerId,
          noteEncrypted: r.noteEncrypted
            ? Buffer.from(r.noteEncrypted).toString("base64")
            : null,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          deletedAt: r.deletedAt?.toISOString() ?? null,
          note: null,
        }
      : {
          // No id: a portable restore mints a fresh one. The relation links
          // still name this row, so the file says which row they mean.
          ref: r.id,
          note: readForExport(
            r.noteEncrypted,
            "lab note",
            decryptNoteFromBytes,
          ),
        }),
    panel: r.panel,
    analyte: r.analyte,
    value: r.value,
    valueText: r.valueText,
    unit: r.unit,
    referenceLow: r.referenceLow,
    referenceHigh: r.referenceHigh,
    sourceReferenceLow: r.sourceReferenceLow,
    sourceReferenceHigh: r.sourceReferenceHigh,
    sourceReferenceText: r.sourceReferenceText,
    sourceValue: r.sourceValue,
    sourceUnit: r.sourceUnit,
    takenAt: r.takenAt.toISOString(),
    source: r.source,
    externalId: r.externalId,
    biomarkerName: r.biomarker?.name ?? null,
  }));

  const aliasesByMarker = new Map<string, BiomarkerAliasBackupEntry[]>();
  for (const alias of biomarkerAliasRows) {
    const list = aliasesByMarker.get(alias.biomarkerId) ?? [];
    list.push({
      name: alias.name,
      source: alias.source as BiomarkerAliasBackupEntry["source"],
      ...(disasterRecovery
        ? { id: alias.id, createdAt: alias.createdAt.toISOString() }
        : {}),
    });
    aliasesByMarker.set(alias.biomarkerId, list);
  }

  const biomarkerMerges: BiomarkerMergeBackupEntry[] = biomarkerMergeRows.map(
    (m) => ({
      ...(disasterRecovery
        ? { id: m.id, targetBiomarkerId: m.targetBiomarkerId }
        : {}),
      targetName: m.target.name,
      sourceBiomarkerId: m.sourceBiomarkerId,
      sourceName: m.sourceName,
      readingCount: m.readingCount,
      mergedAt: m.mergedAt.toISOString(),
    }),
  );

  const biomarkers: BiomarkerBackupEntry[] = biomarkerRows.map((b) => ({
    ...(disasterRecovery
      ? {
          id: b.id,
          createdAt: b.createdAt.toISOString(),
          updatedAt: b.updatedAt.toISOString(),
        }
      : {}),
    name: b.name,
    unit: b.unit,
    lowerBound: b.lowerBound,
    upperBound: b.upperBound,
    panel: b.panel,
    hidden: b.hidden,
    // Ciphertext verbatim in a disaster-recovery file, like every other
    // sealed column; the readable context in a portable one.
    ...(disasterRecovery
      ? {
          context: null,
          contextEncrypted: b.contextEncrypted
            ? Buffer.from(b.contextEncrypted).toString("base64")
            : null,
        }
      : {
          context: readForExport(
            b.contextEncrypted,
            "biomarker context",
            decryptContextFromBytes,
          ),
        }),
    analyteKey: b.analyteKey,
    aliases: aliasesByMarker.get(b.id) ?? [],
  }));

  return { labResults, biomarkers, biomarkerMerges };
}

// ── Restore ──────────────────────────────────────────────────────────────────

export async function clearLabResults(ctx: RestoreContext): Promise<void> {
  const labResults = await ctx.tx.labResult.deleteMany({
    where: { userId: ctx.ownerId },
  });
  ctx.cleared.labResults = labResults.count;
}

export async function clearBiomarkers(ctx: RestoreContext): Promise<void> {
  const biomarkers = await ctx.tx.biomarker.deleteMany({
    where: { userId: ctx.ownerId },
  });
  ctx.cleared.biomarkers = biomarkers.count;
}

/**
 * The merge ledger, against the markers just written: by id where the file
 * carries one this restore kept, by name otherwise. A row whose target the
 * file does not carry has nothing to point at and is left out (counted on the
 * event).
 */
async function restoreBiomarkerMerges(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload } = ctx;
  const { biomarkerByName, restoredBiomarkerIds } = ctx.links;
  let unresolvedMerges = 0;
  const mergeRows = (payload.biomarkerMerges ?? []).flatMap((merge) => {
    const targetId =
      merge.targetBiomarkerId &&
      restoredBiomarkerIds.has(merge.targetBiomarkerId)
        ? merge.targetBiomarkerId
        : biomarkerByName.get(merge.targetName);
    if (!targetId) {
      unresolvedMerges += 1;
      return [];
    }
    return [
      {
        ...(merge.id ? { id: merge.id } : {}),
        userId: ownerId,
        targetBiomarkerId: targetId,
        sourceBiomarkerId: merge.sourceBiomarkerId,
        sourceName: merge.sourceName,
        readingCount: merge.readingCount,
        mergedAt: new Date(merge.mergedAt),
      },
    ];
  });
  if (mergeRows.length > 0) {
    await tx.biomarkerMerge.createMany({ data: mergeRows });
  }
  if (unresolvedMerges > 0) {
    annotate({
      action: { name: "backup.restore.biomarkerMerge.unresolved" },
      meta: { count: unresolvedMerges },
    });
  }
}

/** The markers, each with its other spellings, then the merge ledger. */
export async function restoreLabMarkers(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload } = ctx;
  const { biomarkerByName, restoredBiomarkerIds } = ctx.links;
  ctx.reportSection("labs");
  for (const biomarker of payload.biomarkers) {
    const created = await tx.biomarker.create({
      data: {
        ...(biomarker.id ? { id: biomarker.id } : {}),
        userId: ownerId,
        name: biomarker.name,
        unit: biomarker.unit,
        lowerBound: biomarker.lowerBound ?? null,
        upperBound: biomarker.upperBound ?? null,
        panel: biomarker.panel ?? null,
        hidden: biomarker.hidden ?? false,
        contextEncrypted:
          biomarker.contextEncrypted !== undefined
            ? biomarker.contextEncrypted === null
              ? null
              : decodeEncryptedBytes(biomarker.contextEncrypted)
            : biomarker.context == null
              ? null
              : encryptContextToBytes(biomarker.context),
        analyteKey: biomarker.analyteKey ?? null,
        ...(biomarker.createdAt
          ? { createdAt: new Date(biomarker.createdAt) }
          : {}),
        ...(biomarker.updatedAt
          ? { updatedAt: new Date(biomarker.updatedAt) }
          : {}),
      },
    });
    biomarkerByName.set(biomarker.name, created.id);
    restoredBiomarkerIds.add(created.id);
    // The other spellings, folded the way the resolver reads them, so the
    // next scan matches them again.
    const aliasRows = (biomarker.aliases ?? [])
      .map((alias) => ({
        id: alias.id,
        name: alias.name.trim().slice(0, 120),
        nameFolded: foldForMatch(alias.name).slice(0, 120),
        source: alias.source,
        createdAt: alias.createdAt,
      }))
      .filter(
        (alias) =>
          alias.nameFolded !== "" &&
          alias.nameFolded !== foldForMatch(biomarker.name),
      );
    if (aliasRows.length > 0) {
      await tx.biomarkerAlias.createMany({
        data: aliasRows.map((alias) => ({
          ...(alias.id ? { id: alias.id } : {}),
          userId: ownerId,
          biomarkerId: created.id,
          name: alias.name,
          nameFolded: alias.nameFolded,
          source: alias.source,
          ...(alias.createdAt ? { createdAt: new Date(alias.createdAt) } : {}),
        })),
        // One spelling answers to one marker per account; a file that names
        // it twice keeps the first.
        skipDuplicates: true,
      });
    }
  }
  await restoreBiomarkerMerges(ctx);
}

/**
 * The results, against the markers written above. The ids written are
 * collected for the staged facts later on: an approved fact's
 * `committedRecordId` names the lab result it was committed to.
 */
export async function restoreLabResults(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload } = ctx;
  const {
    biomarkerByName,
    restoredBiomarkerIds,
    restoredLabResultIds,
    labResultIdBySourceId,
  } = ctx.links;
  for (const lab of payload.labResults) {
    const biomarkerId =
      lab.biomarkerId !== undefined
        ? lab.biomarkerId === null
          ? null
          : restoredBiomarkerIds.has(lab.biomarkerId)
            ? lab.biomarkerId
            : undefined
        : lab.biomarkerName
          ? biomarkerByName.get(lab.biomarkerName)
          : null;
    if (biomarkerId === undefined) {
      throw new Error(
        `Unknown biomarker reference: ${lab.biomarkerId ?? lab.biomarkerName}`,
      );
    }
    const createdLab = await tx.labResult.create({
      data: {
        ...(lab.id ? { id: lab.id } : {}),
        userId: ownerId,
        biomarkerId: biomarkerId ?? null,
        panel: lab.panel ?? null,
        analyte: lab.analyte,
        value: lab.value ?? null,
        valueText: lab.valueText ?? null,
        unit: lab.unit,
        referenceLow: lab.referenceLow ?? null,
        referenceHigh: lab.referenceHigh ?? null,
        sourceReferenceLow: lab.sourceReferenceLow ?? null,
        sourceReferenceHigh: lab.sourceReferenceHigh ?? null,
        sourceReferenceText: lab.sourceReferenceText ?? null,
        sourceValue: lab.sourceValue ?? null,
        sourceUnit: lab.sourceUnit ?? null,
        takenAt: new Date(lab.takenAt),
        source: lab.source,
        externalId: lab.externalId ?? null,
        noteEncrypted:
          lab.noteEncrypted !== undefined
            ? lab.noteEncrypted === null
              ? null
              : decodeEncryptedBytes(lab.noteEncrypted)
            : lab.note == null
              ? null
              : encryptNoteToBytes(lab.note),
        deletedAt: lab.deletedAt ? new Date(lab.deletedAt) : null,
        ...(lab.createdAt ? { createdAt: new Date(lab.createdAt) } : {}),
        ...(lab.updatedAt ? { updatedAt: new Date(lab.updatedAt) } : {}),
      },
    });
    restoredLabResultIds.add(createdLab.id);
    // Same arrangement as the medications' source-id map.
    const labSourceId = lab.id ?? lab.ref;
    if (labSourceId) labResultIdBySourceId.set(labSourceId, createdLab.id);
  }
}
