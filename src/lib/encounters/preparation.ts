/**
 * Where the window before a booked visit starts, and why.
 *
 * The visit preparation ("what happened since the last visit") and the doctor
 * report offered for an appointment both need a start date. It used to be the
 * last visit of any kind: a person seeing an internist on one day and a
 * dermatologist a week later was offered a one-week report for the
 * dermatologist, covering nothing that visit is about.
 *
 * The rule, first match wins, over the visits that took place (DONE) before
 * the booked one:
 *
 *   1. practitioner  — the last visit with the same practitioner;
 *   2. specialty     — else the last visit with a practitioner of the same
 *                      specialty (the free-text field, compared without case
 *                      or extra spaces, so "Dermatology" and "dermatology "
 *                      match and "Dermatology" and "Skin doctor" do not);
 *   3. kind          — else the last visit of the same kind, for the kinds that
 *                      name one line of care (routine, preventive, therapy);
 *   4. default       — else the last {@link PREPARATION_DEFAULT_DAYS} days.
 *
 * The other kinds never match by kind alone. A specialist visit says nothing
 * about which specialty (that is what rule 2 is for), "other" is the default
 * nobody picked, and an acute visit, an emergency, a hospital stay or a
 * procedure is an event rather than a recurring line of care, so the last one
 * is no better a start than the default.
 *
 * The window starts on the matched visit's own day: a dose changed at that
 * visit belongs to what the next one should know. It covers at most
 * {@link REPORT_MAX_RANGE_DAYS} days, the longest report the export
 * produces: a matched visit further back moves `from` to the first day of
 * that stretch and sets `capped`, so the report offered for the visit is the
 * one the export builds.
 *
 * Resolved on the server, published on the visit list, never recomputed by a
 * client. A person can still change both dates on the report.
 *
 * Pure and client-safe; the read lives in `preparation-read.ts`.
 */
import type { EncounterKind } from "@/generated/prisma/client";
import { REPORT_MAX_RANGE_DAYS } from "@/lib/doctor-report-range";
import { daysBetweenDateKeys, shiftDateKey, userDayKey } from "@/lib/tz/format";

/** The window when no earlier visit matches the booked one. */
export const PREPARATION_DEFAULT_DAYS = 90;

/** The kinds a visit is matched on when neither practitioner nor specialty is. */
export const PREPARATION_KIND_MATCHES = [
  "ROUTINE",
  "PREVENTIVE",
  "THERAPY",
] as const satisfies readonly EncounterKind[];

export const PREPARATION_BASES = [
  "practitioner",
  "specialty",
  "kind",
  "default",
] as const;

export type PreparationBasis = (typeof PREPARATION_BASES)[number];

/** The earlier visit the window starts at. */
export interface PreparationAnchorDTO {
  id: string;
  occurredAt: string;
  kind: EncounterKind;
  practitionerName: string | null;
  specialty: string | null;
}

/** The window before one booked visit, resolved. */
export interface EncounterPreparationDTO {
  /** First day of the window, `YYYY-MM-DD` on the record's own calendar. */
  from: string;
  /** The booked visit's own day, on the same calendar as `from`. */
  to: string;
  /** Which rule chose `from`. */
  basis: PreparationBasis;
  /**
   * The visit the window is measured from; null on `default`. `from` is its
   * day unless `capped`.
   */
  since: PreparationAnchorDTO | null;
  /**
   * True when `since` lies further back than a report covers and `from` was
   * moved to the first day of the last {@link REPORT_MAX_RANGE_DAYS} days
   * before `to`.
   */
  capped: boolean;
}

/** The fields the rule reads, off a booked visit or an earlier one. */
export interface PreparationVisit {
  id: string;
  occurredAt: Date;
  kind: EncounterKind;
  practitionerId: string | null;
  practitioner: { name: string; specialty: string | null } | null;
}

/** A specialty as compared: no case, no outer or doubled spaces. */
export function specialtyKey(value: string | null | undefined): string | null {
  const key = value
    ?.normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
  return key ? key : null;
}

/**
 * The window before `next`.
 *
 * `done` is the record's visits that took place, newest first. Only those
 * before `next` are considered; `today` (the record's local day) anchors the
 * default window.
 */
export function resolvePreparation(args: {
  next: PreparationVisit;
  done: readonly PreparationVisit[];
  tz: string;
  today: string;
}): EncounterPreparationDTO {
  const { next, tz, today } = args;
  const to = userDayKey(next.occurredAt, tz);
  const earlier = args.done.filter(
    (visit) =>
      visit.id !== next.id &&
      visit.occurredAt.getTime() < next.occurredAt.getTime(),
  );
  const specialty = specialtyKey(next.practitioner?.specialty);
  const kindMatches = (
    PREPARATION_KIND_MATCHES as readonly EncounterKind[]
  ).includes(next.kind);

  const rules: Array<[PreparationBasis, (visit: PreparationVisit) => boolean]> =
    [
      [
        "practitioner",
        (visit) =>
          next.practitionerId !== null &&
          visit.practitionerId === next.practitionerId,
      ],
      [
        "specialty",
        (visit) =>
          specialty !== null &&
          specialtyKey(visit.practitioner?.specialty) === specialty,
      ],
      ["kind", (visit) => kindMatches && visit.kind === next.kind],
    ];

  for (const [basis, matches] of rules) {
    const hit = earlier.find(matches);
    if (!hit) continue;
    const day = userDayKey(hit.occurredAt, tz);
    // Both end days count: `from` to `to` spans at most the report's days.
    const capped = daysBetweenDateKeys(day, to) > REPORT_MAX_RANGE_DAYS - 1;
    return {
      from: capped ? shiftDateKey(to, -(REPORT_MAX_RANGE_DAYS - 1)) : day,
      to,
      basis,
      capped,
      since: {
        id: hit.id,
        occurredAt: hit.occurredAt.toISOString(),
        kind: hit.kind,
        practitionerName: hit.practitioner?.name ?? null,
        specialty: hit.practitioner?.specialty?.trim() || null,
      },
    };
  }
  return {
    from: shiftDateKey(today, -PREPARATION_DEFAULT_DAYS),
    to,
    basis: "default",
    since: null,
    capped: false,
  };
}
