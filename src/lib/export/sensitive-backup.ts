/**
 * Two models that travel in a disaster-recovery file and deliberately not in a
 * portable one, for two entirely different reasons.
 *
 * Everywhere else in this directory the split between the two export purposes
 * is about ENCODING: a portable file decrypts prose for the person who owns it,
 * a disaster-recovery file carries the ciphertext their own instance can read
 * back. Here the split is about whether the row should leave the instance at
 * all. That is a different kind of decision and it is worth stating plainly
 * rather than leaving a reader to infer it from a missing key.
 *
 * ## The screeners
 *
 * `MentalHealthAssessment` holds completed WHO-5, PHQ and GAD administrations.
 * The per-item answers live in `responsesEncrypted`, and for PHQ-9 that blob
 * contains item 9, the question about thoughts of being better off dead or of
 * hurting oneself. The schema comment says it outright: the item-9 raw value
 * lives ONLY there.
 *
 * The application already draws a line around that blob. It keeps
 * `item9Flagged` as a coarse boolean precisely so the history view can
 * re-surface crisis resources WITHOUT decrypting anything. Following the
 * instance's own line was the intent here: carry the administration as the
 * history view sees it, leave the answers encrypted.
 *
 * The schema settles it more firmly than that. `responsesEncrypted` is `Bytes`
 * and NOT NULL, so there is no honest half-row to write: a portable file with
 * no ciphertext could not restore an administration even if it wanted to. The
 * choice is the whole row or nothing, and a plaintext JSON file sitting in
 * somebody's downloads folder is the wrong home for that answer. So the whole
 * row rides only in a disaster-recovery file, and the portable file SAYS it
 * does not carry them rather than reporting an account with no screeners.
 *
 * ## The consent receipts
 *
 * `ConsentReceipt` is not sensitive in the same way. Its problem is that a
 * consent is given to an OPERATOR, not to a file. The coverage register raised
 * this itself, filed as "arguably belongs with the instance rather than the
 * account", and the argument holds: a receipt restored onto a different
 * instance asserts an agreement that instance's operator never obtained, with
 * a signature timestamp to make it look settled.
 *
 * A disaster-recovery file goes back to the same instance and the same
 * operator, so the consent it records still stands. A portable file can land
 * anywhere. So the receipts travel in the first and not in the second, and
 * again the file says so.
 *
 * ## What both of these are NOT
 *
 * Neither is an id-remap problem, an ordering problem, or unbuilt work. Both
 * hang off the user directly with no reference to anything else, so a future
 * reader looking for the reason they sat on the register will not find it in
 * the code. It is here.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import type { AssessmentInstrument } from "@/generated/prisma/client";
import {
  isAssessmentWording,
  type AssessmentWording,
} from "@/lib/mental-health/wording/types";

export interface SensitiveBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** One completed screener administration, ciphertext and all. */
export interface MentalHealthAssessmentBackupEntry {
  id: string;
  instrument: AssessmentInstrument;
  locale: string;
  /** Which text the answers were given in; null before it was recorded. */
  wording: AssessmentWording | null;
  version: string;
  /** Ciphertext as base64. The per-item answers, including PHQ-9 item 9. */
  responsesEncrypted: string;
  totalScore: number;
  severityBand: string;
  item9Flagged: boolean;
  crisisShownAt: string | null;
  takenAt: string;
  tz: string | null;
  source: string;
  externalId: string | null;
  syncVersion: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One record of what the account agreed to, and when. */
export interface ConsentReceiptBackupEntry {
  id: string;
  kind: string;
  /** The artefact verbatim: a base64 PDF or a signed token. Never parsed. */
  artefact: string;
  signedAt: string;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * Both keys are always present, and empty on a portable payload. An absent key
 * and an empty list read the same to a restore, but they read very differently
 * to a person opening the file, and the manifest entry beside them explains
 * which of the two they are looking at.
 */
export interface SensitiveBackupSection {
  mentalHealthAssessments: MentalHealthAssessmentBackupEntry[];
  consentReceipts: ConsentReceiptBackupEntry[];
}

export interface SensitiveBackupCounts {
  mentalHealthAssessments: number;
  consentReceipts: number;
}

/** What the file says about itself, merged into the payload manifest. */
export interface SensitiveBackupManifest {
  mentalHealth: {
    included: "full" | "omitted";
    note: string;
  };
  consent: {
    included: "full" | "omitted";
    note: string;
  };
}

const MENTAL_HEALTH_OMITTED_NOTE =
  "Completed WHO-5, PHQ and GAD administrations are not included in this " +
  "export. Their per-item answers are stored encrypted and include the " +
  "PHQ-9 self-harm item, which is not written into a portable file. They are " +
  "included in a disaster-recovery backup, which returns to the instance " +
  "that can read them.";

const MENTAL_HEALTH_INCLUDED_NOTE =
  "Completed screener administrations are included with their encrypted " +
  "per-item answers, for restore onto the instance that holds the key.";

const CONSENT_OMITTED_NOTE =
  "Consent receipts are not included in this export. A consent is given to " +
  "one operator, and a receipt restored elsewhere would assert an agreement " +
  "that operator never obtained. They are included in a disaster-recovery " +
  "backup, which returns to the same instance.";

const CONSENT_INCLUDED_NOTE =
  "Consent receipts are included, for restore onto the instance the consent " +
  "was given to.";

const MENTAL_HEALTH_BACKUP_SELECT = {
  id: true,
  instrument: true,
  locale: true,
  wording: true,
  version: true,
  responsesEncrypted: true,
  totalScore: true,
  severityBand: true,
  item9Flagged: true,
  crisisShownAt: true,
  takenAt: true,
  tz: true,
  source: true,
  externalId: true,
  syncVersion: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MentalHealthAssessmentSelect;

const CONSENT_RECEIPT_BACKUP_SELECT = {
  id: true,
  kind: true,
  artefact: true,
  signedAt: true,
  revokedAt: true,
  createdAt: true,
} satisfies Prisma.ConsentReceiptSelect;

export async function buildSensitiveBackupSection(
  prisma: Pick<PrismaClient, "mentalHealthAssessment" | "consentReceipt">,
  userId: string,
  options: SensitiveBackupOptions = {},
): Promise<SensitiveBackupSection & { manifest: SensitiveBackupManifest }> {
  const disasterRecovery = options.purpose === "disaster-recovery";

  if (!disasterRecovery) {
    return {
      mentalHealthAssessments: [],
      consentReceipts: [],
      manifest: {
        mentalHealth: {
          included: "omitted",
          note: MENTAL_HEALTH_OMITTED_NOTE,
        },
        consent: { included: "omitted", note: CONSENT_OMITTED_NOTE },
      },
    };
  }

  const [assessmentRows, receiptRows] = await Promise.all([
    prisma.mentalHealthAssessment.findMany({
      where: { userId },
      orderBy: [{ takenAt: "asc" }, { id: "asc" }],
      select: MENTAL_HEALTH_BACKUP_SELECT,
    }),
    prisma.consentReceipt.findMany({
      where: { userId },
      orderBy: [{ signedAt: "asc" }, { id: "asc" }],
      select: CONSENT_RECEIPT_BACKUP_SELECT,
    }),
  ]);

  return {
    mentalHealthAssessments: assessmentRows.map((row) => ({
      id: row.id,
      instrument: row.instrument,
      locale: row.locale,
      // The app writes only the closed set; anything else travels as null
      // ("not recorded") rather than as a value the restore would refuse.
      wording: isAssessmentWording(row.wording) ? row.wording : null,
      version: row.version,
      responsesEncrypted: Buffer.from(row.responsesEncrypted).toString(
        "base64",
      ),
      totalScore: row.totalScore,
      severityBand: row.severityBand,
      item9Flagged: row.item9Flagged,
      crisisShownAt: row.crisisShownAt?.toISOString() ?? null,
      takenAt: row.takenAt.toISOString(),
      tz: row.tz,
      source: row.source,
      externalId: row.externalId,
      syncVersion: row.syncVersion,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    consentReceipts: receiptRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      artefact: row.artefact,
      signedAt: row.signedAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    manifest: {
      mentalHealth: { included: "full", note: MENTAL_HEALTH_INCLUDED_NOTE },
      consent: { included: "full", note: CONSENT_INCLUDED_NOTE },
    },
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countSensitiveBackupSection(
  section: SensitiveBackupSection,
): SensitiveBackupCounts {
  return {
    mentalHealthAssessments: section.mentalHealthAssessments.length,
    consentReceipts: section.consentReceipts.length,
  };
}

/** Counts the sensitive restore wiped, for the audit trail. */
export interface SensitiveRestoreCleared {
  mentalHealthAssessments: number;
  consentReceipts: number;
}

type OptionalSensitive<T> = { [K in keyof T]?: T[K] | undefined };

export type RestoredMentalHealthAssessment = Pick<
  MentalHealthAssessmentBackupEntry,
  | "id"
  | "instrument"
  | "locale"
  | "responsesEncrypted"
  | "totalScore"
  | "severityBand"
  | "takenAt"
  | "createdAt"
  | "updatedAt"
> &
  OptionalSensitive<
    Pick<
      MentalHealthAssessmentBackupEntry,
      | "version"
      | "wording"
      | "item9Flagged"
      | "crisisShownAt"
      | "tz"
      | "source"
      | "externalId"
      | "syncVersion"
      | "deletedAt"
    >
  >;

export type RestoredConsentReceipt = Pick<
  ConsentReceiptBackupEntry,
  "id" | "kind" | "artefact" | "signedAt"
> &
  OptionalSensitive<Pick<ConsentReceiptBackupEntry, "revokedAt" | "createdAt">>;

export interface SensitiveRestoreInput {
  mentalHealthAssessments: RestoredMentalHealthAssessment[];
  consentReceipts: RestoredConsentReceipt[];
}

/**
 * Re-create the screener history and the consent record.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. Neither model references anything but the account, so this can run
 * anywhere in the sequence.
 *
 * `item9Flagged` is restored from the file rather than recomputed from the
 * decrypted answers. Recomputing would mean decrypting every administration
 * during a restore, which is exactly the handling this data is kept away from,
 * and the stored flag is what the history view has been reading all along.
 */
export async function restoreSensitiveData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: SensitiveRestoreInput,
): Promise<SensitiveRestoreCleared> {
  const [clearedAssessments, clearedReceipts] = await Promise.all([
    tx.mentalHealthAssessment.deleteMany({ where: { userId: ownerId } }),
    tx.consentReceipt.deleteMany({ where: { userId: ownerId } }),
  ]);

  if (payload.mentalHealthAssessments.length > 0) {
    await tx.mentalHealthAssessment.createMany({
      data: payload.mentalHealthAssessments.map((entry) => ({
        id: entry.id,
        userId: ownerId,
        instrument: entry.instrument,
        locale: entry.locale,
        wording: entry.wording ?? null,
        version: entry.version ?? "standard",
        responsesEncrypted: decodeBase64(entry.responsesEncrypted),
        totalScore: entry.totalScore,
        severityBand: entry.severityBand,
        item9Flagged: entry.item9Flagged ?? false,
        crisisShownAt: entry.crisisShownAt
          ? new Date(entry.crisisShownAt)
          : null,
        takenAt: new Date(entry.takenAt),
        tz: entry.tz ?? null,
        source: entry.source ?? "WEB",
        externalId: entry.externalId ?? null,
        syncVersion: entry.syncVersion ?? 0,
        deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
        createdAt: new Date(entry.createdAt),
        updatedAt: new Date(entry.updatedAt),
      })),
    });
  }

  if (payload.consentReceipts.length > 0) {
    await tx.consentReceipt.createMany({
      data: payload.consentReceipts.map((entry) => ({
        id: entry.id,
        userId: ownerId,
        kind: entry.kind,
        artefact: entry.artefact,
        signedAt: new Date(entry.signedAt),
        revokedAt: entry.revokedAt ? new Date(entry.revokedAt) : null,
        ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
      })),
    });
  }

  return {
    mentalHealthAssessments: clearedAssessments.count,
    consentReceipts: clearedReceipts.count,
  };
}

function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}
