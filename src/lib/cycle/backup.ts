/**
 * Cycle-tracking backup serialisation — the one place the full-backup
 * writers (the on-demand `GET /api/export/full-backup` route AND the
 * pg-boss `data-backup` worker) read the cycle tables, so the two writers
 * never drift. Mirrors the `backupPayloadSchema` cycle shapes.
 *
 * Reads are scoped to `userId` + `deletedAt: null` and exclude predicted
 * (forecast) cycle rows — only observed history round-trips.
 *
 * ## Free text follows the note contract
 *
 * Three columns are sealed: the day-log note, the sensitive-category envelope
 * and a custom symptom's label. A disaster-recovery file carries them as the
 * stored ciphertext, which the same instance's key reads back. A portable file
 * carries them readable (`note`, `sensitive`, `label`), and the restore seals
 * them under the receiving host's key, because a portable file exists to be
 * moved, and ciphertext from one host is noise on another.
 *
 * Until v1.40 the portable file carried the ciphertext too, so a note restored
 * onto a host with a different key was unreadable for good. Such a file is
 * still accepted: every ciphertext value in it is opened with this host's keys
 * before it is written, and one that does not open is kept out of the row and
 * named in the skip report (`cycleCiphertext`), never written back as
 * ciphertext nobody can read. The same check covers a disaster-recovery file,
 * which is why `RESTORE_SELF_VERIFIED_SECTIONS` lets these sections past the
 * restore's key preflight.
 */
import type {
  CervicalMucus,
  CervixFirmness,
  CervixOpening,
  CervixPosition,
  ContraceptiveKind,
  CycleTrackingGoal,
  FlowLevel,
  HomeTestResult,
  MeasurementSource,
  OvulationTest,
  Prisma,
  PrismaClient,
  SecondarySymptom,
} from "@/generated/prisma/client";
import {
  openSealedForExport,
  sealForRestore,
  UNOPENED,
} from "@/lib/export/sealed-text";
import { UNREADABLE_EXPORT_MARKER } from "@/lib/export/unreadable-marker";
import type { BackupPayload } from "@/lib/validations/backup";
import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

/** The cycle slice of a backup payload. */
export interface CycleBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

export interface CycleBackupSection {
  cycleProfile: {
    id?: string;
    goal: string;
    cycleTrackingEnabled: boolean | null;
    typicalCycleLength: number | null;
    typicalPeriodLength: number | null;
    lutealPhaseLength: number | null;
    secondarySymptom: string;
    predictionEnabled: boolean;
    rawChartMode: boolean;
    discreetNotifications: boolean;
    sensitiveCategoryEncryption: boolean;
    createdAt?: string;
    updatedAt?: string;
  } | null;
  cycles: Array<{
    id?: string;
    startDate: string;
    endDate: string | null;
    periodEndDate: string | null;
    lengthDays: number | null;
    ovulationDate: string | null;
    ovulationConfirmed: boolean;
    tz: string | null;
    isPredicted?: boolean;
    syncVersion?: number;
    deletedAt?: string | null;
    /**
     * Disaster recovery only: the start that folded this one in. A bare id with
     * no foreign key, meaningful only because the same file carries the ids of
     * the starts it names.
     */
    absorbedIntoId?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }>;
  cycleDayLogs: Array<{
    id?: string;
    cycleId?: string | null;
    date: string;
    flow: string | null;
    intermenstrualBleeding: boolean;
    basalBodyTempC: number | null;
    temperatureExcluded: boolean;
    ovulationTest: string | null;
    cervicalMucus: string | null;
    cervixPosition: string | null;
    cervixFirmness: string | null;
    cervixOpening: string | null;
    sexualActivity: boolean;
    protectedSex: boolean | null;
    pregnancyTest: string | null;
    progesteroneTest: string | null;
    contraceptive: string | null;
    /** Ciphertext; present on a disaster-recovery payload. */
    sensitiveEncrypted?: string | null;
    /** Ciphertext; present on a disaster-recovery payload. */
    notesEncrypted?: string | null;
    /** Plaintext; present on a portable payload. */
    note?: string | null;
    /**
     * The sensitive-category envelope opened; present on a portable payload.
     * The unreadable marker when this instance could not open it.
     */
    sensitive?: CycleSensitiveFields | string | null;
    source: string;
    externalId: string | null;
    tz: string | null;
    syncVersion?: number;
    deletedAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
    /**
     * Which symptoms the day carries. The single presence list — one entry per
     * link, nothing else decides whether a symptom was on the day.
     */
    symptomKeys: string[];
    /**
     * How hard each of those symptoms hit, where the person said so.
     *
     * `CycleSymptomLink.severity` is a 1-4 Likert the log-day sheet writes and
     * the day-log DTO reads back, and the backup carried only the keys — so a
     * day recorded as "cramps, and they were a 4" came back as "cramps" and the
     * 4 was gone. Nothing failed; the number was simply not in the file.
     *
     * Kept as a SPARSE annotation over `symptomKeys` rather than folded into
     * it, for two reasons. A release that only knows `symptomKeys` still reads
     * every symptom out of a file written here, instead of finding the key it
     * looks for replaced by one it does not know and restoring a day with no
     * symptoms at all. And presence stays decided in exactly one place, so the
     * two lists cannot disagree about which symptoms a day had.
     *
     * A link with no severity is simply not listed. No entry means the person
     * never rated it — which is not the same as rating it zero.
     */
    symptomSeverities: Array<{ key: string; severity: number }>;
  }>;
  /**
   * The account's OWN symptom definitions.
   *
   * The seeded catalogue is reference data every instance already has, but a
   * symptom the user created exists only here. Without it the restore looks up
   * a key that resolves to nothing and drops the link — the day-log comes back
   * with one of its symptoms quietly missing.
   */
  customSymptoms: Array<{
    id?: string;
    key: string;
    labelKey: string;
    categoryId: string;
    icon: string | null;
    sortOrder: number;
    isActive: boolean;
    /**
     * The user's own words for the symptom: ciphertext on a disaster-recovery
     * payload, plaintext (`label`) on a portable one.
     *
     * Declared rather than left to the spread, because an undeclared field is
     * a field the wire type says is not there.
     */
    labelEncrypted?: string | null;
    label?: string | null;
  }>;
}

/** The five intent fields the sensitive-category envelope holds. */
export interface CycleSensitiveFields {
  sexualActivity?: boolean;
  protectedSex?: boolean | null;
  pregnancyTest?: string | null;
  progesteroneTest?: string | null;
  contraceptive?: string | null;
}

/** The sensitive envelope opened for a portable file, or the marker. */
function openSensitiveForExport(
  sealed: string | null,
): CycleSensitiveFields | string | null {
  if (!sealed) return null;
  const opened = openSealedForExport(sealed, "cycle sensitive envelope");
  if (opened === UNREADABLE_EXPORT_MARKER) return opened;
  try {
    return JSON.parse(opened) as CycleSensitiveFields;
  } catch {
    return UNREADABLE_EXPORT_MARKER;
  }
}

/**
 * Build the cycle section of a user's full backup. Accepts any client with
 * the cycle delegates (the route's global client OR the worker's local
 * client) so both writers share one read.
 */
export async function buildCycleBackupSection(
  prisma: Pick<
    PrismaClient,
    "cycleProfile" | "menstrualCycle" | "cycleDayLog" | "cycleSymptom"
  >,
  userId: string,
  options: CycleBackupOptions = {},
): Promise<CycleBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const [profile, cycles, dayLogs, customSymptoms] = await Promise.all([
    prisma.cycleProfile.findUnique({ where: { userId } }),
    prisma.menstrualCycle.findMany({
      where: disasterRecovery
        ? { userId }
        : { userId, deletedAt: null, isPredicted: false },
      orderBy: { startDate: "asc" },
    }),
    prisma.cycleDayLog.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { date: "asc" },
      include: {
        symptomLinks: { include: { symptom: { select: { key: true } } } },
      },
    }),
    // `userId` set means the user made it. The NULL rows are the seeded
    // catalogue, which the restoring instance already has.
    prisma.cycleSymptom.findMany({
      where: { userId },
      orderBy: { key: "asc" },
    }),
  ]);

  return {
    cycleProfile: profile
      ? {
          ...(disasterRecovery
            ? {
                id: profile.id,
                createdAt: profile.createdAt.toISOString(),
                updatedAt: profile.updatedAt.toISOString(),
              }
            : {}),
          goal: profile.goal,
          cycleTrackingEnabled: profile.cycleTrackingEnabled,
          typicalCycleLength: profile.typicalCycleLength,
          typicalPeriodLength: profile.typicalPeriodLength,
          lutealPhaseLength: profile.lutealPhaseLength,
          secondarySymptom: profile.secondarySymptom,
          predictionEnabled: profile.predictionEnabled,
          rawChartMode: profile.rawChartMode,
          discreetNotifications: profile.discreetNotifications,
          sensitiveCategoryEncryption: profile.sensitiveCategoryEncryption,
        }
      : null,
    cycles: cycles.map((c) => ({
      ...(disasterRecovery
        ? {
            id: c.id,
            isPredicted: c.isPredicted,
            syncVersion: c.syncVersion,
            deletedAt: c.deletedAt?.toISOString() ?? null,
            absorbedIntoId: c.absorbedIntoId,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          }
        : {}),
      startDate: c.startDate,
      endDate: c.endDate,
      periodEndDate: c.periodEndDate,
      lengthDays: c.lengthDays,
      ovulationDate: c.ovulationDate,
      ovulationConfirmed: c.ovulationConfirmed,
      tz: c.tz,
    })),
    cycleDayLogs: dayLogs.map((d) => ({
      ...(disasterRecovery
        ? {
            id: d.id,
            cycleId: d.cycleId,
            syncVersion: d.syncVersion,
            deletedAt: d.deletedAt?.toISOString() ?? null,
            createdAt: d.createdAt.toISOString(),
            updatedAt: d.updatedAt.toISOString(),
          }
        : {}),
      date: d.date,
      flow: d.flow,
      intermenstrualBleeding: d.intermenstrualBleeding,
      basalBodyTempC: d.basalBodyTempC,
      temperatureExcluded: d.temperatureExcluded,
      ovulationTest: d.ovulationTest,
      cervicalMucus: d.cervicalMucus,
      cervixPosition: d.cervixPosition,
      cervixFirmness: d.cervixFirmness,
      cervixOpening: d.cervixOpening,
      sexualActivity: d.sexualActivity,
      protectedSex: d.protectedSex,
      pregnancyTest: d.pregnancyTest,
      progesteroneTest: d.progesteroneTest,
      contraceptive: d.contraceptive,
      ...(disasterRecovery
        ? {
            sensitiveEncrypted: d.sensitiveEncrypted,
            notesEncrypted: d.notesEncrypted,
          }
        : {
            sensitive: openSensitiveForExport(d.sensitiveEncrypted),
            note: d.notesEncrypted
              ? openSealedForExport(d.notesEncrypted, "cycle day-log note")
              : null,
          }),
      source: d.source,
      externalId: d.externalId,
      tz: d.tz,
      symptomKeys: d.symptomLinks.map((l) => l.symptom.key),
      symptomSeverities: d.symptomLinks
        .filter((l): l is typeof l & { severity: number } => l.severity != null)
        .map((l) => ({ key: l.symptom.key, severity: l.severity })),
    })),
    customSymptoms: customSymptoms.map((sym) => ({
      ...(disasterRecovery ? { id: sym.id } : {}),
      key: sym.key,
      labelKey: sym.labelKey,
      categoryId: sym.categoryId,
      icon: sym.icon,
      sortOrder: sym.sortOrder,
      isActive: sym.isActive,
      ...(disasterRecovery
        ? { labelEncrypted: sym.labelEncrypted }
        : {
            label: sym.labelEncrypted
              ? openSealedForExport(sym.labelEncrypted, "cycle symptom label")
              : null,
          }),
    })),
  };
}

/* ── restore ───────────────────────────────────────────────────────── */

/** Counts the cycle restore wiped, for the audit trail. */
export interface CycleRestoreCleared {
  cycles: number;
  cycleDayLogs: number;
  cycleProfile: number;
}

// Closed enum allow-lists. The backup schema is `.passthrough()`, so a
// malformed enum value would otherwise crash deep in `create()`. Guard the
// few enum columns up-front (mirrors the measurement-type guard in the
// restore route). Unknown values are coerced to null rather than failing
// the whole restore — a single drifted field shouldn't strand the rest.
const FLOW_LEVELS = new Set<FlowLevel>([
  "NONE",
  "SPOTTING",
  "LIGHT",
  "MEDIUM",
  "HEAVY",
]);
const OVULATION_TESTS = new Set<OvulationTest>([
  "NEGATIVE",
  "POSITIVE_LH_SURGE",
  "ESTROGEN_SURGE",
  "INDETERMINATE",
]);
const CERVICAL_MUCUS = new Set<CervicalMucus>([
  "DRY",
  "STICKY",
  "CREAMY",
  "WATERY",
  "EGG_WHITE",
]);
const SECONDARY_SYMPTOMS = new Set<SecondarySymptom>(["MUCUS", "CERVIX"]);
const CERVIX_POSITIONS = new Set<CervixPosition>(["LOW", "HIGH"]);
const CERVIX_FIRMNESSES = new Set<CervixFirmness>(["FIRM", "SOFT"]);
const CERVIX_OPENINGS = new Set<CervixOpening>(["CLOSED", "OPEN"]);
const HOME_TESTS = new Set<HomeTestResult>([
  "NEGATIVE",
  "POSITIVE",
  "INDETERMINATE",
]);
const CONTRACEPTIVES = new Set<ContraceptiveKind>([
  "NONE",
  "UNSPECIFIED",
  "IMPLANT",
  "INJECTION",
  "IUD",
  "INTRAVAGINAL_RING",
  "ORAL",
  "PATCH",
  "EMERGENCY",
]);
const CYCLE_SOURCES = new Set<MeasurementSource>([
  "MANUAL",
  "WITHINGS",
  "IMPORT",
  "APPLE_HEALTH",
]);
const CYCLE_GOALS = new Set<CycleTrackingGoal>([
  "GENERAL_HEALTH",
  "AVOID_PREGNANCY",
  "TRYING_TO_CONCEIVE",
  "PERIMENOPAUSE",
  "OFF",
]);

/**
 * A symptom severity is the 1-4 Likert the log-day sheet writes, or nothing.
 *
 * Anything else — a value from a hand-edited file, a wider scale some later
 * release might use, a null — reads as "not rated". It is dropped rather than
 * clamped or rounded into range, because a severity nobody recorded is absent,
 * and inventing a 1 or a 4 for it would be a guess printed next to the person's
 * own numbers. It never fails the restore: refusing the whole file over one
 * unfamiliar intensity would cost far more than the intensity does.
 */
function severityOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 4
    ? value
    : null;
}

function enumOrNull<T extends string>(
  value: string | null | undefined,
  allow: ReadonlySet<T>,
): T | null {
  return value != null && (allow as ReadonlySet<string>).has(value)
    ? (value as T)
    : null;
}

/**
 * Restore the cycle tables for `ownerId` from a parsed backup payload,
 * inside an existing transaction. Delete-then-recreate, matching the
 * measurement/mood restore contract. Symptom links are re-resolved against
 * the seeded catalogue by key, and each one gets back the 1-4 intensity the
 * file recorded for it, or none if the file recorded none. Sealed free text
 * comes back as the file-header comment describes: readable values sealed
 * under this host's key, ciphertext written back only when this host opens it.
 *
 * A key that resolves against nothing is dropped from the day's links and
 * recorded on `skips`. It is a required argument rather than an optional one:
 * a caller that forgets to pass it would restore exactly as before and report
 * nothing, which is the failure this reporting exists to end.
 *
 * Returns the wiped counts for the audit trail. A pre-v1.15 payload (empty
 * cycle arrays + null profile) wipes nothing and recreates nothing.
 */
export async function restoreCycleData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: BackupPayload,
  skips: RestoreSkipLog,
): Promise<CycleRestoreCleared> {
  // Sealed values from the file this host's keys do not open, by file path.
  const unopened: string[] = [];

  // Wipe (child links cascade off the day-log delete).
  const dayLogs = await tx.cycleDayLog.deleteMany({
    where: { userId: ownerId },
  });
  const cycles = await tx.menstrualCycle.deleteMany({
    where: { userId: ownerId },
  });
  const profile = await tx.cycleProfile.deleteMany({
    where: { userId: ownerId },
  });

  // Recreate the profile (one row / user).
  if (payload.cycleProfile) {
    const p = payload.cycleProfile;
    await tx.cycleProfile.create({
      data: {
        ...(p.id ? { id: p.id } : {}),
        userId: ownerId,
        goal: enumOrNull(p.goal, CYCLE_GOALS) ?? "GENERAL_HEALTH",
        cycleTrackingEnabled: p.cycleTrackingEnabled ?? null,
        typicalCycleLength: p.typicalCycleLength ?? null,
        typicalPeriodLength: p.typicalPeriodLength ?? null,
        lutealPhaseLength: p.lutealPhaseLength ?? null,
        secondarySymptom:
          enumOrNull(p.secondarySymptom, SECONDARY_SYMPTOMS) ?? "MUCUS",
        predictionEnabled: p.predictionEnabled ?? true,
        rawChartMode: p.rawChartMode ?? false,
        discreetNotifications: p.discreetNotifications ?? false,
        sensitiveCategoryEncryption: p.sensitiveCategoryEncryption ?? true,
        ...(p.createdAt ? { createdAt: new Date(p.createdAt) } : {}),
        ...(p.updatedAt ? { updatedAt: new Date(p.updatedAt) } : {}),
      },
    });
  }

  // Recreate observed cycle spans; map startDate → id so day-logs can
  // re-attach to their owning span.
  const cycleIdByStart = new Map<string, string>();
  const restoredCycleIds = new Set<string>();
  // A folded start names the start that absorbed it. Kept only when that start
  // is in the same file under the same id; a pointer at nothing would stop the
  // folded row from ever coming back, which is what the column is for.
  const carriedCycleIds = new Set(
    payload.cycles.flatMap((c) => (c.id ? [c.id] : [])),
  );
  for (const c of payload.cycles) {
    const created = await tx.menstrualCycle.create({
      data: {
        ...(c.id ? { id: c.id } : {}),
        userId: ownerId,
        startDate: c.startDate,
        endDate: c.endDate ?? null,
        periodEndDate: c.periodEndDate ?? null,
        lengthDays: c.lengthDays ?? null,
        ovulationDate: c.ovulationDate ?? null,
        ovulationConfirmed: c.ovulationConfirmed ?? false,
        tz: c.tz ?? null,
        isPredicted: c.isPredicted ?? false,
        syncVersion: c.syncVersion ?? 0,
        deletedAt: c.deletedAt ? new Date(c.deletedAt) : null,
        absorbedIntoId:
          c.absorbedIntoId && carriedCycleIds.has(c.absorbedIntoId)
            ? c.absorbedIntoId
            : null,
        ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
        ...(c.updatedAt ? { updatedAt: new Date(c.updatedAt) } : {}),
      },
    });
    cycleIdByStart.set(c.startDate, created.id);
    restoredCycleIds.add(created.id);
  }

  // Re-create the account's own symptom definitions BEFORE resolving links.
  // The seeded catalogue is already on this instance; a symptom the user made
  // exists only in the file, and a link cannot resolve to a row that was never
  // written back.
  for (const sym of payload.customSymptoms ?? []) {
    await tx.cycleSymptom.upsert({
      where: { key: sym.key },
      create: {
        ...(sym.id ? { id: sym.id } : {}),
        userId: ownerId,
        key: sym.key,
        labelKey: sym.labelKey,
        categoryId: sym.categoryId,
        icon: sym.icon ?? null,
        sortOrder: sym.sortOrder,
        isActive: sym.isActive,
        labelEncrypted: sealForRestore(
          sym.labelEncrypted,
          sym.label,
          `customSymptoms.${sym.key}.labelEncrypted`,
          unopened,
        ),
      },
      // `key` is globally unique, so a seeded key would collide. Leave the
      // catalogue row alone: the account's links resolve against it either way.
      update: {},
    });
  }

  // Resolve the symptom catalogue once for the link re-creation.
  const referencedKeys = payload.cycleDayLogs.flatMap(
    (d) => d.symptomKeys ?? [],
  );
  const allKeys = Array.from(new Set(referencedKeys));
  const symptomIdByKey = new Map<string, string>();
  if (allKeys.length > 0) {
    const rows = await tx.cycleSymptom.findMany({
      where: {
        key: { in: allKeys },
        OR: [{ userId: null }, { userId: ownerId }],
      },
      select: { id: true, key: true },
    });
    for (const r of rows) symptomIdByKey.set(r.key, r.id);

    // A cycle reference below still throws, and that difference is the point.
    // A `cycleId` names a row THIS FILE was supposed to carry, so a dangling
    // one means the file contradicts itself and nothing good comes of writing
    // it. A symptom key names a row the INSTANCE owns: the seeded catalogue is
    // reference data that drifts across releases, so a key the file wrote a
    // year ago and this instance no longer seeds is an ordinary, expected
    // mismatch. Refusing the file over it threw away every measurement, every
    // dose, and every note to protect a symptom chip. The link is dropped and
    // named instead — see `restore-skips.ts` for why neither throwing nor
    // filtering in silence was an acceptable answer.
    const unresolved = allKeys.filter((k) => !symptomIdByKey.has(k));
    recordUnknownKeys(skips, "cycleSymptom", unresolved, referencedKeys);
  }

  // Recreate day-logs (with symptom links). The owning cycle is the latest
  // span whose start is on/before the day (the cycle-attribution rule).
  const sortedStarts = payload.cycles
    .map((c) => c.startDate)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const owningCycleId = (date: string): string | null => {
    let id: string | null = null;
    for (const start of sortedStarts) {
      if (start <= date) id = cycleIdByStart.get(start) ?? id;
      else break;
    }
    return id;
  };

  for (const d of payload.cycleDayLogs) {
    // The day's rated intensities, keyed by symptom. A file written before
    // severities were carried has no list at all and every link comes back
    // unrated, which is what it was. An entry naming a symptom the day does not
    // have is simply never read.
    const severityByKey = new Map<string, number>();
    for (const s of d.symptomSeverities ?? []) {
      const severity = severityOrNull(s.severity);
      if (severity !== null) severityByKey.set(s.key, severity);
    }

    // Every unresolvable key was counted into `skips` above, so dropping it
    // here is a reported drop rather than a silent one. The rest of the day —
    // flow, temperature, the encrypted note, every observation the person
    // actually wrote — is unaffected by a symptom chip that will not resolve.
    const symptomLinks = (d.symptomKeys ?? []).flatMap((k) => {
      const id = symptomIdByKey.get(k);
      return id
        ? [{ symptomId: id, severity: severityByKey.get(k) ?? null }]
        : [];
    });
    const cycleId =
      d.cycleId !== undefined
        ? d.cycleId === null
          ? null
          : restoredCycleIds.has(d.cycleId)
            ? d.cycleId
            : (() => {
                throw new Error(`Unknown cycle reference: ${d.cycleId}`);
              })()
        : owningCycleId(d.date);
    await tx.cycleDayLog.create({
      data: {
        ...(d.id ? { id: d.id } : {}),
        userId: ownerId,
        date: d.date,
        cycleId,
        flow: enumOrNull(d.flow, FLOW_LEVELS),
        intermenstrualBleeding: d.intermenstrualBleeding ?? false,
        basalBodyTempC: d.basalBodyTempC ?? null,
        temperatureExcluded: d.temperatureExcluded ?? false,
        ovulationTest: enumOrNull(d.ovulationTest, OVULATION_TESTS),
        cervicalMucus: enumOrNull(d.cervicalMucus, CERVICAL_MUCUS),
        cervixPosition: enumOrNull(d.cervixPosition, CERVIX_POSITIONS),
        cervixFirmness: enumOrNull(d.cervixFirmness, CERVIX_FIRMNESSES),
        cervixOpening: enumOrNull(d.cervixOpening, CERVIX_OPENINGS),
        sexualActivity: d.sexualActivity ?? false,
        protectedSex: d.protectedSex ?? null,
        pregnancyTest: enumOrNull(d.pregnancyTest, HOME_TESTS),
        progesteroneTest: enumOrNull(d.progesteroneTest, HOME_TESTS),
        contraceptive: enumOrNull(d.contraceptive, CONTRACEPTIVES),
        sensitiveEncrypted: sealForRestore(
          d.sensitiveEncrypted,
          d.sensitive === undefined || d.sensitive === null
            ? d.sensitive
            : typeof d.sensitive === "string"
              ? UNOPENED
              : JSON.stringify(d.sensitive),
          `cycleDayLogs.${d.date}.sensitiveEncrypted`,
          unopened,
        ),
        notesEncrypted: sealForRestore(
          d.notesEncrypted,
          d.note,
          `cycleDayLogs.${d.date}.notesEncrypted`,
          unopened,
        ),
        source: enumOrNull(d.source, CYCLE_SOURCES) ?? "MANUAL",
        externalId: d.externalId ?? null,
        tz: d.tz ?? null,
        syncVersion: d.syncVersion ?? 0,
        deletedAt: d.deletedAt ? new Date(d.deletedAt) : null,
        ...(d.createdAt ? { createdAt: new Date(d.createdAt) } : {}),
        ...(d.updatedAt ? { updatedAt: new Date(d.updatedAt) } : {}),
        ...(symptomLinks.length > 0
          ? { symptomLinks: { create: symptomLinks } }
          : {}),
      },
    });
  }

  recordUnknownKeys(skips, "cycleCiphertext", unopened, unopened);

  return {
    cycles: cycles.count,
    cycleDayLogs: dayLogs.count,
    cycleProfile: profile.count,
  };
}
