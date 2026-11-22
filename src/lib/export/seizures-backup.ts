/**
 * The seizure diary, with both backup ends in one file (#1368).
 *
 * Same arrangement as `symptoms-backup.ts`: a reader asking "is this carried
 * at both ends?" answers it here.
 *
 * ## Shape
 *
 * Three parts: the person's seizure types, the recorded seizures with their
 * rescue doses nested inside (a dose means nothing without its seizure, so a
 * nested create binds it to whatever id the seizure got), and the cluster
 * rule. A seizure points at its type by the type's SOURCE id: a
 * disaster-recovery file carries it as the type's `id` (the row keeps it), a
 * portable file as `ref` (the row gets a new id and the restore maps the
 * reference), so a portable file restored beside the account it came from
 * cannot collide.
 *
 * ## Free text follows the note contract
 *
 * A disaster-recovery payload carries the ciphertext verbatim as base64; a
 * portable export decrypts it. A label this instance cannot decrypt travels as
 * the visible unreadable marker rather than as nothing.
 *
 * ## References into other domains
 *
 * The rescue medication of a type and of a dose resolves through the
 * medication step's `medicationIdBySourceId`; a miss is nulled (the dose keeps
 * its name snapshot). The intake a dose wrote is kept only when that intake
 * row exists on the restored account: by its id in a disaster-recovery file,
 * and in a portable one through the slot the intake step recorded for the
 * intake's `ref`. A miss is nulled and reported (`seizureIntakeReference`). Who logged a seizure travels as
 * "owner" / "delegate": the owner maps to the restored account, a delegate
 * keeps the id it had (it renders as "someone acting on the record").
 */
import { Buffer } from "node:buffer";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";
import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

import type { RestoredIntakeSlot } from "@/lib/export/restore-context";

import { UNREADABLE_EXPORT_MARKER } from "./unreadable-marker";

export interface SeizuresBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

type Sealed = string | null | undefined;

export interface SeizureTypeBackupEntry {
  /** Present in a disaster-recovery payload; the row keeps it. */
  id?: string;
  /** Present in a portable payload: the source id the seizures name. */
  ref?: string;
  label?: string;
  labelEncrypted?: string;
  ilaeType: string;
  usualDurationSec: number | null;
  rescuePlan?: string | null;
  rescuePlanEncrypted?: string | null;
  rescueMedicationId: string | null;
  rescueDoseAmount: number | null;
  rescueDoseUnit: string | null;
  rescueRoute: string | null;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SeizureRescueDoseBackupEntry {
  id?: string;
  medicationId: string | null;
  medicationName: string;
  doseAmount: number | null;
  doseUnit: string | null;
  route: string | null;
  givenAt: string;
  givenBy: string | null;
  effect: string;
  seizureEndedAt: string | null;
  intakeEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SeizureEventBackupEntry {
  id?: string;
  typeProfileId: string | null;
  ilaeType: string | null;
  ilaeTypeAtLog: string | null;
  onsetAt: string;
  onsetPrecision: string;
  durationSec: number | null;
  durationSource: string;
  count: number;
  certainty: string;
  sleepState: string;
  observableManifestations: string | null;
  responsiveness: string | null;
  recall: string | null;
  semiology: string[];
  semiologyNote?: string | null;
  semiologyNoteEncrypted?: string | null;
  aura?: string | null;
  auraEncrypted?: string | null;
  triggers: string[];
  postictalMinutes: number | null;
  postictal: string[];
  injuries: string[];
  incontinence: boolean | null;
  emergency: string;
  witnessed: boolean | null;
  witnessRole: string | null;
  witnessNote?: string | null;
  witnessNoteEncrypted?: string | null;
  loggedBy: "owner" | "delegate" | "unknown";
  loggedByUserId: string | null;
  source: string;
  note?: string | null;
  noteEncrypted?: string | null;
  createdAt: string;
  updatedAt: string;
  rescueDoses: SeizureRescueDoseBackupEntry[];
}

export interface SeizuresBackupSection {
  seizureTypes: SeizureTypeBackupEntry[];
  seizureEvents: SeizureEventBackupEntry[];
  seizureSettings: {
    clusterCount: number;
    clusterWindowHours: number;
    createdAt: string;
    updatedAt: string;
  } | null;
}

export interface SeizuresBackupCounts {
  seizureTypes: number;
  seizureEvents: number;
  seizureRescueDoses: number;
}

function base64(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

function readText(buf: Uint8Array, field: string): string {
  try {
    return decryptFromBytes(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `seizure ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return UNREADABLE_EXPORT_MARKER;
  }
}

/** One optional sealed column, in the shape the purpose asks for. */
function textField<K extends string>(
  key: K,
  buf: Uint8Array | null,
  disasterRecovery: boolean,
): Record<string, string | null> {
  if (disasterRecovery) {
    return { [`${key}Encrypted`]: buf ? base64(buf) : null };
  }
  return { [key]: buf ? readText(buf, key) : null };
}

/** Build the seizure slice of a user's full backup. */
export async function buildSeizuresBackupSection(
  prisma: Pick<
    PrismaClient,
    "seizureTypeProfile" | "seizureEvent" | "seizureDiarySettings"
  >,
  userId: string,
  options: SeizuresBackupOptions = {},
): Promise<SeizuresBackupSection> {
  const dr = options.purpose === "disaster-recovery";
  const [types, events, settings] = await Promise.all([
    prisma.seizureTypeProfile.findMany({
      where: { userId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.seizureEvent.findMany({
      where: { userId },
      orderBy: [{ onsetAt: "asc" }, { id: "asc" }],
      include: {
        rescueDoses: { orderBy: [{ givenAt: "asc" }, { id: "asc" }] },
      },
    }),
    prisma.seizureDiarySettings.findUnique({ where: { userId } }),
  ]);

  return {
    seizureTypes: types.map((t) => ({
      ...(dr ? { id: t.id } : { ref: t.id }),
      ...(dr
        ? { labelEncrypted: base64(t.labelEncrypted) }
        : { label: readText(t.labelEncrypted, "label") }),
      ...textField("rescuePlan", t.rescuePlanEncrypted, dr),
      ilaeType: t.ilaeType,
      usualDurationSec: t.usualDurationSec,
      rescueMedicationId: t.rescueMedicationId,
      rescueDoseAmount: t.rescueDoseAmount,
      rescueDoseUnit: t.rescueDoseUnit,
      rescueRoute: t.rescueRoute,
      sortOrder: t.sortOrder,
      archivedAt: t.archivedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
    seizureEvents: events.map((e) => ({
      ...(dr ? { id: e.id } : {}),
      typeProfileId: e.typeProfileId,
      ilaeType: e.ilaeType,
      ilaeTypeAtLog: e.ilaeTypeAtLog,
      onsetAt: e.onsetAt.toISOString(),
      onsetPrecision: e.onsetPrecision,
      durationSec: e.durationSec,
      durationSource: e.durationSource,
      count: e.count,
      certainty: e.certainty,
      sleepState: e.sleepState,
      observableManifestations: e.observableManifestations,
      responsiveness: e.responsiveness,
      recall: e.recall,
      semiology: e.semiology,
      ...textField("semiologyNote", e.semiologyNoteEncrypted, dr),
      ...textField("aura", e.auraEncrypted, dr),
      triggers: e.triggers,
      postictalMinutes: e.postictalMinutes,
      postictal: e.postictal,
      injuries: e.injuries,
      incontinence: e.incontinence,
      emergency: e.emergency,
      witnessed: e.witnessed,
      witnessRole: e.witnessRole,
      ...textField("witnessNote", e.witnessNoteEncrypted, dr),
      loggedBy:
        e.loggedByUserId === null
          ? ("unknown" as const)
          : e.loggedByUserId === userId
            ? ("owner" as const)
            : ("delegate" as const),
      loggedByUserId:
        e.loggedByUserId !== null && e.loggedByUserId !== userId
          ? e.loggedByUserId
          : null,
      source: e.source,
      ...textField("note", e.noteEncrypted, dr),
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
      rescueDoses: e.rescueDoses.map((d) => ({
        ...(dr ? { id: d.id } : {}),
        medicationId: d.medicationId,
        medicationName: d.medicationName,
        doseAmount: d.doseAmount,
        doseUnit: d.doseUnit,
        route: d.route,
        givenAt: d.givenAt.toISOString(),
        givenBy: d.givenBy,
        effect: d.effect,
        seizureEndedAt: d.seizureEndedAt?.toISOString() ?? null,
        intakeEventId: d.intakeEventId,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      })),
    })) as SeizureEventBackupEntry[],
    seizureSettings: settings
      ? {
          clusterCount: settings.clusterCount,
          clusterWindowHours: settings.clusterWindowHours,
          createdAt: settings.createdAt.toISOString(),
          updatedAt: settings.updatedAt.toISOString(),
        }
      : null,
  };
}

export function countSeizuresBackupSection(
  section: SeizuresBackupSection,
): SeizuresBackupCounts {
  return {
    seizureTypes: section.seizureTypes.length,
    seizureEvents: section.seizureEvents.length,
    seizureRescueDoses: section.seizureEvents.reduce(
      (sum, e) => sum + e.rescueDoses.length,
      0,
    ),
  };
}

/** Counts the seizure restore wiped, for the audit trail. */
export interface SeizuresRestoreCleared {
  seizureTypes: number;
  seizureEvents: number;
}

type Loose<T> = { [K in keyof T]?: T[K] | null | undefined };

/** What the parser hands over: an older file carries none of the keys. */
export interface SeizuresRestoreInput {
  seizureTypes?: Array<
    Loose<SeizureTypeBackupEntry> & {
      ilaeType: string;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
    }
  >;
  seizureEvents?: Array<
    Loose<Omit<SeizureEventBackupEntry, "rescueDoses">> & {
      onsetAt: string;
      createdAt: string;
      updatedAt: string;
      rescueDoses?: Array<
        Loose<SeizureRescueDoseBackupEntry> & {
          medicationName: string;
          givenAt: string;
          createdAt: string;
          updatedAt: string;
        }
      >;
    }
  >;
  seizureSettings?: {
    clusterCount: number;
    clusterWindowHours: number;
    createdAt?: string | undefined;
    updatedAt?: string | undefined;
  } | null;
}

function decodeBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}

/** The stored form of one text field from either end of the contract. */
function sealedFrom(
  plain: Sealed,
  encrypted: Sealed,
): Uint8Array<ArrayBuffer> | null {
  if (encrypted !== undefined && encrypted !== null) {
    return decodeBytes(encrypted);
  }
  return plain ? encryptToBytes(plain) : null;
}

const date = (v: string | null | undefined) => (v ? new Date(v) : null);

/* eslint-disable @typescript-eslint/no-explicit-any -- enum columns arrive as
   validated strings from the payload schema; the Prisma enum types are the
   same literals. */

/**
 * The intake each rescue dose of the file wrote, keyed by the id the file
 * names. A disaster-recovery file kept the intake's id, so the row is looked
 * up by it. A portable file's intakes came back under fresh ids; the dose
 * names the source id, which the medication step mapped to the live slot the
 * row occupies, and the slot is unique.
 */
async function resolveRescueIntakes(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: SeizuresRestoreInput,
  intakeSlotBySourceId: ReadonlyMap<string, RestoredIntakeSlot>,
): Promise<Map<string, string>> {
  const intakeBySource = new Map<string, string>();
  const referencedIntakes = (payload.seizureEvents ?? []).flatMap((e) =>
    (e.rescueDoses ?? []).flatMap((d) =>
      d.intakeEventId ? [d.intakeEventId] : [],
    ),
  );
  if (referencedIntakes.length > 0) {
    const rows = await tx.medicationIntakeEvent.findMany({
      where: { userId: ownerId, id: { in: referencedIntakes } },
      select: { id: true },
    });
    for (const r of rows) intakeBySource.set(r.id, r.id);
    for (const sourceId of new Set(referencedIntakes)) {
      if (intakeBySource.has(sourceId)) continue;
      const slot = intakeSlotBySourceId.get(sourceId);
      if (!slot) continue;
      const row = await tx.medicationIntakeEvent.findFirst({
        where: {
          userId: ownerId,
          medicationId: slot.medicationId,
          scheduledFor: slot.scheduledFor,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (row) intakeBySource.set(sourceId, row.id);
    }
  }
  return intakeBySource;
}

/**
 * Re-create the account's seizure diary. Delete-then-recreate inside the
 * caller's transaction; deleting a seizure cascades its doses. MUST run AFTER
 * the medications step (`medicationIdBySourceId`) and the intake events.
 */
export async function restoreSeizuresData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: SeizuresRestoreInput,
  medicationIdBySourceId: ReadonlyMap<string, string>,
  skips: RestoreSkipLog,
  intakeSlotBySourceId: ReadonlyMap<string, RestoredIntakeSlot>,
): Promise<SeizuresRestoreCleared> {
  const clearedEvents = await tx.seizureEvent.deleteMany({
    where: { userId: ownerId },
  });
  const clearedTypes = await tx.seizureTypeProfile.deleteMany({
    where: { userId: ownerId },
  });
  await tx.seizureDiarySettings.deleteMany({ where: { userId: ownerId } });

  const droppedMedications: string[] = [];
  const medication = (sourceId: string | null | undefined): string | null => {
    if (!sourceId) return null;
    const mapped = medicationIdBySourceId.get(sourceId);
    if (!mapped) droppedMedications.push(sourceId);
    return mapped ?? null;
  };

  const typeIdBySource = new Map<string, string>();
  for (const t of payload.seizureTypes ?? []) {
    const created = await tx.seizureTypeProfile.create({
      data: {
        ...(t.id ? { id: t.id } : {}),
        userId: ownerId,
        labelEncrypted:
          sealedFrom(t.label, t.labelEncrypted) ?? encryptToBytes(""),
        ilaeType: t.ilaeType as any,
        usualDurationSec: t.usualDurationSec ?? null,
        rescuePlanEncrypted: sealedFrom(t.rescuePlan, t.rescuePlanEncrypted),
        rescueMedicationId: medication(t.rescueMedicationId),
        rescueDoseAmount: t.rescueDoseAmount ?? null,
        rescueDoseUnit: t.rescueDoseUnit ?? null,
        rescueRoute: (t.rescueRoute ?? null) as any,
        sortOrder: t.sortOrder,
        archivedAt: date(t.archivedAt),
        createdAt: new Date(t.createdAt),
        updatedAt: new Date(t.updatedAt),
      },
      select: { id: true },
    });
    const source = t.id ?? t.ref;
    if (source) typeIdBySource.set(source, created.id);
  }

  const intakeBySource = await resolveRescueIntakes(
    tx,
    ownerId,
    payload,
    intakeSlotBySourceId,
  );
  // Without the link, deleting the seizure or the dose leaves the intake and
  // its stock deduction standing, so a dropped link is reported, not hidden.
  const droppedIntakes: string[] = [];
  const intake = (sourceId: string | null | undefined): string | null => {
    if (!sourceId) return null;
    const mapped = intakeBySource.get(sourceId);
    if (!mapped) droppedIntakes.push(sourceId);
    return mapped ?? null;
  };

  const droppedTypes: string[] = [];
  for (const e of payload.seizureEvents ?? []) {
    let typeProfileId: string | null = null;
    if (e.typeProfileId) {
      typeProfileId = typeIdBySource.get(e.typeProfileId) ?? null;
      if (!typeProfileId) droppedTypes.push(e.typeProfileId);
    }
    await tx.seizureEvent.create({
      data: {
        ...(e.id ? { id: e.id } : {}),
        userId: ownerId,
        typeProfileId,
        ilaeType: (e.ilaeType ?? null) as any,
        // An older file kept no class at logging: the type's current one
        // stands in, as the reader falls back to it anyway.
        ilaeTypeAtLog: (typeProfileId
          ? (e.ilaeTypeAtLog ?? null)
          : null) as any,
        onsetAt: new Date(e.onsetAt),
        onsetPrecision: (e.onsetPrecision ?? "EXACT") as any,
        durationSec: e.durationSec ?? null,
        durationSource: (e.durationSource ?? "UNKNOWN") as any,
        count: e.count ?? 1,
        certainty: (e.certainty ?? "CONFIRMED") as any,
        sleepState: (e.sleepState ?? "UNKNOWN") as any,
        observableManifestations: (e.observableManifestations ?? null) as any,
        responsiveness: (e.responsiveness ?? null) as any,
        recall: (e.recall ?? null) as any,
        semiology: (e.semiology ?? []) as any,
        semiologyNoteEncrypted: sealedFrom(
          e.semiologyNote,
          e.semiologyNoteEncrypted,
        ),
        auraEncrypted: sealedFrom(e.aura, e.auraEncrypted),
        triggers: (e.triggers ?? []) as any,
        postictalMinutes: e.postictalMinutes ?? null,
        postictal: (e.postictal ?? []) as any,
        injuries: (e.injuries ?? []) as any,
        incontinence: e.incontinence ?? null,
        emergency: (e.emergency ?? "NONE") as any,
        witnessed: e.witnessed ?? null,
        witnessRole: (e.witnessRole ?? null) as any,
        witnessNoteEncrypted: sealedFrom(e.witnessNote, e.witnessNoteEncrypted),
        loggedByUserId:
          e.loggedBy === "owner"
            ? ownerId
            : e.loggedBy === "delegate"
              ? (e.loggedByUserId ?? null)
              : null,
        source: (e.source ?? "MANUAL") as any,
        noteEncrypted: sealedFrom(e.note, e.noteEncrypted),
        createdAt: new Date(e.createdAt),
        updatedAt: new Date(e.updatedAt),
        rescueDoses: {
          create: (e.rescueDoses ?? []).map((d) => ({
            ...(d.id ? { id: d.id } : {}),
            userId: ownerId,
            medicationId: medication(d.medicationId),
            medicationName: d.medicationName,
            doseAmount: d.doseAmount ?? null,
            doseUnit: d.doseUnit ?? null,
            route: (d.route ?? null) as any,
            givenAt: new Date(d.givenAt),
            givenBy: (d.givenBy ?? null) as any,
            effect: (d.effect ?? "UNKNOWN") as any,
            seizureEndedAt: date(d.seizureEndedAt),
            intakeEventId: intake(d.intakeEventId),
            createdAt: new Date(d.createdAt),
            updatedAt: new Date(d.updatedAt),
          })),
        },
      },
    });
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  if (payload.seizureSettings) {
    await tx.seizureDiarySettings.create({
      data: {
        userId: ownerId,
        clusterCount: payload.seizureSettings.clusterCount,
        clusterWindowHours: payload.seizureSettings.clusterWindowHours,
        ...(payload.seizureSettings.createdAt
          ? { createdAt: new Date(payload.seizureSettings.createdAt) }
          : {}),
        ...(payload.seizureSettings.updatedAt
          ? { updatedAt: new Date(payload.seizureSettings.updatedAt) }
          : {}),
      },
    });
  }

  recordUnknownKeys(
    skips,
    "seizureMedicationReference",
    [...new Set(droppedMedications)],
    droppedMedications,
  );
  recordUnknownKeys(
    skips,
    "seizureTypeReference",
    [...new Set(droppedTypes)],
    droppedTypes,
  );
  recordUnknownKeys(
    skips,
    "seizureIntakeReference",
    [...new Set(droppedIntakes)],
    droppedIntakes,
  );

  return {
    seizureTypes: clearedTypes.count,
    seizureEvents: clearedEvents.count,
  };
}
