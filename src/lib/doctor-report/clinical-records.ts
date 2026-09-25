/**
 * The structured clinical records on the doctor report: labs, illness
 * episodes, allergies and family history.
 *
 * Each one is its own leaf and its own read. A refused leaf is not queried at
 * all — the payload reflects "this was never fetched", not "this was fetched
 * and then dropped". No free-text note column is ever selected on this path;
 * the only decrypted free text is the allergy reaction, which is what an
 * allergy record is for.
 *
 * Split out of the aggregator with the selection rework.
 */
import { prisma } from "@/lib/db";
import { deriveSeries } from "@/lib/vaccinations/series";
import { resolveEffectiveReferenceRange } from "@/lib/labs/reference-range";
import { getEvent } from "@/lib/logging/context";
import { decryptAllergyReaction } from "@/lib/doctor-report-helpers";
import type { DoctorReportData } from "@/lib/doctor-report-types";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { decryptHealthProfileFactValue } from "@/lib/profile/health-facts";
import {
  emergencyProfileHasContent,
  readEmergencyProfile,
} from "@/lib/profile/emergency-profile";
import type {
  HealthProfileFactKind,
  HealthProfileFactValue,
} from "@/lib/validations/health-profile-facts";

/**
 * Structured lab results over the window, reduced to the latest reading per
 * analyte with a count, so the report is a concise panel rather than a raw
 * dump. Analyte keys fold case-insensitively.
 */
export async function loadLabResults(
  userId: string,
  start: Date,
  end: Date,
): Promise<DoctorReportData["labResults"]> {
  const rows = await prisma.labResult.findMany({
    where: { userId, takenAt: { gte: start, lte: end }, deletedAt: null },
    orderBy: { takenAt: "asc" },
    select: {
      panel: true,
      analyte: true,
      value: true,
      valueText: true,
      unit: true,
      referenceLow: true,
      referenceHigh: true,
      sourceReferenceLow: true,
      sourceReferenceHigh: true,
      sourceReferenceText: true,
      takenAt: true,
    },
  });
  const byAnalyte = new Map<
    string,
    NonNullable<DoctorReportData["labResults"]>[number]
  >();
  for (const r of rows) {
    const key = r.analyte.toLowerCase();
    const prev = byAnalyte.get(key);
    // The row already stamps the catalog band it was written under; the
    // reading's own report window, when present, is what the physician read
    // the value against, so it wins here exactly as it does on every other
    // lab surface.
    const range = resolveEffectiveReferenceRange(
      r.referenceLow,
      r.referenceHigh,
      r,
    );
    byAnalyte.set(key, {
      panel: r.panel,
      analyte: r.analyte,
      value: r.value,
      valueText: r.valueText,
      unit: r.unit,
      referenceLow: range.low,
      referenceHigh: range.high,
      catalogReferenceLow: range.catalogLow,
      catalogReferenceHigh: range.catalogHigh,
      sourceReferenceText: range.sourceText,
      referenceOrigin: range.origin,
      referenceDivergesFromCatalog: range.divergesFromCatalog,
      takenAt: r.takenAt.toISOString(),
      count: (prev?.count ?? 0) + 1,
    });
  }
  const collapsed = Array.from(byAnalyte.values());
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Illness / condition episodes overlapping the window. An episode overlaps
 * when it began on or before the window end AND is either still ongoing or
 * resolved on or after the window start. Labels, lifecycle and dates only.
 */
export async function loadIllnessEpisodes(
  userId: string,
  start: Date,
  end: Date,
): Promise<DoctorReportData["illnessEpisodes"]> {
  const rows = await prisma.illnessEpisode.findMany({
    where: {
      userId,
      deletedAt: null,
      onsetAt: { lte: end },
      OR: [{ resolvedAt: null }, { resolvedAt: { gte: start } }],
    },
    orderBy: { onsetAt: "asc" },
    select: {
      label: true,
      type: true,
      lifecycle: true,
      onsetAt: true,
      resolvedAt: true,
    },
  });
  const mapped = rows.map((e) => ({
    label: e.label,
    type: e.type,
    lifecycle: e.lifecycle,
    onsetAt: e.onsetAt.toISOString(),
    resolvedAt: e.resolvedAt ? e.resolvedAt.toISOString() : null,
  }));
  return mapped.length > 0 ? mapped : null;
}

/**
 * Visits inside the window, with the conditions each was filed against.
 *
 * The two free-text columns are `Bytes` ciphertext and decrypt fail-soft, the
 * same stance the allergy reaction takes: a key-rotation gap on one row reads
 * as a visit with no reason recorded rather than as a failed report. `kind` and
 * `status` cross as enum constants — the renderer names them in the REPORT's
 * language, which is the reading clinician's.
 *
 * The condition labels come off the link rows directly rather than through the
 * link service: this is a read of the OWNER's own record for the owner's own
 * report, with no grant to narrow against and no redaction to apply, and the
 * service's per-family visibility predicate has no meaning here.
 */
export async function loadVisits(
  userId: string,
  start: Date,
  end: Date,
): Promise<DoctorReportData["visits"]> {
  const rows = await prisma.encounter.findMany({
    where: {
      userId,
      deletedAt: null,
      occurredAt: { gte: start, lte: end },
    },
    orderBy: { occurredAt: "asc" },
    select: {
      occurredAt: true,
      kind: true,
      status: true,
      reasonEncrypted: true,
      outcomeEncrypted: true,
      practitioner: { select: { name: true, specialty: true } },
      conditionLinks: {
        select: { episode: { select: { label: true, deletedAt: true } } },
      },
    },
  });

  const decrypt = (
    value: Uint8Array | null,
    field: "reason" | "outcome",
  ): string | null => {
    if (!value || value.byteLength === 0) return null;
    try {
      return decryptFromBytes(value);
    } catch {
      getEvent()?.addWarning(
        `doctor-report: visit ${field} decrypt failed for ${userId}`,
      );
      return null;
    }
  };

  const mapped = rows.map((row) => ({
    occurredAt: row.occurredAt.toISOString(),
    kind: row.kind,
    status: row.status,
    practitionerName: row.practitioner?.name ?? null,
    practitionerSpecialty: row.practitioner?.specialty ?? null,
    reason: decrypt(row.reasonEncrypted, "reason"),
    outcome: decrypt(row.outcomeEncrypted, "outcome"),
    // A condition the person has since deleted is not named in a clinical
    // document: the link row survives the soft delete, and printing a label
    // they removed would put a withdrawn diagnosis in front of a doctor.
    conditionLabels: row.conditionLinks
      .filter((link) => link.episode?.deletedAt === null)
      .map((link) => link.episode.label),
  }));
  return mapped.length > 0 ? mapped : null;
}

/**
 * The surgical history: every procedure that happened, oldest first.
 *
 * Reference data, not windowed — like the immunization history below, it is a
 * lifetime answer, and a report over the last 90 days that left out a knee
 * operation from 2011 would answer "what surgeries have you had" wrongly.
 * Planned, cancelled and missed procedures are not surgical history. The three
 * free-text columns decrypt fail-soft per row, the same stance `loadVisits`
 * takes.
 */
export async function loadSurgicalHistory(
  userId: string,
): Promise<DoctorReportData["surgicalHistory"]> {
  const rows = await prisma.encounter.findMany({
    where: { userId, deletedAt: null, kind: "PROCEDURE", status: "DONE" },
    orderBy: { occurredAt: "asc" },
    select: {
      occurredAt: true,
      reasonEncrypted: true,
      outcomeEncrypted: true,
      bodySiteEncrypted: true,
      laterality: true,
      practitioner: { select: { name: true } },
    },
  });
  if (rows.length === 0) return null;

  const decrypt = (
    value: Uint8Array | null,
    field: "reason" | "outcome" | "bodySite",
  ): string | null => {
    if (!value || value.byteLength === 0) return null;
    try {
      return decryptFromBytes(value);
    } catch {
      getEvent()?.addWarning(
        `doctor-report: procedure ${field} decrypt failed for ${userId}`,
      );
      return null;
    }
  };

  return rows.map((row) => ({
    occurredAt: row.occurredAt.toISOString(),
    procedure: decrypt(row.reasonEncrypted, "reason"),
    bodySite: decrypt(row.bodySiteEncrypted, "bodySite"),
    laterality: row.laterality,
    outcome: decrypt(row.outcomeEncrypted, "outcome"),
    practitionerName: row.practitioner?.name ?? null,
  }));
}

/**
 * The immunization history. Reference data, not time-windowed — an Impfpass is
 * a lifetime document, so like allergies it ignores the report window.
 *
 * The series positions are derived server-side over the whole live set (the
 * same derivation the list and the API use), so the report reproduces exactly
 * the numbers the person sees on screen and no client re-derives them. No note
 * column is read on this path — an Impfreaktion is the person's private note,
 * not part of a handed-over record.
 */
export async function loadImmunizations(
  userId: string,
): Promise<DoctorReportData["immunizations"]> {
  const rows = await prisma.vaccinationRecord.findMany({
    where: { userId, deletedAt: null },
    orderBy: { occurredAt: "asc" },
    select: {
      id: true,
      occurredAt: true,
      antigenSlug: true,
      vaccineName: true,
      lotNumber: true,
      seriesDoses: true,
      doseNumber: true,
      site: true,
      practitioner: { select: { name: true } },
    },
  });
  if (rows.length === 0) return null;

  const series = deriveSeries(
    rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      antigenSlug: row.antigenSlug,
      doseNumber: row.doseNumber,
      seriesDoses: row.seriesDoses,
    })),
  );

  return rows.map((row) => ({
    occurredAt: row.occurredAt.toISOString(),
    antigenSlug: row.antigenSlug,
    vaccineName: row.vaccineName,
    lotNumber: row.lotNumber,
    site: row.site,
    practitionerName: row.practitioner?.name ?? null,
    series: (series.get(row.id) ?? []).map((position) => ({
      antigen: position.antigen,
      position: position.position,
      total: position.total,
      booster: position.booster,
    })),
  }));
}

/**
 * Structured allergy records. Reference data, not time-windowed — a
 * penicillin allergy does not expire with the report window.
 *
 * The reaction description decrypts fail-soft per row. A reaction that WAS
 * recorded but cannot be read is flagged rather than silently blanked, so the
 * renderer prints an honest marker instead of a clinician-facing export
 * reading as "no reaction recorded".
 */
export async function loadAllergies(
  userId: string,
): Promise<DoctorReportData["allergies"]> {
  const rows = await prisma.allergy.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      substance: true,
      category: true,
      type: true,
      severity: true,
      status: true,
      reactionEncrypted: true,
    },
  });
  const mapped = rows.map((r) => {
    const { reaction, reactionUnreadable } = decryptAllergyReaction(
      r.reactionEncrypted,
    );
    if (reactionUnreadable) {
      getEvent()?.addWarning(
        `doctor-report: allergy reaction decrypt failed for ${userId} (substance=${r.substance})`,
      );
    }
    return {
      substance: r.substance,
      category: r.category,
      type: r.type,
      severity: r.severity,
      status: r.status,
      reaction,
      reactionUnreadable,
    };
  });
  return mapped.length > 0 ? mapped : null;
}

/** Structured family history. Same stance as allergies: reference data. */
export async function loadFamilyHistory(
  userId: string,
): Promise<DoctorReportData["familyHistory"]> {
  const rows = await prisma.familyHistoryEntry.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { relationship: true, condition: true, ageAtOnset: true },
  });
  return rows.length > 0 ? rows : null;
}

/**
 * Emergency ("Notfalldaten") facts for the page-one section. The caller owns
 * the selection gate, so reaching this function always means EMERGENCY was
 * admitted. Returns null when nothing is worth surfacing, so the PDF emits no
 * page over an emergency profile the person never filled in — the presence half
 * of the page gate, kept beside the read so the two cannot drift.
 *
 * The DTO shape is exactly the report's emergency shape, so it crosses through
 * unchanged. Free text decrypts fail-soft inside `readEmergencyProfile`.
 */
export async function loadEmergency(
  userId: string,
): Promise<DoctorReportData["emergency"]> {
  const dto = await readEmergencyProfile(userId);
  return emergencyProfileHasContent(dto) ? dto : null;
}

/**
 * Chronic conditions and the three current structured facts. The caller owns
 * the selection gate, so reaching this function always means ANAMNESIS was
 * explicitly selected. It returns an object even with no rows so the renderer
 * can label each absence honestly.
 */
export async function loadAnamnesis(
  userId: string,
): Promise<NonNullable<DoctorReportData["anamnesis"]>> {
  const [profile, factRows] = await Promise.all([
    prisma.userHealthProfile.findUnique({
      where: { userId },
      select: { conditionsEncrypted: true },
    }),
    prisma.healthProfileFactRevision.findMany({
      where: {
        userId,
        validUntil: null,
        supersededByRevisionId: null,
      },
      select: { kind: true, valueEncrypted: true },
    }),
  ]);

  let conditions: string | null = null;
  let conditionsUnreadable = false;
  if (profile?.conditionsEncrypted) {
    try {
      const value = decryptFromBytes(profile.conditionsEncrypted).trim();
      conditions = value.length > 0 ? value : null;
    } catch (error) {
      conditionsUnreadable = true;
      getEvent()?.addWarning(
        `doctor-report: conditions decrypt failed for ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const values: Record<HealthProfileFactKind, HealthProfileFactValue | null> = {
    SMOKING_STATUS: null,
    ALCOHOL_PATTERN: null,
    SHIFT_SCHEDULE: null,
  };
  const unreadableFacts: HealthProfileFactKind[] = [];
  for (const row of factRows) {
    const kind = row.kind as HealthProfileFactKind;
    const decrypted = decryptHealthProfileFactValue(kind, row.valueEncrypted);
    values[kind] = decrypted.value;
    if (decrypted.unreadable) unreadableFacts.push(kind);
  }

  return {
    conditions,
    conditionsUnreadable,
    smokingStatus: values.SMOKING_STATUS as NonNullable<
      DoctorReportData["anamnesis"]
    >["smokingStatus"],
    alcoholPattern: values.ALCOHOL_PATTERN as NonNullable<
      DoctorReportData["anamnesis"]
    >["alcoholPattern"],
    shiftSchedule: values.SHIFT_SCHEDULE as NonNullable<
      DoctorReportData["anamnesis"]
    >["shiftSchedule"],
    unreadableFacts,
  };
}
