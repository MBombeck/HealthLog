/**
 * The visit and vaccination links a document DTO carries. Plain types, kept
 * apart from the schema module (`src/lib/validations/inbound-documents.ts`,
 * which re-exports them) so it stays a size a reader can hold.
 */

/**
 * One visit link on a document DTO — "this letter belongs to that appointment".
 *
 * Carries the visit's KIND as the enum constant rather than a rendered name.
 * A condition's label is the person's own words and reads the same in every
 * language; a visit kind is one of eight closed values whose human name the
 * reader's own bundle owns, so publishing the constant is what lets a German
 * reader and an English one each see it named correctly. The date and the id
 * are resolved server-side as usual.
 */
export interface DocumentEncounterLinkDto {
  encounterId: string;
  /** `ROUTINE` | `ACUTE` | … — the client renders the name. */
  kind: string;
  /** ISO-8601 instant of the visit. */
  occurredAt: string | null;
}

/**
 * One vaccination link on a document detail DTO — "this page records that
 * dose".
 *
 * `catalogSlug` is the catalogue entry when this release still knows the
 * dose's slug, so the reader's own bundle names it
 * (`vaccinations.catalog.<slug>`); `null` is the signal to show
 * `vaccineName`, the person's own wording. The same degrade the vaccination
 * DTO's `catalogEntry: null` carries.
 */
export interface DocumentVaccinationLinkDto {
  vaccinationId: string;
  /** ISO-8601 instant of the dose (UTC midnight — a Pass carries dates). */
  occurredAt: string | null;
  catalogSlug: string | null;
  vaccineName: string | null;
}
