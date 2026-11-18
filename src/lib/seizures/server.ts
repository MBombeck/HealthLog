/**
 * The seizure diary (#1368): the server-only half. Text crypto, the row → wire
 * mappers, the one diary read every surface shares, and the rescue-dose write
 * that also records the dose on the medication.
 *
 * Free text (the family's name for a type, the plan, notes, aura and witness
 * text) is held AES-256-GCM encrypted in Bytes columns through the shared
 * codec and decrypted fail-soft: a key gap on one row reads `null` rather than
 * taking the diary down.
 */
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { accountLabel } from "@/lib/sharing/account-access-view";
import { daysBetweenDateKeys, userDayKey } from "@/lib/tz/format";
import type {
  SeizureEvent,
  SeizureRescueDose,
  SeizureTypeProfile,
} from "@/generated/prisma/client";

import {
  alertThreshold,
  deriveClusters,
  durationFlags,
  monthlyByType,
  monthsBetween,
  NICE_CLUSTER_RULE,
  normaliseClusterRule,
  seizureDayKeys,
  seizureFreeSummary,
  totalSeizures,
  type ClusterRule,
  type DerivableSeizure,
} from "./derive";
import { isConvulsiveType, type SeizureIlaeType } from "./ilae";
import {
  DEFAULT_DIARY_DAYS,
  MAX_SEIZURE_EVENTS_PAGE,
  type SeizureDiaryDTO,
  type SeizureDiarySummaryDTO,
  type SeizureEventDTO,
  type SeizureRescueDoseDTO,
  type SeizureSettingsDTO,
  type SeizureTypeDTO,
} from "./shared";

export * from "./shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Encrypt a label, plan or note for storage. */
export function encryptSeizureText(plaintext: string): Uint8Array<ArrayBuffer> {
  return encryptToBytes(plaintext);
}

/** Store-side form of an optional text field: undefined leaves it alone. */
export function sealOptional(
  value: string | null | undefined,
): Uint8Array<ArrayBuffer> | null | undefined {
  if (value === undefined) return undefined;
  return value ? encryptSeizureText(value) : null;
}

/** Decrypt a stored text; null on a missing or unreadable value. */
export function decryptSeizureText(
  buf: Uint8Array | null,
  field: string,
): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptFromBytes(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `seizure ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

type TypeRow = SeizureTypeProfile & {
  rescueMedication?: { name: string } | null;
};

export function toSeizureTypeDTO(row: TypeRow): SeizureTypeDTO {
  return {
    id: row.id,
    label: decryptSeizureText(row.labelEncrypted, "label"),
    ilaeType: row.ilaeType,
    usualDurationSec: row.usualDurationSec,
    rescuePlan: decryptSeizureText(row.rescuePlanEncrypted, "plan"),
    rescueMedicationId: row.rescueMedicationId,
    rescueMedicationName: row.rescueMedication?.name ?? null,
    rescueDoseAmount: row.rescueDoseAmount,
    rescueDoseUnit: row.rescueDoseUnit,
    rescueRoute: row.rescueRoute,
    sortOrder: row.sortOrder,
    archived: row.archivedAt !== null,
    alert: alertThreshold(row.ilaeType, row.usualDurationSec),
  };
}

export function toSeizureRescueDoseDTO(
  row: SeizureRescueDose,
): SeizureRescueDoseDTO {
  return {
    id: row.id,
    eventId: row.eventId,
    medicationId: row.medicationId,
    medicationName: row.medicationName,
    doseAmount: row.doseAmount,
    doseUnit: row.doseUnit,
    route: row.route,
    givenAt: row.givenAt.toISOString(),
    givenBy: row.givenBy,
    effect: row.effect,
    seizureEndedAt: row.seizureEndedAt?.toISOString() ?? null,
    intakeEventId: row.intakeEventId,
  };
}

export type EventRow = SeizureEvent & { rescueDoses: SeizureRescueDose[] };

/** The type fields an event's derived values read. */
export type TypeLookup = ReadonlyMap<
  string,
  { ilaeType: SeizureIlaeType; usualDurationSec: number | null }
>;

/** The override, else the type's classification, else null. */
export function effectiveIlaeType(
  row: Pick<SeizureEvent, "ilaeType" | "typeProfileId">,
  types: TypeLookup,
): SeizureIlaeType | null {
  if (row.ilaeType) return row.ilaeType;
  return row.typeProfileId
    ? (types.get(row.typeProfileId)?.ilaeType ?? null)
    : null;
}

export function toSeizureEventDTO(
  row: EventRow,
  types: TypeLookup,
  viewerId: string,
  loggerNames: ReadonlyMap<string, string> = new Map(),
): SeizureEventDTO {
  const effective = effectiveIlaeType(row, types);
  const usual = row.typeProfileId
    ? (types.get(row.typeProfileId)?.usualDurationSec ?? null)
    : null;
  return {
    id: row.id,
    typeProfileId: row.typeProfileId,
    ilaeType: row.ilaeType,
    effectiveIlaeType: effective,
    onsetAt: row.onsetAt.toISOString(),
    onsetPrecision: row.onsetPrecision,
    durationSec: row.durationSec,
    durationSource: row.durationSource,
    count: row.count,
    certainty: row.certainty,
    sleepState: row.sleepState,
    observableManifestations: row.observableManifestations,
    responsiveness: row.responsiveness,
    recall: row.recall,
    semiology: row.semiology,
    semiologyNote: decryptSeizureText(row.semiologyNoteEncrypted, "semiology"),
    aura: decryptSeizureText(row.auraEncrypted, "aura"),
    triggers: row.triggers,
    postictalMinutes: row.postictalMinutes,
    postictal: row.postictal,
    injuries: row.injuries,
    incontinence: row.incontinence,
    emergency: row.emergency,
    witnessed: row.witnessed,
    witnessRole: row.witnessRole,
    witnessNote: decryptSeizureText(row.witnessNoteEncrypted, "witness"),
    loggedBy:
      row.loggedByUserId === null
        ? "unknown"
        : row.loggedByUserId === row.userId
          ? "owner"
          : "delegate",
    loggedByViewer: row.loggedByUserId === viewerId,
    loggedByName:
      row.loggedByUserId !== null && row.loggedByUserId !== row.userId
        ? (loggerNames.get(row.loggedByUserId) ?? null)
        : null,
    source: row.source,
    note: decryptSeizureText(row.noteEncrypted, "note"),
    rescueDoses: [...row.rescueDoses]
      .sort((a, b) => a.givenAt.getTime() - b.givenAt.getTime())
      .map(toSeizureRescueDoseDTO),
    flags: durationFlags(row.durationSec, effective, usual),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The derivation view of an event. */
export function toDerivable(
  row: Pick<
    SeizureEvent,
    | "id"
    | "onsetAt"
    | "count"
    | "certainty"
    | "ilaeType"
    | "typeProfileId"
    | "durationSec"
    | "sleepState"
  >,
  types: TypeLookup,
): DerivableSeizure {
  return {
    id: row.id,
    onsetAt: row.onsetAt,
    count: row.count,
    certainty: row.certainty,
    ilaeType: effectiveIlaeType(row, types),
    typeProfileId: row.typeProfileId,
    durationSec: row.durationSec,
    sleepState: row.sleepState,
  };
}

/** The record's cluster rule (the default when none was ever saved). */
export async function readClusterRule(userId: string): Promise<ClusterRule> {
  const row = await prisma.seizureDiarySettings.findUnique({
    where: { userId },
    select: { clusterCount: true, clusterWindowHours: true },
  });
  return normaliseClusterRule(
    row
      ? { count: row.clusterCount, windowHours: row.clusterWindowHours }
      : null,
  );
}

export function toSettingsDTO(rule: ClusterRule): SeizureSettingsDTO {
  return { rule, niceRule: NICE_CLUSTER_RULE };
}

/**
 * Every type of the record, active first in their order. With
 * `medicationsVisible: false` (a delegate whose grant does not reach the
 * medications section) a type does not name its rescue medication.
 */
export async function listSeizureTypes(
  userId: string,
  { medicationsVisible = true }: { medicationsVisible?: boolean } = {},
): Promise<SeizureTypeDTO[]> {
  const rows = await prisma.seizureTypeProfile.findMany({
    where: { userId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: { rescueMedication: { select: { name: true } } },
  });
  return rows
    .map(toSeizureTypeDTO)
    .map((t) =>
      medicationsVisible
        ? t
        : { ...t, rescueMedicationId: null, rescueMedicationName: null },
    )
    .sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      return 0;
    });
}

export function typeLookupOf(types: readonly SeizureTypeDTO[]): TypeLookup {
  return new Map(
    types.map((t) => [
      t.id,
      { ilaeType: t.ilaeType, usualDurationSec: t.usualDurationSec },
    ]),
  );
}

/** Summary figures over the period's events. */
export function summarise(
  rows: readonly EventRow[],
  types: TypeLookup,
  rule: ClusterRule,
  period: { from: Date; to: Date; tz: string; now: Date },
): SeizureDiarySummaryDTO {
  const { from, to, tz, now } = period;
  const fromKey = userDayKey(from, tz);
  const toKey = userDayKey(to, tz);
  const days = Math.max(1, daysBetweenDateKeys(fromKey, toKey) + 1);
  const derivable = rows.map((r) => toDerivable(r, types));
  const confirmed = derivable.filter((e) => e.certainty === "CONFIRMED");
  const suspected = derivable.filter((e) => e.certainty === "SUSPECTED");
  const seizureDays = seizureDayKeys(confirmed, tz).length;
  const seizures = totalSeizures(confirmed);
  const monthly = monthlyByType(confirmed, tz);
  const rescueDoses = rows.reduce((n, r) => n + r.rescueDoses.length, 0);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    days,
    seizures,
    suspected: totalSeizures(suspected),
    seizureDays,
    seizureFreeDays: Math.max(0, days - seizureDays),
    per28Days: Math.round((seizures / days) * 28 * 10) / 10,
    convulsive: totalSeizures(
      confirmed.filter((e) => isConvulsiveType(e.ilaeType)),
    ),
    fromSleep: totalSeizures(
      confirmed.filter((e) => e.sleepState === "ASLEEP"),
    ),
    rescueDoses,
    emergencies: {
      emsCalled: rows.filter((r) => r.emergency === "EMS_CALLED").length,
      edVisits: rows.filter((r) => r.emergency === "ED_VISIT").length,
      admissions: rows.filter((r) => r.emergency === "ADMITTED").length,
    },
    streak: seizureFreeSummary(
      derivable,
      tz,
      fromKey,
      toKey,
      userDayKey(now, tz),
    ),
    clusters: deriveClusters(derivable, rule),
    niceClusterCount: deriveClusters(derivable, NICE_CLUSTER_RULE).length,
    monthly: { months: monthsBetween(fromKey, toKey), ...monthly },
  };
}

export interface DiaryReadOptions {
  userId: string;
  viewerId: string;
  tz: string;
  from?: Date;
  to?: Date;
  now?: Date;
  /** False for a delegate whose grant does not reach medications. */
  medicationsVisible?: boolean;
}

/**
 * The diary in one read: types, rule, the period's events and the summary.
 *
 * The streak's "days since the last seizure" looks past the period start:
 * the last confirmed event of all time is read on its own, so a diary opened
 * on a quiet quarter still says when the last one was.
 */
export async function readSeizureDiary(
  opts: DiaryReadOptions,
): Promise<SeizureDiaryDTO> {
  const now = opts.now ?? new Date();
  const to = opts.to ?? now;
  const from =
    opts.from ?? new Date(to.getTime() - DEFAULT_DIARY_DAYS * DAY_MS);

  const [types, rule, rows, lastConfirmed] = await Promise.all([
    listSeizureTypes(opts.userId, {
      medicationsVisible: opts.medicationsVisible ?? true,
    }),
    readClusterRule(opts.userId),
    prisma.seizureEvent.findMany({
      where: { userId: opts.userId, onsetAt: { gte: from, lte: to } },
      include: { rescueDoses: true },
      orderBy: [{ onsetAt: "desc" }, { id: "desc" }],
      take: MAX_SEIZURE_EVENTS_PAGE + 1,
    }),
    prisma.seizureEvent.findFirst({
      where: {
        userId: opts.userId,
        certainty: "CONFIRMED",
        onsetAt: { lte: now },
      },
      orderBy: { onsetAt: "desc" },
      select: { onsetAt: true },
    }),
  ]);
  const truncated = rows.length > MAX_SEIZURE_EVENTS_PAGE;
  const loggerNames = await readLoggerNames(opts.userId, rows);
  const page = truncated ? rows.slice(0, MAX_SEIZURE_EVENTS_PAGE) : rows;
  const lookup = typeLookupOf(types);
  const summary = summarise(page, lookup, rule, {
    from,
    to,
    tz: opts.tz,
    now,
  });
  if (lastConfirmed) {
    const lastKey = userDayKey(lastConfirmed.onsetAt, opts.tz);
    summary.streak.lastAt = lastConfirmed.onsetAt.toISOString();
    summary.streak.daysSinceLast = Math.max(
      0,
      daysBetweenDateKeys(lastKey, userDayKey(now, opts.tz)),
    );
  }

  return {
    types,
    settings: toSettingsDTO(rule),
    events: page.map((r) =>
      toSeizureEventDTO(r, lookup, opts.viewerId, loggerNames),
    ),
    summary,
    truncated,
  };
}

export type RescueMedicationCheck =
  | { ok: true; medication: { id: string; name: string } }
  | { ok: false; errorCode: string; status: 404 | 422; message: string };

/**
 * A rescue medication must be the record's own, as-needed, and tracked: the
 * dose is written as an intake on it, and an as-needed medication is never
 * counted in compliance, so the diary moves no adherence figure.
 */
export async function checkRescueMedication(
  userId: string,
  medicationId: string,
): Promise<RescueMedicationCheck> {
  const med = await prisma.medication.findFirst({
    where: { id: medicationId, userId },
    select: { id: true, name: true, asNeeded: true, trackIntake: true },
  });
  if (!med) {
    return {
      ok: false,
      status: 404,
      errorCode: "seizures.rescue.medicationNotFound",
      message: "Medication not found",
    };
  }
  if (!med.asNeeded || !med.trackIntake) {
    return {
      ok: false,
      status: 422,
      errorCode: "seizures.rescue.notAsNeeded",
      message: "A rescue medication must be an as-needed medication",
    };
  }
  return { ok: true, medication: { id: med.id, name: med.name } };
}

/** "10 mg" from an amount and a unit, for the intake's dose note. */
export function formatRescueDose(
  amount: number | null | undefined,
  unit: string | null | undefined,
): string | null {
  if (amount == null) return null;
  const text = `${Number(amount.toFixed(3))}${unit ? ` ${unit}` : ""}`;
  return text.slice(0, 50);
}

/**
 * The names of the people who logged seizures on someone else's record. The
 * same label the record switcher and the activity view use (`accountLabel`),
 * so a guardian reads as they do everywhere else. An account that no longer
 * exists has no entry.
 */
export async function readLoggerNames(
  ownerId: string,
  rows: ReadonlyArray<Pick<SeizureEvent, "loggedByUserId">>,
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows
        .map((r) => r.loggedByUserId)
        .filter((id): id is string => id !== null && id !== ownerId),
    ),
  ];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, username: true, displayName: true },
  });
  return new Map(users.map((u) => [u.id, accountLabel(u)]));
}
