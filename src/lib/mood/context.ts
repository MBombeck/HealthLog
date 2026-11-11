/**
 * The one place a mood entry's day context crosses between the wire and the
 * `mood_contexts` row.
 *
 * Three call sites need this — the create route, the edit route and the bulk
 * route — plus the backup builder and the restore. Left to themselves they
 * would each build their own `data` object, and one of them would eventually
 * forget a column: exactly how the level-A values shipped twice under two
 * spellings before `shapeLevelA` existed. So the mapping lives here, once, in
 * both directions.
 *
 * Everything is built field by field from the parsed body. Nothing is spread
 * from a request (no mass assignment), and the two multi-select
 * lists go through the vocabulary module's encoder rather than a local
 * `JSON.stringify`.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { encryptNote, readNote } from "@/lib/crypto/note-cipher";
import { decodeKeyList, encodeKeyList } from "@/lib/mood/context-vocabulary";

/** Either the plain client or a transaction client, as the tag-link helper takes. */
type MoodContextDb = PrismaClient | Prisma.TransactionClient;

/**
 * The context as a client sends it. Every field optional; a `null` is an
 * explicit "take this back", an absent key says nothing at all.
 */
export interface MoodContextInput {
  workStatus?: string | null;
  workMinutes?: number | null;
  overtimeMinutes?: number | null;
  workLoad?: number | null;
  workSatisfaction?: number | null;
  contactCircles?: string[] | null;
  contactForm?: string | null;
  contactExtent?: string | null;
  contactQuality?: number | null;
  contactSupport?: number | null;
  leisureCategories?: string[] | null;
  leisureMinutes?: number | null;
  leisureJoy?: number | null;
  leisureRecovery?: number | null;
  eventType?: string | null;
  eventValence?: number | null;
  eventAt?: Date | null;
  note?: string | null;
}

/** The context as it sits on a row, before the note is decrypted. */
export interface MoodContextRow {
  workStatus: string | null;
  workMinutes: number | null;
  overtimeMinutes: number | null;
  workLoad: number | null;
  workSatisfaction: number | null;
  contactCircles: string | null;
  contactForm: string | null;
  contactExtent: string | null;
  contactQuality: number | null;
  contactSupport: number | null;
  leisureCategories: string | null;
  leisureMinutes: number | null;
  leisureJoy: number | null;
  leisureRecovery: number | null;
  eventType: string | null;
  eventValence: number | null;
  eventAt: Date | null;
  notesEncrypted: Uint8Array | null;
}

/** The context as a client reads it back. Lists decoded, note decrypted. */
export interface MoodContextWire {
  workStatus: string | null;
  workMinutes: number | null;
  overtimeMinutes: number | null;
  workLoad: number | null;
  workSatisfaction: number | null;
  contactCircles: string[];
  contactForm: string | null;
  contactExtent: string | null;
  contactQuality: number | null;
  contactSupport: number | null;
  leisureCategories: string[];
  leisureMinutes: number | null;
  leisureJoy: number | null;
  leisureRecovery: number | null;
  eventType: string | null;
  eventValence: number | null;
  eventAt: string | null;
  note: string | null;
}

/**
 * Does this sub-object actually say anything?
 *
 * An entry whose context sections were all left closed must store **no row**.
 * A row of nothing but NULLs would record "asked and answered nothing" where
 * the truth is "never asked", and every count over the table would then be a
 * count of empty forms. An empty list counts as nothing, because a client that
 * renders a multi-select and sends back `[]` has said the same thing as one
 * that sent nothing at all.
 */
export function isEmptyContextInput(input: MoodContextInput): boolean {
  const values: Array<unknown> = [
    input.workStatus,
    input.workMinutes,
    input.overtimeMinutes,
    input.workLoad,
    input.workSatisfaction,
    input.contactForm,
    input.contactExtent,
    input.contactQuality,
    input.contactSupport,
    input.leisureMinutes,
    input.leisureJoy,
    input.leisureRecovery,
    input.eventType,
    input.eventValence,
    input.eventAt,
  ];
  if (values.some((v) => v !== undefined && v !== null)) return false;
  if (input.contactCircles && input.contactCircles.length > 0) return false;
  if (input.leisureCategories && input.leisureCategories.length > 0)
    return false;
  if (input.note !== undefined && input.note !== null && input.note !== "") {
    return false;
  }
  return true;
}

/**
 * The write payload for a context row, whole.
 *
 * Whole rather than per-field, and that is the contract: a context write
 * REPLACES the stored context. The capture surface always sends the sections
 * it is showing, so a field the payload omits is a field the person cleared,
 * and a preserve-when-absent rule here would make an emptied section
 * impossible to save. The entry's own columns work the other way round
 * (`levelAForWrite`) because those writers are upserts a phone re-posts
 * blind; this object is only ever built from a payload that carried a
 * `context` key at all.
 */
export function contextRowData(input: MoodContextInput) {
  return {
    workStatus: input.workStatus ?? null,
    workMinutes: input.workMinutes ?? null,
    overtimeMinutes: input.overtimeMinutes ?? null,
    workLoad: input.workLoad ?? null,
    workSatisfaction: input.workSatisfaction ?? null,
    contactCircles: encodeKeyList(input.contactCircles ?? null),
    contactForm: input.contactForm ?? null,
    contactExtent: input.contactExtent ?? null,
    contactQuality: input.contactQuality ?? null,
    contactSupport: input.contactSupport ?? null,
    leisureCategories: encodeKeyList(input.leisureCategories ?? null),
    leisureMinutes: input.leisureMinutes ?? null,
    leisureJoy: input.leisureJoy ?? null,
    leisureRecovery: input.leisureRecovery ?? null,
    eventType: input.eventType ?? null,
    eventValence: input.eventValence ?? null,
    eventAt: input.eventAt ?? null,
    notesEncrypted: encryptNote(input.note ?? null),
  };
}

/** A stored context row as the client reads it. */
export function contextForWire(row: MoodContextRow): MoodContextWire {
  return {
    workStatus: row.workStatus,
    workMinutes: row.workMinutes,
    overtimeMinutes: row.overtimeMinutes,
    workLoad: row.workLoad,
    workSatisfaction: row.workSatisfaction,
    contactCircles: decodeKeyList(row.contactCircles),
    contactForm: row.contactForm,
    contactExtent: row.contactExtent,
    contactQuality: row.contactQuality,
    contactSupport: row.contactSupport,
    leisureCategories: decodeKeyList(row.leisureCategories),
    leisureMinutes: row.leisureMinutes,
    leisureJoy: row.leisureJoy,
    leisureRecovery: row.leisureRecovery,
    eventType: row.eventType,
    eventValence: row.eventValence,
    eventAt: row.eventAt ? row.eventAt.toISOString() : null,
    // Fail-closed like every other note read: a present ciphertext under an
    // unknown key id throws rather than answering an empty note.
    note: readNote(row.notesEncrypted, null),
  };
}

/**
 * Write, replace or remove the context of one entry, inside the caller's
 * transaction.
 *
 * `undefined` means the request said nothing about the context and the stored
 * one is left alone. A context that says nothing removes the row, which is the
 * same rule the create path applies: no row rather than a row of NULLs.
 */
export async function persistMoodContext(
  tx: MoodContextDb,
  moodEntryId: string,
  userId: string,
  input: MoodContextInput | null | undefined,
): Promise<"written" | "removed" | "untouched"> {
  if (input === undefined) return "untouched";
  if (input === null || isEmptyContextInput(input)) {
    await tx.moodContext.deleteMany({ where: { moodEntryId } });
    return "removed";
  }
  const data = contextRowData(input);
  await tx.moodContext.upsert({
    where: { moodEntryId },
    create: { moodEntryId, userId, ...data },
    update: data,
  });
  return "written";
}
