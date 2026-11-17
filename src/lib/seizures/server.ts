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
import type { SessionUser } from "@/lib/auth/session-user";
import { daysBetweenDateKeys, userDayKey } from "@/lib/tz/format";
import { recordIntake } from "@/lib/medications/record-intake/record-intake";
import {
  deleteIntakeEvent,
  findDeletableIntakeEvent,
} from "@/lib/medications/delete-intake-event";
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

/** Every type of the record, active first in their order. */
export async function listSeizureTypes(
  userId: string,
): Promise<SeizureTypeDTO[]> {
  const rows = await prisma.seizureTypeProfile.findMany({
    where: { userId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: { rescueMedication: { select: { name: true } } },
  });
  return rows.map(toSeizureTypeDTO).sort((a, b) => {
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
    listSeizureTypes(opts.userId),
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
    events: page.map((r) => toSeizureEventDTO(r, lookup, opts.viewerId)),
    summary,
    truncated,
  };
}

/** Whether `typeProfileId` names one of the record's own types. */
export async function ownsSeizureType(
  userId: string,
  typeProfileId: string,
): Promise<boolean> {
  const row = await prisma.seizureTypeProfile.findFirst({
    where: { id: typeProfileId, userId },
    select: { id: true },
  });
  return row !== null;
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

export interface RescueDoseInput {
  medicationId?: string | null;
  medicationName?: string | null;
  doseAmount?: number | null;
  doseUnit?: string | null;
  route?: SeizureRescueDose["route"];
  givenAt: Date;
  givenBy?: SeizureRescueDose["givenBy"];
  effect?: SeizureRescueDose["effect"];
  seizureEndedAt?: Date | null;
}

export interface RescueWriteContext {
  user: Pick<SessionUser, "id" | "timezone">;
  actorId: string;
  intakeSource: "API" | "WEB";
  ipAddress: string | null;
  originDeviceToken: string | null;
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
 * Write one rescue dose and, when it names a medication, the intake on that
 * medication through the medication's own intake path (inventory, the dose
 * slot refresh, the owner's notification when a delegate gave it). The intake
 * is keyed on the dose's id, so a retried write cannot record it twice.
 *
 * The medication must already have passed `checkRescueMedication`.
 */
export async function writeRescueDose(
  ctx: RescueWriteContext,
  eventId: string,
  input: RescueDoseInput,
  medication: { id: string; name: string } | null,
): Promise<SeizureRescueDose> {
  const created = await prisma.seizureRescueDose.create({
    data: {
      userId: ctx.user.id,
      eventId,
      medicationId: medication?.id ?? null,
      medicationName: medication?.name ?? input.medicationName ?? "",
      doseAmount: input.doseAmount ?? null,
      doseUnit: input.doseUnit ?? null,
      route: input.route ?? null,
      givenAt: input.givenAt,
      givenBy: input.givenBy ?? null,
      effect: input.effect ?? "UNKNOWN",
      seizureEndedAt: input.seizureEndedAt ?? null,
    },
  });
  if (!medication) return created;

  const outcome = await recordIntake(
    {
      user: ctx.user,
      actorId: ctx.actorId,
      medicationId: medication.id,
      intakeSource: ctx.intakeSource,
      isDelegated: ctx.actorId !== ctx.user.id,
      ipAddress: ctx.ipAddress,
      originDeviceToken: ctx.originDeviceToken,
    },
    {
      medicationId: medication.id,
      takenAt: input.givenAt,
      skipped: false,
      idempotencyKey: `seizure-rescue:${created.id}`,
      doseTaken:
        formatRescueDose(input.doseAmount, input.doseUnit) ?? undefined,
    } as Parameters<typeof recordIntake>[1],
  );
  const intakeId =
    outcome.kind === "recorded"
      ? outcome.event.id
      : outcome.kind === "existing"
        ? outcome.row.id
        : null;
  if (intakeId === null) {
    getEvent()?.addWarning(
      `seizure rescue intake not written: ${outcome.kind}`,
    );
    return created;
  }
  return prisma.seizureRescueDose.update({
    where: { id: created.id },
    data: { intakeEventId: intakeId },
  });
}

/**
 * Undo the intakes written for rescue doses that are being removed, through
 * the medication's own delete path (the tombstone, the inventory refund, the
 * dose slot refresh). A dose recorded by mistake in the diary must not stay
 * recorded on the medication. An intake already gone is skipped.
 */
export async function undoRescueIntakes(
  user: Pick<SessionUser, "id" | "timezone">,
  doses: ReadonlyArray<
    Pick<SeizureRescueDose, "medicationId" | "intakeEventId">
  >,
  ipAddress: string | null,
  originDeviceToken: string | null,
): Promise<number> {
  let undone = 0;
  for (const dose of doses) {
    if (!dose.medicationId || !dose.intakeEventId) continue;
    const event = await findDeletableIntakeEvent({
      userId: user.id,
      medicationId: dose.medicationId,
      eventId: dose.intakeEventId,
    });
    if (!event || event.deletedAt) continue;
    await deleteIntakeEvent({
      user,
      medicationId: dose.medicationId,
      eventId: dose.intakeEventId,
      event,
      ipAddress: ipAddress ?? "unknown",
      originDeviceToken,
    });
    undone += 1;
  }
  return undone;
}
