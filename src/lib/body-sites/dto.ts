/**
 * Wire shapes of `GET /api/body-sites` (v1.39.2).
 *
 * Type-only, so the client imports it without pulling the loader's Prisma
 * graph into a bundle.
 */
import type { Laterality } from "@/generated/prisma/client";
import type { EncounterDTO, EncounterLinkDTO } from "@/lib/encounters/dto";

/** How many records sit on one side of a site. `null` is "side not stated". */
export interface BodySiteSideDTO {
  laterality: Laterality | null;
  count: number;
}

/**
 * One site the record holds, across procedures and conditions.
 *
 * Keyed on the folded text, so "Knee" and "knee " are one site; `bodySite` is
 * the first spelling met, newest record first. The two counts are per kind so
 * a client can say what is there without a second read.
 */
export interface BodySiteDTO {
  bodySite: string;
  procedures: number;
  conditions: number;
  sides: BodySiteSideDTO[];
}

/**
 * A condition at the picked site, with what is filed against it.
 *
 * No note: the view answers "what is at this site", and the note is read on
 * the condition's own page. `documents` are redacted per entry when the
 * caller's grant does not cover the vault, like a visit's links.
 */
export interface BodySiteConditionDTO {
  id: string;
  label: string;
  type: string;
  lifecycle: string;
  onsetAt: string;
  resolvedAt: string | null;
  bodySite: string | null;
  laterality: Laterality | null;
  links: {
    documents: EncounterLinkDTO[];
    visits: EncounterLinkDTO[];
  };
}

/** What is filed at one site, when the request names one. */
export interface BodySiteSelectionDTO {
  bodySite: string;
  laterality: Laterality | null;
  /**
   * Visits carrying the site, newest first, each with its links. Procedures in
   * practice: the visit form offers the site for a procedure and keeps it on
   * any visit that already has one.
   */
  visits: EncounterDTO[];
  /**
   * Conditions at the site, newest onset first. `null`, not `[]`, when the
   * caller may not read conditions in this record (a grant without the
   * illness section) or the record has the illness module off: the list was
   * not consulted, which is different from a list that came back empty.
   */
  conditions: BodySiteConditionDTO[] | null;
}

export interface BodySiteListDTO {
  /** Every site the caller may see, most records first. */
  sites: BodySiteDTO[];
  /** Present only when the request named a site. */
  selection?: BodySiteSelectionDTO;
}
