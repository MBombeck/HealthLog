/**
 * "Dose 3 of 3", derived once, on the server, per component antigen.
 *
 * The number beside a dose is not a property of that dose. It is a property of
 * the person's whole history for the antigen in question, which means it can
 * only be computed by something that can see all of it — and it must be
 * computed in exactly one place, or the web client, the native client and the
 * doctor report each answer the question slightly differently. So this
 * function resolves it once and the result rides the DTO as numbers. No client
 * re-derives, and no localised string crosses the wire: six locales must not
 * ride the API.
 *
 * ── The component axis ─────────────────────────────────────────────────────
 *
 * A combined dose counts into EVERY antigen series it contains, at whatever
 * position each of those series happens to be at. A history of Td, Td, Tdap
 * puts that last dose at tetanus position 3 and pertussis position 1, and both
 * are true at once. Grouping by the record's own slug instead of by its
 * components is the failure mode this whole design exists to avoid: it would
 * report an adult with three tetanus doses as having had one.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 * It does not adjudicate a schedule. Whether dose 2 came at the right interval
 * after dose 1, whether a gap invalidates a series, whether a person is due
 * anything at all — none of that is here, and none of it is anywhere in this
 * module. Unsolicited due-computation from age, sex and history is where the
 * medical-device boundary starts, and it is a separate venture's territory.
 * What this function reports is arithmetic on what a person wrote down.
 */
import type { AntigenSlug } from "@/lib/vaccinations/vaccine-catalog";
import {
  resolveVaccineEntry,
  type CustomVaccineLookup,
} from "@/lib/vaccinations/resolve-vaccine-entry";

/** One antigen's view of one dose. */
export interface SeriesPosition {
  /** The component antigen this entry speaks for. */
  antigen: AntigenSlug;
  /**
   * Where this dose sits in that antigen's series. Prefers the number the
   * person transcribed from their Pass; falls back to the chronological index
   * among their own doses for the antigen.
   */
  position: number;
  /**
   * How long the series is: the record's own override first, then the
   * catalogue's (or the person's own definition's) typical value, then null
   * when neither knows. Null is honest —
   * a seasonal vaccine has no "of M".
   */
  total: number | null;
  /**
   * True once the series is complete and this dose comes after it. The client
   * renders "booster" rather than a position out of a total it has passed.
   */
  booster: boolean;
}

/** The minimum a record has to carry to be placed in a series. */
export interface SeriesInputRecord {
  id: string;
  occurredAt: Date;
  antigenSlug: string | null;
  /** The person's own definition (v1.42, #1005), resolved after the slug. */
  customVaccineId?: string | null;
  doseNumber: number | null;
  seriesDoses: number | null;
}

/**
 * Resolve every record's series positions, per component antigen.
 *
 * Takes the whole live set rather than one record because the answer for any
 * single dose depends on the ones around it. Returns a map keyed by record id
 * so a caller can attach the result to a DTO without re-scanning.
 *
 * Total, in the mathematical sense: every input id is a key in the output, and
 * a record with no resolvable antigen maps to an empty array rather than being
 * absent. A caller that reads a missing key as "no series" and a caller that
 * reads it as "not computed yet" would disagree about the same dose.
 */
export function deriveSeries(
  records: readonly SeriesInputRecord[],
  customs?: CustomVaccineLookup,
): Map<string, SeriesPosition[]> {
  const result = new Map<string, SeriesPosition[]>();
  for (const record of records) result.set(record.id, []);

  // Oldest first: a position is a count of what came before it, and ties break
  // on id so two doses recorded for the same day are ordered deterministically
  // rather than by whatever the query happened to return.
  const chronological = [...records].sort((a, b) => {
    const byDate = a.occurredAt.getTime() - b.occurredAt.getTime();
    return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
  });

  /** How many doses of each antigen have been seen so far in the walk. */
  const seen = new Map<AntigenSlug, number>();

  for (const record of chronological) {
    // A free-text-only record — and a record whose slug the catalogue no
    // longer resolves, or whose own definition was removed — yields nothing.
    // Guessing an antigen from a name string is how a booster gets cleared by
    // a dose that never contained it.
    const entry = resolveVaccineEntry(record, customs);
    const components = entry?.components ?? [];
    if (components.length === 0) continue;

    const catalogTotal = entry?.typicalSeriesDoses ?? null;
    // The record's own override wins: it is what the person's actual schedule
    // was, and the catalogue only knows the typical one.
    const total = record.seriesDoses ?? catalogTotal;

    const positions: SeriesPosition[] = [];
    for (const antigen of components) {
      const index = (seen.get(antigen) ?? 0) + 1;
      seen.set(antigen, index);
      // The Pass's own claim wins over the count. Someone transcribing
      // "3. Impfung" from a page whose earlier lines they never entered is
      // right about their own history and this arithmetic is not.
      const position = record.doseNumber ?? index;
      positions.push({
        antigen,
        position,
        total,
        booster: total !== null && position > total,
      });
    }
    result.set(record.id, positions);
  }

  return result;
}

/**
 * The same answer for one record, against a history.
 *
 * A convenience over {@link deriveSeries} for the detail route, which holds
 * one record and needs the set it belongs to anyway. Returns an empty array
 * for a record the history does not contain, rather than deriving a lonely
 * position that would contradict the list.
 */
export function seriesForRecord(
  recordId: string,
  history: readonly SeriesInputRecord[],
  customs?: CustomVaccineLookup,
): SeriesPosition[] {
  return deriveSeries(history, customs).get(recordId) ?? [];
}
