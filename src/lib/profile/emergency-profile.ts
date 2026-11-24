/**
 * Emergency ("Notfalldaten") profile persistence.
 *
 * Reads and writes the six emergency columns on the single `UserHealthProfile`
 * row, one per user. The three enum columns are plaintext closed sets; the
 * three free-text columns are AES-256-GCM at rest via the shared Bytes codec.
 *
 * Read is fail-soft per encrypted field — a key-rotation gap on one column
 * reads as "unreadable" rather than failing the whole surface, the same stance
 * the anamnesis conditions and the visit free text take. Write encrypts on the
 * way in and never persists plaintext.
 */
import { prisma } from "@/lib/db";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";
import type {
  EmergencyProfileDto,
  EmergencyProfileUpdate,
} from "@/lib/validations/emergency-profile";
import { enqueueWalletRefresh } from "@/lib/emergency-card/wallet-pass/queues";

interface EmergencyProfileRow {
  emergencyBloodType: EmergencyProfileDto["bloodType"] | null;
  organDonorStatus: EmergencyProfileDto["organDonor"] | null;
  advanceDirectiveStatus: EmergencyProfileDto["advanceDirective"] | null;
  emergencyContactsEncrypted: Uint8Array | null;
  emergencyImplantsEncrypted: Uint8Array | null;
  emergencyNoteEncrypted: Uint8Array | null;
}

/**
 * The column-shaped patch. Only present keys are written; every key can be
 * `null` to clear its column. A plain object rather than a Prisma input type so
 * it spreads cleanly into both `create` and `update` (Prisma's update input
 * wraps scalars in a field-operations union that a create input would reject).
 */
interface EmergencyDataPatch {
  emergencyBloodType?: EmergencyProfileDto["bloodType"] | null;
  organDonorStatus?: EmergencyProfileDto["organDonor"] | null;
  advanceDirectiveStatus?: EmergencyProfileDto["advanceDirective"] | null;
  emergencyContactsEncrypted?: Uint8Array<ArrayBuffer> | null;
  emergencyImplantsEncrypted?: Uint8Array<ArrayBuffer> | null;
  emergencyNoteEncrypted?: Uint8Array<ArrayBuffer> | null;
}

/** Decrypt one free-text emergency column, fail-soft. */
function decryptField(
  buf: Uint8Array | null,
  field: string,
  userId: string,
): { value: string | null; unreadable: boolean } {
  if (!buf || buf.byteLength === 0) return { value: null, unreadable: false };
  try {
    const text = decryptFromBytes(buf).trim();
    return { value: text.length > 0 ? text : null, unreadable: false };
  } catch (error) {
    getEvent()?.addWarning(
      `emergency profile ${field} decrypt failed for ${userId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { value: null, unreadable: true };
  }
}

/** Project a profile row (or its absence) into the read DTO. */
export function toEmergencyProfileDto(
  row: EmergencyProfileRow | null,
  userId: string,
): EmergencyProfileDto {
  const contacts = decryptField(
    row?.emergencyContactsEncrypted ?? null,
    "contacts",
    userId,
  );
  const implants = decryptField(
    row?.emergencyImplantsEncrypted ?? null,
    "implants",
    userId,
  );
  const note = decryptField(
    row?.emergencyNoteEncrypted ?? null,
    "note",
    userId,
  );
  return {
    bloodType: row?.emergencyBloodType ?? null,
    organDonor: row?.organDonorStatus ?? null,
    advanceDirective: row?.advanceDirectiveStatus ?? null,
    contacts: contacts.value,
    contactsUnreadable: contacts.unreadable,
    implants: implants.value,
    implantsUnreadable: implants.unreadable,
    note: note.value,
    noteUnreadable: note.unreadable,
  };
}

/**
 * Whether an emergency DTO carries anything worth surfacing. An enum resting at
 * `UNKNOWN` is the explicit "not stated" answer and does not, on its own, earn a
 * page; a real enum answer or any free text (present or unreadable) does. This
 * is the presence half of the doctor-report page gate.
 */
export function emergencyProfileHasContent(dto: EmergencyProfileDto): boolean {
  const enumSet =
    (dto.bloodType !== null && dto.bloodType !== "UNKNOWN") ||
    (dto.organDonor !== null && dto.organDonor !== "UNKNOWN") ||
    (dto.advanceDirective !== null && dto.advanceDirective !== "UNKNOWN");
  const textSet =
    dto.contacts !== null ||
    dto.contactsUnreadable ||
    dto.implants !== null ||
    dto.implantsUnreadable ||
    dto.note !== null ||
    dto.noteUnreadable;
  return enumSet || textSet;
}

const EMERGENCY_SELECT = {
  emergencyBloodType: true,
  organDonorStatus: true,
  advanceDirectiveStatus: true,
  emergencyContactsEncrypted: true,
  emergencyImplantsEncrypted: true,
  emergencyNoteEncrypted: true,
} as const;

/** Read the caller's emergency profile as the form-prefill DTO. */
export async function readEmergencyProfile(
  userId: string,
): Promise<EmergencyProfileDto> {
  const row = await prisma.userHealthProfile.findUnique({
    where: { userId },
    select: EMERGENCY_SELECT,
  });
  // The emergency card reads this profile: a Wallet pass of it is rebuilt.
  await enqueueWalletRefresh(userId);
  return toEmergencyProfileDto(row, userId);
}

/**
 * Build the `data` patch field-by-field from the parsed body. Only keys the
 * body carried are written (an omitted key leaves the column untouched); an
 * explicit `null` clears it. No mass assignment — the parsed object is never
 * spread. Returns the encrypted-column shape both `create` and `update` accept.
 */
function buildEmergencyData(input: EmergencyProfileUpdate): EmergencyDataPatch {
  const data: EmergencyDataPatch = {};
  if (input.bloodType !== undefined) data.emergencyBloodType = input.bloodType;
  if (input.organDonor !== undefined) data.organDonorStatus = input.organDonor;
  if (input.advanceDirective !== undefined) {
    data.advanceDirectiveStatus = input.advanceDirective;
  }
  if (input.contacts !== undefined) {
    data.emergencyContactsEncrypted =
      input.contacts === null ? null : encryptToBytes(input.contacts);
  }
  if (input.implants !== undefined) {
    data.emergencyImplantsEncrypted =
      input.implants === null ? null : encryptToBytes(input.implants);
  }
  if (input.note !== undefined) {
    data.emergencyNoteEncrypted =
      input.note === null ? null : encryptToBytes(input.note);
  }
  return data;
}

/**
 * Apply an emergency-profile patch and return the fresh DTO.
 *
 * Upserts the single profile row: an account that has never opened its profile
 * has no row yet, so the first save creates it. The `userId` is the caller's,
 * narrowed upstream from `requireAuth()` — it is never read from the body.
 */
export async function writeEmergencyProfile(
  userId: string,
  input: EmergencyProfileUpdate,
): Promise<EmergencyProfileDto> {
  const data = buildEmergencyData(input);
  const row = await prisma.userHealthProfile.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
    select: EMERGENCY_SELECT,
  });
  return toEmergencyProfileDto(row, userId);
}
