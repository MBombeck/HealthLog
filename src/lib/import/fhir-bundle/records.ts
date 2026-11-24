/**
 * Conditions, Immunizations, MedicationStatements and Encounters of a FHIR
 * Bundle onto the record's own models, one row per resource, deduplicated by
 * resource id through the `FhirImportedResource` ledger.
 *
 *   Condition           → IllnessEpisode (label, onset, resolution). A
 *                         refuted or entered-in-error Condition is skipped.
 *   Immunization        → VaccinationRecord, on the free-text arm (the
 *                         vaccine as the portal names it, the lot, the dose
 *                         number). Only `completed` doses.
 *   MedicationStatement → Medication without a schedule and with reminders
 *                         off: an import states what was taken, it does not
 *                         start reminding anybody. Active or ended per status
 *                         and the effective period.
 *   Encounter           → Encounter (when, status, kind from the class, the
 *                         reason encrypted like every visit reason).
 *
 * Each write and its ledger row are one transaction, so a crash between the
 * two cannot import the resource twice.
 */
import { createHash } from "node:crypto";

import type {
  EncounterKind,
  EncounterStatus,
  Prisma,
} from "@/generated/prisma/client";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { prisma } from "@/lib/db";
import { setMedicationCategory } from "@/lib/medication-category";
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";

import {
  arr,
  conceptCode,
  conceptText,
  firstDated,
  firstInstant,
  obj,
  statusCode,
  str,
  type Json,
} from "./fields";

export const RECORD_RESOURCE_TYPES = [
  "Condition",
  "Immunization",
  "MedicationStatement",
  "Encounter",
] as const;
export type RecordResourceType = (typeof RECORD_RESOURCE_TYPES)[number];

/** The summary line each resource type is counted under. */
export const RECORD_LINE: Record<RecordResourceType, string> = {
  Condition: "condition",
  Immunization: "vaccination",
  MedicationStatement: "medication",
  Encounter: "visit",
};

export type RecordOutcome =
  | { status: "imported" }
  | { status: "duplicate" }
  | { status: "skipped"; reason: string };

/** The ledger key: the issuer, the type and the resource's id, digested. */
export function resourceKey(
  issuer: string,
  type: string,
  resource: Json,
  fallback: string,
): string {
  const id = str(resource.id, 128);
  return createHash("sha256")
    .update([issuer, type, id ?? `content:${fallback}`].join("\u0000"))
    .digest("hex")
    .slice(0, 40);
}

type Tx = Prisma.TransactionClient;

interface Built {
  /** What identifies the resource when it carries no id. */
  fallback: string;
  create(tx: Tx, userId: string): Promise<string>;
}

function buildCondition(r: Json, now: Date): Built | { skip: string } {
  const verification = statusCode(r.verificationStatus);
  if (verification === "refuted" || verification === "entered-in-error") {
    return { skip: "not_confirmed" };
  }
  const label = conceptText(r.code, 120);
  if (!label) return { skip: "no_label" };
  const onsetAt = firstInstant(
    r.onsetDateTime,
    obj(r.onsetPeriod)?.start,
    r.recordedDate,
  );
  if (!onsetAt) return { skip: "no_date" };
  if (onsetAt > now) return { skip: "future_date" };
  const resolvedAt = firstInstant(
    r.abatementDateTime,
    obj(r.abatementPeriod)?.end,
  );
  const clinical = statusCode(r.clinicalStatus);
  const ongoing =
    !resolvedAt && (clinical === "active" || clinical === "recurrence");
  return {
    fallback: `${label}|${onsetAt.toISOString()}`,
    create: async (tx, userId) =>
      (
        await tx.illnessEpisode.create({
          data: {
            userId,
            label,
            type: "OTHER",
            lifecycle: ongoing ? "CHRONIC_ONGOING" : "ACUTE",
            onsetAt,
            resolvedAt:
              resolvedAt && resolvedAt >= onsetAt && resolvedAt <= now
                ? resolvedAt
                : null,
          },
          select: { id: true },
        })
      ).id,
  };
}

function buildImmunization(r: Json, now: Date): Built | { skip: string } {
  if (statusCode(r.status) !== "completed") return { skip: "not_completed" };
  const name = conceptText(r.vaccineCode, 120);
  if (!name) return { skip: "no_label" };
  const dated = firstDated(r.occurrenceDateTime, r.recorded);
  if (!dated) return { skip: "no_date" };
  if (dated.at > now) return { skip: "future_date" };
  // The day the record states, at UTC midnight, as the vaccination model
  // stores it.
  const occurredAt = dayKeyAsUtcMidnight(dated.dateKey);
  const dose = obj(arr(r.protocolApplied)[0])?.doseNumberPositiveInt;
  return {
    fallback: `${name}|${occurredAt.toISOString()}`,
    create: async (tx, userId) =>
      (
        await tx.vaccinationRecord.create({
          data: {
            userId,
            occurredAt,
            vaccineName: name,
            lotNumber: str(r.lotNumber, 64),
            doseNumber:
              typeof dose === "number" && Number.isInteger(dose) && dose > 0
                ? Math.min(dose, 20)
                : null,
          },
          select: { id: true },
        })
      ).id,
  };
}

function buildMedication(r: Json, now: Date): Built | { skip: string } {
  const status = statusCode(r.status);
  if (status === "entered-in-error" || status === "not-taken") {
    return { skip: "not_taken" };
  }
  const concept = r.medicationCodeableConcept;
  const name = conceptText(concept, 120);
  if (!name) return { skip: "no_label" };
  const dosage = obj(arr(r.dosage)[0]);
  const dose = str(dosage?.text, 60) ?? "";
  const startDated = firstDated(
    obj(r.effectivePeriod)?.start,
    r.effectiveDateTime,
  );
  const start = startDated?.at ?? null;
  const endDated = firstDated(obj(r.effectivePeriod)?.end);
  const end = endDated?.at ?? null;
  const ended =
    status === "completed" ||
    status === "stopped" ||
    (end !== null && end <= now);
  // The course columns are `@db.Date`: the day the record states.
  const startKey = startDated?.dateKey ?? null;
  const endKey = endDated?.dateKey ?? null;
  return {
    fallback: `${name}|${start?.toISOString() ?? ""}`,
    create: async (tx, userId) => {
      const course =
        start && startKey && start <= now
          ? {
              startsOn: dayKeyAsUtcMidnight(startKey),
              endsOn:
                end && endKey && end >= start
                  ? dayKeyAsUtcMidnight(endKey)
                  : null,
            }
          : null;
      const medication = await tx.medication.create({
        data: {
          userId,
          name,
          dose,
          asNeeded: dosage?.asNeededBoolean === true,
          notificationsEnabled: false,
          active: !ended,
          rxNormCode: conceptCode(concept, "rxnorm"),
          atcCode: conceptCode(concept, "atc"),
          ...(course
            ? {
                startsOn: course.startsOn,
                endsOn: course.endsOn,
                courses: {
                  create: {
                    userId,
                    startsOn: course.startsOn,
                    endsOn: course.endsOn,
                  },
                },
              }
            : {}),
        },
        select: { id: true },
      });
      await setMedicationCategory(medication.id, undefined, tx);
      return medication.id;
    },
  };
}

const ENCOUNTER_STATUS: Record<string, EncounterStatus> = {
  finished: "DONE",
  "in-progress": "DONE",
  onleave: "DONE",
  arrived: "DONE",
  triaged: "DONE",
  planned: "PLANNED",
  cancelled: "CANCELLED",
};

const ENCOUNTER_CLASS: Record<string, EncounterKind> = {
  EMER: "EMERGENCY",
  IMP: "HOSPITAL",
  ACUTE: "HOSPITAL",
  NONAC: "HOSPITAL",
  OBSENC: "HOSPITAL",
  SS: "PROCEDURE",
  PRENC: "PREVENTIVE",
};

function buildEncounter(r: Json): Built | { skip: string } {
  const status = ENCOUNTER_STATUS[statusCode(r.status) ?? ""];
  if (!status) return { skip: "not_a_visit" };
  const occurredAt = firstInstant(obj(r.period)?.start, obj(r.period)?.end);
  if (!occurredAt) return { skip: "no_date" };
  const classCode = str(obj(r.class)?.code, 16)?.toUpperCase() ?? "";
  const reason =
    conceptText(arr(r.reasonCode)[0], 500) ?? conceptText(arr(r.type)[0], 500);
  return {
    fallback: `${occurredAt.toISOString()}|${reason ?? ""}`,
    create: async (tx, userId) =>
      (
        await tx.encounter.create({
          data: {
            userId,
            occurredAt,
            status,
            kind: ENCOUNTER_CLASS[classCode] ?? "OTHER",
            reasonEncrypted: reason ? encryptToBytes(reason) : null,
          },
          select: { id: true },
        })
      ).id,
  };
}

function build(
  type: RecordResourceType,
  resource: Json,
  now: Date,
): Built | { skip: string } {
  switch (type) {
    case "Condition":
      return buildCondition(resource, now);
    case "Immunization":
      return buildImmunization(resource, now);
    case "MedicationStatement":
      return buildMedication(resource, now);
    case "Encounter":
      return buildEncounter(resource);
  }
}

/** Write one record resource unless the ledger already holds it. */
export async function importRecordResource(input: {
  userId: string;
  issuer: string;
  type: RecordResourceType;
  resource: Json;
  now: Date;
}): Promise<RecordOutcome> {
  const built = build(input.type, input.resource, input.now);
  if ("skip" in built) return { status: "skipped", reason: built.skip };
  const key = resourceKey(
    input.issuer,
    input.type,
    input.resource,
    built.fallback,
  );
  const held = await prisma.fhirImportedResource.findUnique({
    where: {
      userId_resourceType_resourceKey: {
        userId: input.userId,
        resourceType: input.type,
        resourceKey: key,
      },
    },
    select: { id: true },
  });
  if (held) return { status: "duplicate" };
  try {
    await prisma.$transaction(async (tx) => {
      const recordId = await built.create(tx, input.userId);
      await tx.fhirImportedResource.create({
        data: {
          userId: input.userId,
          resourceType: input.type,
          resourceKey: key,
          recordId,
        },
      });
    });
  } catch (err) {
    // Two runs racing on one resource: the ledger's unique key decides.
    if ((err as { code?: string }).code === "P2002") {
      return { status: "duplicate" };
    }
    throw err;
  }
  return { status: "imported" };
}
