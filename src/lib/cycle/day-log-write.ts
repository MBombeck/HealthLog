/**
 * Cycle day-log write helper — the shared upsert behind the single POST,
 * the PATCH, and the bulk drain (ios-contract §2.A / §2.B).
 *
 * UPSERT key: `(userId, source, externalId)` when `externalId` is present
 * (the NULL-distinct cross-device dedup key, like MoodEntry), else the
 * canonical `(userId, date)` key. `note` → `notesEncrypted` (AES-256-GCM).
 *
 * Sensitive-category encryption: when the resolved profile flag is ON the
 * five intent-revealing fields (sexualActivity, protectedSex,
 * pregnancyTest, progesteroneTest, contraceptive) are encrypted into the
 * single `sensitiveEncrypted` JSON envelope and the plaintext columns are
 * NULLed — they then drop out of the rollup / correlation tier (the trade
 * for at-rest secrecy). When OFF the plaintext columns are written as
 * before and the envelope is NULL.
 *
 * Partial merge: a re-post that omits a field never nulls a previously
 * stored value — the UPDATE branch only overwrites the fields actually
 * present in the input.
 *
 * Collision-safe: on a `(userId, source, externalId)`-keyed create that
 * collides with an existing canonical `(userId, date)` row (Prisma P2002),
 * the existing row is adopted and UPDATEd in place — one canonical row per
 * date regardless of provenance.
 *
 * Returns the upserted row id + whether a row already existed (so the
 * caller can map `inserted`/`updated`/`duplicate`) plus whether any field
 * actually changed on a re-post (drives the bulk `updated` vs `duplicate`
 * distinction).
 */
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { getOrCreateCycleProfile } from "@/lib/cycle/profile";
import { ensureCycleForBleedingDay } from "@/lib/cycle/cycle-boundaries";
import type { CycleDayLogInput } from "@/lib/validations/cycle";
import type {
  CervicalMucus,
  CervixFirmness,
  CervixOpening,
  CervixPosition,
  ContraceptiveKind,
  FlowLevel,
  HomeTestResult,
  OvulationTest,
  Prisma,
} from "@/generated/prisma/client";

/**
 * A day-log as the write helper takes it. The client surfaces parse
 * `CycleDayLogInput`, whose `source` is the closed client set (manual or
 * Apple Health); the Health Connect export import is server-side and writes
 * its own provenance, which no client may claim.
 */
export type CycleDayLogWriteEntry = Omit<CycleDayLogInput, "source"> & {
  source: CycleDayLogInput["source"] | "HEALTH_CONNECT";
};

export interface DayLogWriteResult {
  id: string;
  existed: boolean;
  /** A pre-existing row whose persisted fields differ from the re-post. */
  changed: boolean;
}

/** The five intent-revealing fields the encryption envelope carries. */
interface SensitiveFields {
  sexualActivity: boolean;
  protectedSex: boolean | null;
  pregnancyTest: HomeTestResult | null;
  progesteroneTest: HomeTestResult | null;
  contraceptive: ContraceptiveKind | null;
}

/** A symptom selection carrying its catalog key + optional 1-4 severity. */
export interface SymptomSelection {
  key: string;
  severity?: number | null;
}

/**
 * Resolve catalog symptom keys → `{ key, id }`, dropping unknown keys
 * silently. Returns the pairs (not bare ids) so the caller can carry the
 * per-link severity through to the join write.
 */
export async function resolveSymptomIds(
  userId: string,
  keys: readonly string[],
): Promise<{ key: string; id: string }[]> {
  if (keys.length === 0) return [];
  const unique = Array.from(new Set(keys));
  // Catalog rows (userId null) plus this user's own custom symptoms.
  const rows = await prisma.cycleSymptom.findMany({
    where: {
      key: { in: unique },
      isActive: true,
      OR: [{ userId: null }, { userId }],
    },
    select: { id: true, key: true },
  });
  return rows.map((r) => ({ key: r.key, id: r.id }));
}

/**
 * Replace the symptom-link set for a day-log. Shared by the upsert helper
 * and the PATCH route so both resolve + write the join identically. Each
 * selection's optional 1-4 severity is persisted on the link (NULL = a
 * plain presence link).
 */
export async function replaceSymptomLinks(
  userId: string,
  dayLogId: string,
  selections: readonly SymptomSelection[],
): Promise<void> {
  const resolved = await resolveSymptomIds(
    userId,
    selections.map((s) => s.key),
  );
  // Map each resolved id back to its requested severity by key.
  const severityByKey = new Map(
    selections.map((s) => [
      s.key,
      typeof s.severity === "number" ? s.severity : null,
    ]),
  );
  await prisma.cycleSymptomLink.deleteMany({ where: { dayLogId } });
  if (resolved.length > 0) {
    await prisma.cycleSymptomLink.createMany({
      data: resolved.map(({ key, id }) => ({
        dayLogId,
        symptomId: id,
        severity: severityByKey.get(key) ?? null,
      })),
      skipDuplicates: true,
    });
  }
}

/**
 * Decrypt the sensitive envelope fail-soft. Returns `{ ok: true, values }` on a
 * clean decrypt, `{ ok: false }` when an envelope is present but undecryptable
 * (rotation gap, GCM corruption). The caller MUST treat `ok: false` as
 * "do not re-write this column" — never as "the field is empty".
 */
function decryptSensitive(
  envelope: string,
): { ok: true; values: Partial<SensitiveFields> } | { ok: false } {
  try {
    return {
      ok: true,
      values: JSON.parse(decrypt(envelope)) as Partial<SensitiveFields>,
    };
  } catch {
    return { ok: false };
  }
}

/** Decrypt a note fail-soft (null on missing / undecryptable). */
function decryptNoteSoft(notesEncrypted: string | null): string | null {
  if (!notesEncrypted) return null;
  try {
    return decrypt(notesEncrypted);
  } catch {
    return null;
  }
}

type ExistingRow = {
  id: string;
  date: string;
  flow: FlowLevel | null;
  intermenstrualBleeding: boolean;
  basalBodyTempC: number | null;
  temperatureExcluded: boolean;
  ovulationTest: OvulationTest | null;
  cervicalMucus: CervicalMucus | null;
  cervixPosition: CervixPosition | null;
  cervixFirmness: CervixFirmness | null;
  cervixOpening: CervixOpening | null;
  sexualActivity: boolean;
  protectedSex: boolean | null;
  pregnancyTest: HomeTestResult | null;
  progesteroneTest: HomeTestResult | null;
  contraceptive: ContraceptiveKind | null;
  sensitiveEncrypted: string | null;
  notesEncrypted: string | null;
  deletedAt: Date | null;
};

const EXISTING_SELECT = {
  id: true,
  date: true,
  flow: true,
  intermenstrualBleeding: true,
  basalBodyTempC: true,
  temperatureExcluded: true,
  ovulationTest: true,
  cervicalMucus: true,
  cervixPosition: true,
  cervixFirmness: true,
  cervixOpening: true,
  sexualActivity: true,
  protectedSex: true,
  pregnancyTest: true,
  progesteroneTest: true,
  contraceptive: true,
  sensitiveEncrypted: true,
  notesEncrypted: true,
  deletedAt: true,
} as const;

/**
 * Upsert one cycle day-log. `tz` anchors the date string. When
 * `cycleId` is supplied the row is attributed to that cycle span.
 *
 * `encryptSensitiveFlag` lets a batch caller (bulk drain / Apple-Health import
 * flush) resolve the invariant `sensitiveCategoryEncryption` flag ONCE and
 * thread it in, instead of this helper re-reading the profile per row (a
 * per-day round-trip on a multi-year import — QA M-3). The single POST/PATCH
 * paths omit it and keep the lazy read.
 */
export async function upsertCycleDayLog(
  userId: string,
  entry: CycleDayLogWriteEntry,
  tz: string | null,
  cycleId: string | null = null,
  encryptSensitiveFlag?: boolean,
): Promise<DayLogWriteResult> {
  const source = entry.source;

  // Resolve the sensitive-category encryption flag once per write (or reuse the
  // flag the batch caller already resolved).
  const encryptSensitive =
    encryptSensitiveFlag ??
    (await getOrCreateCycleProfile(userId)).sensitiveCategoryEncryption;

  const where: Prisma.CycleDayLogWhereUniqueInput = entry.externalId
    ? {
        userId_source_externalId: {
          userId,
          source,
          externalId: entry.externalId,
        },
      }
    : { userId_date: { userId, date: entry.date } };

  // Probe so the caller can distinguish inserted / updated / duplicate
  // and (for an externalId re-post) detect whether a field changed.
  const existing = (await prisma.cycleDayLog.findUnique({
    where,
    select: EXISTING_SELECT,
  })) as ExistingRow | null;

  const result = await writeDayLog({
    userId,
    entry,
    tz,
    cycleId,
    source,
    where,
    existing,
    encryptSensitive,
  });

  return result;
}

interface WriteArgs {
  userId: string;
  entry: CycleDayLogWriteEntry;
  tz: string | null;
  cycleId: string | null;
  source: CycleDayLogWriteEntry["source"];
  where: Prisma.CycleDayLogWhereUniqueInput;
  existing: ExistingRow | null;
  encryptSensitive: boolean;
}

async function writeDayLog(args: WriteArgs): Promise<DayLogWriteResult> {
  const {
    userId,
    entry,
    tz,
    cycleId,
    source,
    where,
    existing,
    encryptSensitive,
  } = args;

  // Decrypt the existing note (fail-soft) for the change/duplicate split —
  // re-encrypting the same plaintext yields a different ciphertext (random
  // GCM IV), so a ciphertext compare would always read "changed". This is a
  // DISPLAY-ONLY read (a `null` here only affects the change flag, never the
  // written column — see the note-write below), so soft-decrypt is safe.
  const existingNote = decryptNoteSoft(existing?.notesEncrypted ?? null);

  // The resolved plaintext sensitive values for THIS write, after partial
  // merge against what's already stored (decrypted from the envelope when
  // the stored row was encrypted). `storedDecryptable` is false when the
  // existing envelope could not be decrypted — in that case the merged
  // values are DEFAULTS, not the real stored data, so they must never be
  // re-encrypted back over the column (that would wipe the envelope).
  const merged = existing
    ? mergeStoredSensitive(existing)
    : {
        values: {
          sexualActivity: false,
          protectedSex: null,
          pregnancyTest: null,
          progesteroneTest: null,
          contraceptive: null,
        },
        decryptable: true,
      };
  const storedSensitive: SensitiveFields = merged.values;
  const storedSensitiveDecryptable = merged.decryptable;

  const resolvedSensitive: SensitiveFields = {
    sexualActivity:
      entry.sexualActivity !== undefined
        ? entry.sexualActivity
        : storedSensitive.sexualActivity,
    protectedSex:
      entry.protectedSex !== undefined
        ? (entry.protectedSex ?? null)
        : storedSensitive.protectedSex,
    pregnancyTest:
      entry.pregnancyTest !== undefined
        ? (entry.pregnancyTest ?? null)
        : storedSensitive.pregnancyTest,
    progesteroneTest:
      entry.progesteroneTest !== undefined
        ? (entry.progesteroneTest ?? null)
        : storedSensitive.progesteroneTest,
    contraceptive:
      entry.contraceptive !== undefined
        ? (entry.contraceptive ?? null)
        : storedSensitive.contraceptive,
  };

  // Note resolution with partial merge. When `note` is supplied, encrypt it
  // (an explicit empty/null clears the column). When `note` is OMITTED, the
  // existing ciphertext is preserved VERBATIM — never decrypt→re-encrypt, and
  // never collapse an undecryptable existing value to null. A soft-decrypt that
  // returns null on an undecryptable column (rotation gap, GCM corruption) must
  // not be allowed to permanently wipe the stored note when an unrelated field
  // is the only thing being edited (mirrors the v1.18.1 53-column rotation fix:
  // a write path never re-writes an `*Encrypted` column from a soft-decrypt
  // result).
  const notesEncrypted: string | null =
    entry.note !== undefined
      ? entry.note
        ? encrypt(entry.note)
        : null
      : (existing?.notesEncrypted ?? null);

  // Note change detection for the `changed`/`duplicate` split. An omitted
  // `note` preserves the column verbatim, so it can never count as a change.
  // A supplied `note` is compared against the soft-decrypted existing value
  // (display-only) — a ciphertext compare would always read "changed" (random
  // GCM IV).
  const incomingNote = entry.note !== undefined ? (entry.note ?? null) : null;
  const noteChanged = entry.note !== undefined && incomingNote !== existingNote;

  // Non-sensitive fields, partial-merged against the stored row.
  const flow =
    entry.flow !== undefined ? (entry.flow ?? null) : (existing?.flow ?? null);
  const intermenstrualBleeding =
    entry.intermenstrualBleeding !== undefined
      ? entry.intermenstrualBleeding
      : (existing?.intermenstrualBleeding ?? false);
  const basalBodyTempC =
    entry.basalBodyTempC !== undefined
      ? (entry.basalBodyTempC ?? null)
      : (existing?.basalBodyTempC ?? null);
  const temperatureExcluded =
    entry.temperatureExcluded !== undefined
      ? entry.temperatureExcluded
      : (existing?.temperatureExcluded ?? false);
  const ovulationTest =
    entry.ovulationTest !== undefined
      ? (entry.ovulationTest ?? null)
      : (existing?.ovulationTest ?? null);
  const cervicalMucus =
    entry.cervicalMucus !== undefined
      ? (entry.cervicalMucus ?? null)
      : (existing?.cervicalMucus ?? null);
  const cervixPosition =
    entry.cervixPosition !== undefined
      ? (entry.cervixPosition ?? null)
      : (existing?.cervixPosition ?? null);
  const cervixFirmness =
    entry.cervixFirmness !== undefined
      ? (entry.cervixFirmness ?? null)
      : (existing?.cervixFirmness ?? null);
  const cervixOpening =
    entry.cervixOpening !== undefined
      ? (entry.cervixOpening ?? null)
      : (existing?.cervixOpening ?? null);

  // A first bleeding day opens the cycle it belongs to. Cycle rows used to
  // come only from the one-tap period boundary, so a person who logged every
  // period as flow had a module that held none had ever happened — no lengths,
  // no forecast, an empty chart. This is the one shared seam behind the single
  // capture, the bulk drain, the Apple Health fold and the boundary itself, so
  // all four infer a start the same way (the boundary's own write lands on a
  // date that already has a cycle, which the detector declines). The day is
  // then attributed to the cycle it just opened rather than the one before it.
  const openedCycleId = await ensureCycleForBleedingDay(
    userId,
    entry.date,
    tz,
    {
      flow,
      intermenstrualBleeding,
    },
  );
  const attributedCycleId = openedCycleId ?? cycleId;

  // Was any of the five sensitive fields actually supplied in THIS update?
  // Used to decide whether an undecryptable existing envelope may be preserved
  // verbatim (an unrelated-field edit) or must be rewritten (the user is
  // explicitly setting sensitive data).
  const sensitiveFieldSupplied =
    entry.sexualActivity !== undefined ||
    entry.protectedSex !== undefined ||
    entry.pregnancyTest !== undefined ||
    entry.progesteroneTest !== undefined ||
    entry.contraceptive !== undefined;

  // Split the sensitive fields between plaintext columns and the envelope
  // depending on the flag. When encrypting, the plaintext columns are NULL
  // (drop out of rollup/correlation) and the envelope carries the JSON.
  //
  // Data-loss guard: when the stored envelope could NOT be decrypted, the
  // merged `resolvedSensitive` carries DEFAULTS, not the real stored values.
  // Re-encrypting them over the column would permanently wipe the user's
  // sensitive data on an edit of an unrelated field. So when encrypting, the
  // existing envelope is undecryptable, and no sensitive field is supplied in
  // this update, preserve the existing ciphertext VERBATIM (mirrors the
  // v1.18.1 53-column rotation fix). An explicit sensitive-field write still
  // re-encrypts the user's intent.
  const preserveExistingEnvelope =
    encryptSensitive && !storedSensitiveDecryptable && !sensitiveFieldSupplied;
  const sensitiveEncrypted = encryptSensitive
    ? preserveExistingEnvelope
      ? (existing?.sensitiveEncrypted ?? null)
      : encrypt(JSON.stringify(resolvedSensitive))
    : null;
  const sensitivePlaintext = encryptSensitive
    ? {
        sexualActivity: false,
        protectedSex: null,
        pregnancyTest: null,
        progesteroneTest: null,
        contraceptive: null,
      }
    : { ...resolvedSensitive };

  const baseData: Prisma.CycleDayLogUncheckedUpdateInput = {
    flow,
    intermenstrualBleeding,
    basalBodyTempC,
    temperatureExcluded,
    ovulationTest,
    cervicalMucus,
    cervixPosition,
    cervixFirmness,
    cervixOpening,
    sexualActivity: sensitivePlaintext.sexualActivity,
    protectedSex: sensitivePlaintext.protectedSex,
    pregnancyTest: sensitivePlaintext.pregnancyTest,
    progesteroneTest: sensitivePlaintext.progesteroneTest,
    contraceptive: sensitivePlaintext.contraceptive,
    sensitiveEncrypted,
    notesEncrypted,
  };

  // Did anything actually change vs the stored row? Compare the resolved
  // PLAINTEXT values (note + sensitive), never ciphertext.
  let changed = !existing;
  if (existing) {
    changed =
      (existing.flow ?? null) !== flow ||
      existing.intermenstrualBleeding !== intermenstrualBleeding ||
      (existing.basalBodyTempC ?? null) !== basalBodyTempC ||
      existing.temperatureExcluded !== temperatureExcluded ||
      (existing.ovulationTest ?? null) !== ovulationTest ||
      (existing.cervicalMucus ?? null) !== cervicalMucus ||
      (existing.cervixPosition ?? null) !== cervixPosition ||
      (existing.cervixFirmness ?? null) !== cervixFirmness ||
      (existing.cervixOpening ?? null) !== cervixOpening ||
      // When the stored envelope was undecryptable and we preserve it
      // verbatim (no sensitive field supplied), the sensitive values cannot
      // be compared meaningfully — skip them. An explicit sensitive write
      // compares the resolved values against the (default) stored ones.
      (!preserveExistingEnvelope &&
        (storedSensitive.sexualActivity !== resolvedSensitive.sexualActivity ||
          storedSensitive.protectedSex !== resolvedSensitive.protectedSex ||
          storedSensitive.pregnancyTest !== resolvedSensitive.pregnancyTest ||
          storedSensitive.progesteroneTest !==
            resolvedSensitive.progesteroneTest ||
          storedSensitive.contraceptive !== resolvedSensitive.contraceptive)) ||
      noteChanged ||
      existing.deletedAt !== null ||
      (Boolean(entry.externalId) && existing.date !== entry.date);
  }

  const updateData: Prisma.CycleDayLogUncheckedUpdateInput = {
    ...baseData,
    ...(entry.externalId ? { date: entry.date } : {}),
    ...(attributedCycleId !== null ? { cycleId: attributedCycleId } : {}),
    deletedAt: null,
    // Only bump syncVersion when a field actually changed — an unchanged
    // re-post must be a true no-op on the /api/sync/changes feed so other
    // devices don't re-pull an identical row.
    ...(changed ? { syncVersion: { increment: 1 } } : {}),
  };

  let rowId: string;
  let existed = existing !== null;
  try {
    const row = await prisma.cycleDayLog.upsert({
      where,
      create: {
        userId,
        date: entry.date,
        tz,
        source,
        externalId: entry.externalId ?? null,
        cycleId: attributedCycleId,
        flow,
        intermenstrualBleeding,
        basalBodyTempC,
        temperatureExcluded,
        ovulationTest,
        cervicalMucus,
        cervixPosition,
        cervixFirmness,
        cervixOpening,
        sexualActivity: sensitivePlaintext.sexualActivity,
        protectedSex: sensitivePlaintext.protectedSex,
        pregnancyTest: sensitivePlaintext.pregnancyTest,
        progesteroneTest: sensitivePlaintext.progesteroneTest,
        contraceptive: sensitivePlaintext.contraceptive,
        sensitiveEncrypted,
        notesEncrypted,
      },
      update: updateData,
      select: { id: true },
    });
    rowId = row.id;
  } catch (err: unknown) {
    // Dual-unique collision: an externalId-keyed create whose date already
    // has a canonical (userId, date) row. Adopt the existing row and UPDATE
    // it in place — one canonical row per date regardless of provenance.
    if (isUniqueViolation(err) && entry.externalId) {
      const canonical = await prisma.cycleDayLog.findUnique({
        where: { userId_date: { userId, date: entry.date } },
        select: { id: true },
      });
      if (!canonical) throw err;
      const adopted = await prisma.cycleDayLog.update({
        where: { id: canonical.id },
        data: {
          ...updateData,
          source,
          externalId: entry.externalId,
          ...(changed ? {} : { syncVersion: { increment: 1 } }),
        },
        select: { id: true },
      });
      rowId = adopted.id;
      existed = true;
      changed = true;
    } else {
      throw err;
    }
  }

  // Replace the symptom-link set when symptoms were supplied. Absent
  // `symptoms` leaves existing links untouched.
  if (entry.symptoms !== undefined) {
    await replaceSymptomLinks(userId, rowId, entry.symptoms);
  }

  return { id: rowId, existed, changed };
}

/** Prisma P2002 (unique constraint) detector without importing the runtime. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Resolve the stored plaintext sensitive fields (envelope OR columns).
 * `decryptable` is false ONLY when an envelope is present but could not be
 * decrypted — the returned `values` are then DEFAULTS and the caller must not
 * re-encrypt them back over the column.
 */
function mergeStoredSensitive(existing: ExistingRow): {
  values: SensitiveFields;
  decryptable: boolean;
} {
  if (existing.sensitiveEncrypted) {
    const dec = decryptSensitive(existing.sensitiveEncrypted);
    if (!dec.ok) {
      return {
        values: {
          sexualActivity: false,
          protectedSex: null,
          pregnancyTest: null,
          progesteroneTest: null,
          contraceptive: null,
        },
        decryptable: false,
      };
    }
    return {
      values: {
        sexualActivity: dec.values.sexualActivity ?? false,
        protectedSex: dec.values.protectedSex ?? null,
        pregnancyTest: dec.values.pregnancyTest ?? null,
        progesteroneTest: dec.values.progesteroneTest ?? null,
        contraceptive: dec.values.contraceptive ?? null,
      },
      decryptable: true,
    };
  }
  return {
    values: {
      sexualActivity: existing.sexualActivity,
      protectedSex: existing.protectedSex,
      pregnancyTest: existing.pregnancyTest,
      progesteroneTest: existing.progesteroneTest,
      contraceptive: existing.contraceptive,
    },
    decryptable: true,
  };
}
