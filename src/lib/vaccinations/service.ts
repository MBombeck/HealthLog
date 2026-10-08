/**
 * What the vaccination routes share: the query shapes, the ownership probes,
 * the domain redaction, and the link application.
 *
 * Extracted for the same reason `src/lib/encounters/service.ts` is: four route
 * files need the same include, the same "does the caller own this practice"
 * question and the same seam handling, and four copies of a redaction rule is
 * three chances to get it wrong.
 */
import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { listTargets, replaceTargets } from "@/lib/links";
import type { ShareDomain } from "@/lib/sharing/scope";
import type { VaccinationDocumentDTO } from "@/lib/vaccinations/dto";
import {
  deriveSeries,
  type SeriesInputRecord,
} from "@/lib/vaccinations/series";
import {
  CUSTOM_VACCINE_RESOLVE_SELECT,
  loadCustomVaccineLookup,
} from "@/lib/vaccinations/resolve-vaccine-entry";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/** Matches the visits service: the fallback when an account never set one. */

/** The relations every vaccination response resolves. */
export const VACCINATION_INCLUDE = {
  practitioner: true,
  encounter: { select: { id: true, occurredAt: true, kind: true } },
  // v1.42 (#1005) — the person's own definition, resolved onto the DTO so no
  // client needs a second read to name the dose or count its antigens.
  customVaccine: { select: CUSTOM_VACCINE_RESOLVE_SELECT },
} as const satisfies Prisma.VaccinationRecordInclude;

/** What the series derivation needs, and nothing more. */
export const SERIES_SELECT = {
  id: true,
  occurredAt: true,
  antigenSlug: true,
  customVaccineId: true,
  doseNumber: true,
  seriesDoses: true,
} as const satisfies Prisma.VaccinationRecordSelect;

/**
 * The whole live history for one account, in the shape the derivation wants.
 *
 * The series is a property of the set, so every read that publishes a position
 * loads the set — including the detail route, which holds one row and cannot
 * answer the question from it. The rows are small (five scalar columns) and an
 * Impfpass is a short document even after a long life, so this is cheaper than
 * the cache that would keep it consistent.
 */
export async function loadSeriesHistory(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<SeriesInputRecord[]> {
  return tx.vaccinationRecord.findMany({
    where: { userId, deletedAt: null },
    orderBy: { occurredAt: "asc" },
    select: SERIES_SELECT,
  });
}

/**
 * Every record's resolved series positions, keyed by record id. The record's
 * own vaccine definitions are read beside the history, so a dose logged
 * against one counts into the antigens it lists.
 */
export async function resolveSeriesFor(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const [history, customs] = await Promise.all([
    loadSeriesHistory(tx, userId),
    loadCustomVaccineLookup(tx, userId),
  ]);
  return deriveSeries(history, customs);
}

/**
 * The linked pages, resolved and redacted against the caller's reach.
 *
 * A dose lives in the health background and points into the document vault. A
 * grant that opened the background was never consent for the vault, and while
 * no document CONTENT crosses the seam here, the filename is itself the
 * sensitive part: a page called "oncology discharge letter" says most of what
 * the person was worried about.
 *
 * So the label and the date are withheld and the LINK is not: the caller may
 * know the dose was transcribed from a page, because the dose is theirs to
 * read. `label: null` rather than an invented placeholder, so an absence reads
 * as an absence, and `redacted` says which of the two nulls this is.
 */
export async function loadVaccinationDocuments(
  tx: Prisma.TransactionClient,
  userId: string,
  vaccinationId: string,
  visible: (domain: ShareDomain) => boolean,
): Promise<VaccinationDocumentDTO[]> {
  const rows = await listTargets(tx, {
    userId,
    sourceKind: "vaccination",
    sourceId: vaccinationId,
    targetKind: "document",
  });
  if (visible("documents")) {
    return rows.map((row) => ({ ...row, redacted: false }));
  }
  return rows.map((row) => ({
    id: row.id,
    label: null,
    date: null,
    redacted: true,
  }));
}

/**
 * Apply the document array, when the request named one.
 *
 * An absent array leaves the links alone; a present one replaces them, empty
 * array included. Unknown ids are dropped by the link service and never block
 * the save — a dose is never refused because a page it pointed at has since
 * been deleted.
 */
export async function applyVaccinationLinks(
  tx: Prisma.TransactionClient,
  userId: string,
  vaccinationId: string,
  documentIds: string[] | undefined,
): Promise<void> {
  if (documentIds === undefined) return;
  await replaceTargets(tx, {
    userId,
    sourceKind: "vaccination",
    sourceId: vaccinationId,
    targetKind: "document",
    targetIds: documentIds,
  });
}

/** Does the caller own a live practitioner with this id? */
export async function resolveOwnedPractitioner(
  tx: Prisma.TransactionClient,
  userId: string,
  practitionerId: string,
): Promise<{ id: string } | null> {
  return tx.practitioner.findFirst({
    where: { id: practitionerId, userId, deletedAt: null },
    select: { id: true },
  });
}

/**
 * The RECORD owner's timezone, for the booster reschedule.
 *
 * The owner's, never the acting delegate's: a reminder fires on the owner's
 * phone at the owner's local hour, and a helper transcribing from another
 * timezone must not shift when it rings.
 */
export async function resolveOwnerTimezone(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  return row?.timezone || DEFAULT_TIMEZONE;
}

/** Does the record own a live vaccine definition with this id? */
export async function resolveOwnedCustomVaccine(
  tx: Prisma.TransactionClient,
  userId: string,
  customVaccineId: string,
): Promise<{ id: string } | null> {
  return tx.customVaccine.findFirst({
    where: { id: customVaccineId, userId, deletedAt: null },
    select: { id: true },
  });
}

/** Does the caller own a live visit with this id? */
export async function resolveOwnedEncounter(
  tx: Prisma.TransactionClient,
  userId: string,
  encounterId: string,
): Promise<{ id: string } | null> {
  return tx.encounter.findFirst({
    where: { id: encounterId, userId, deletedAt: null },
    select: { id: true },
  });
}
