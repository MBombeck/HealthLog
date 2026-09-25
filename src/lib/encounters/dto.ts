/**
 * Encounter row → wire DTO.
 *
 * Everything is published resolved. The practitioner comes back as an object
 * and never as a bare id, the links come back with a label and a date, and the
 * appointment's next-due instant comes back computed. A client that had to
 * re-derive any of them would drift from the server the first time one of the
 * derivations changed on one side only.
 *
 * The two free-text columns are `Bytes` ciphertext and decrypt fail-soft: a
 * key-rotation gap on one row reads as a missing reason, not as a 500 on the
 * whole list.
 */
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";
import type {
  Encounter,
  EncounterKind,
  EncounterStatus,
  Laterality,
  MeasurementReminder,
  Practitioner,
} from "@/generated/prisma/client";
import type { RestoreSkipSummary } from "@/lib/export/restore-skips";
import {
  toPractitionerDTO,
  type PractitionerDTO,
} from "@/lib/practitioners/dto";

/**
 * One thing a visit produced, as the caller is allowed to see it.
 *
 * `label` and `date` go null together when the caller's grant does not cover
 * the target's own domain — a health-background delegate may know the visit
 * produced a lab result without being told which analyte. `redacted` says
 * which of those nulls is a withholding and which is simply a target with no
 * date, so a client never has to guess.
 */
export interface EncounterLinkDTO {
  id: string;
  label: string | null;
  date: string | null;
  redacted: boolean;
}

/** The three link families a visit can carry, each already resolved. */
export interface EncounterLinksDTO {
  documents: EncounterLinkDTO[];
  labResults: EncounterLinkDTO[];
  conditions: EncounterLinkDTO[];
}

export interface EncounterDTO {
  id: string;
  occurredAt: string;
  status: EncounterStatus;
  kind: EncounterKind;
  /** Resolved, never just an id. `null` when the visit names no practice. */
  practitioner: PractitionerDTO | null;
  reason: string | null;
  outcome: string | null;
  /**
   * Where on the body, decrypted. Carried on every kind, not only PROCEDURE,
   * so a visit switched away from PROCEDURE and back keeps what was typed.
   */
  bodySite: string | null;
  /** The side of the body site, or null when not stated. */
  laterality: Laterality | null;
  /**
   * The server-computed instant the appointment reminder next fires, when this
   * visit minted one and it has not fired yet. `null` for a visit that already
   * happened, or once the one-shot reminder is spent.
   */
  reminderNextDueAt: string | null;
  /**
   * The three link families, resolved.
   *
   * Present on the list as well as the detail. Omitting them from the list
   * would break two things at once: the card counts what a visit produced, and
   * the edit sheet seeds its pickers from the row it was handed — an edit
   * opened from a linkless row would save three empty arrays and unfile
   * everything. The list pays three grouped queries for the whole page.
   */
  links?: EncounterLinksDTO;
  /**
   * What the write could not do, named.
   *
   * Present on create and edit. `links: 0` is the ordinary answer and says so.
   * Anything else is a side effect the caller's grant did not reach — today
   * only the closing of a checkup, which is a measurements-domain write that a
   * health-background delegate cannot perform. Reported rather than skipped in
   * silence, because a person who believes a checkup was closed will not look
   * at it again.
   */
  skipped?: RestoreSkipSummary;
  createdAt: string;
  updatedAt: string;
}

function decryptField(
  value: Uint8Array | null,
  field: "reason" | "outcome" | "bodySite",
): string | null {
  if (!value || value.byteLength === 0) return null;
  try {
    return decryptFromBytes(value);
  } catch (err) {
    getEvent()?.addWarning(
      `encounter ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export type EncounterWithRelations = Encounter & {
  practitioner?: Practitioner | null;
  reminder?: Pick<MeasurementReminder, "nextDueAt"> | null;
};

export function toEncounterDTO(
  row: EncounterWithRelations,
  links?: EncounterLinksDTO,
  skipped?: RestoreSkipSummary,
): EncounterDTO {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    status: row.status,
    kind: row.kind,
    practitioner: row.practitioner ? toPractitionerDTO(row.practitioner) : null,
    reason: decryptField(row.reasonEncrypted, "reason"),
    outcome: decryptField(row.outcomeEncrypted, "outcome"),
    bodySite: decryptField(row.bodySiteEncrypted, "bodySite"),
    laterality: row.laterality,
    reminderNextDueAt: row.reminder?.nextDueAt?.toISOString() ?? null,
    ...(links ? { links } : {}),
    ...(skipped ? { skipped } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The list response.
 *
 * Two arrays rather than one sorted list, resolved server-side: "what is
 * coming up" and "what happened" are read in opposite directions, and making
 * the client split and re-sort one array would put that decision in two
 * places. Each row carries its links, for the reasons stated at
 * `EncounterDTO.links`.
 */
export interface EncounterListDTO {
  upcoming: EncounterDTO[];
  past: EncounterDTO[];
}

/** One body site and side the procedure history holds, with how often. */
export interface BodySiteFacetDTO {
  /** The first spelling seen; the facet itself is keyed case-insensitively. */
  bodySite: string;
  laterality: Laterality | null;
  count: number;
}

/**
 * The procedure history response.
 *
 * `procedures` is the filtered list, newest first. `bodySites` and `total` are
 * computed over the whole history, before the filter, so the filter choices a
 * client offers never shrink to the one it just picked.
 */
export interface ProcedureListDTO {
  procedures: EncounterDTO[];
  bodySites: BodySiteFacetDTO[];
  total: number;
}
