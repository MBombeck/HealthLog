/**
 * v1.37.0 — the vocabulary a scoped grant is written in.
 *
 * A grant may open the whole record, or it may open some of it. This file
 * holds the closed set of names the second case is allowed to use, and it
 * holds nothing else: no predicate, no storage, no route knowledge. The
 * predicates live in `grants.ts` beside the rest of what a grant means, and
 * the per-route classification lives on the call sites, frozen by
 * `src/__tests__/sharing-surface-guard.test.ts`.
 *
 * Two properties are the whole reason the file exists separately.
 *
 *   * **It is a sharing vocabulary, not the module vocabulary.** There is no
 *     conversion to `ModuleKey`, no import from `src/lib/modules/`, and there
 *     never is one. The two masks answer different questions — "did the owner
 *     turn this part of the product on" and "did the owner open this part of
 *     their record to that person" — and a route carrying both runs both. The
 *     day they share a spelling is the day somebody makes one of them imply
 *     the other, and the implication would run in the dangerous direction: a
 *     module the owner enabled is not a section the owner shared.
 *   * **The names are the ones a consent screen can say out loud.** They were
 *     derived by clustering the delegable read surfaces the product already
 *     has, not by inventing categories, so each one is a thing a person
 *     recognises as one thing. Finer splits subjects nobody separates (lab
 *     results from the analyte list); coarser re-merges the exact split
 *     somebody asked for.
 *
 * A stored scope never grows by release. A grant written when this list held
 * eight names opens those of the eight it named and nothing added later: the
 * set is stored as the keys the owner ticked, and a key that did not exist
 * when they ticked cannot be in it. That is why a new domain is a consent
 * question rather than a schema question.
 */

/**
 * The sections of a record a grant can be narrowed to.
 *
 * Order is the consent screen's reading order, not an ordering of weight —
 * nothing here ranks above anything else, and no code may treat the index as
 * meaning anything.
 */
export const SHARE_DOMAINS = [
  /** Readings: weight, blood pressure, pulse, glucose, sleep, workouts, nutrients, tracked values. */
  "measurements",
  /** The medication list, its schedules, doses, side effects and inventory. */
  "medications",
  /** Lab results and the biomarker catalogue behind them. */
  "labs",
  /**
   * Health background: allergies, family history, anamnesis facts, visits and
   * practitioners, and the immunization history.
   *
   * Visits joined this domain rather than getting one of their own, and the
   * cost is worth naming: somebody granted `profile` so a relative could see
   * an allergy list also gains the record of every appointment and the address
   * book behind it. The mitigation is not this comment — it is the consent
   * copy, which names visits in all six locales, so the widening is stated
   * where it is agreed to rather than inferred from the code.
   *
   * The immunization log joined on the same argument and carries the same
   * cost, stated the same way: a delegate holding this domain for the allergy
   * list also sees every dose the person has had, and the consent copy names
   * it. Vaccinations are a tracked clinical vertical with their own module
   * toggle, which is a separate question from consent — a module the owner
   * enabled is not a section the owner shared, and a person granting health
   * background is granting the section whether or not the surfaces are on.
   */
  "profile",
  /** Illness episodes and the day logs under them. */
  "illness",
  /**
   * Mood entries and mental-health screener history.
   *
   * One write in this section lands outside it, and the consent copy names it:
   * completing a screener also files the instrument's total as a `COMPUTED`
   * measurement, so the trend reads through the chart and rollup tier without
   * the encrypted item content going anywhere. It is a projection of the
   * administration rather than a second reading, and withholding it would file
   * a screener whose own total is missing from the record.
   */
  "mind",
  /** Cycle tracking. */
  "cycle",
  /** The document vault. */
  "documents",
] as const;

/** One section of a record. */
export type ShareDomain = (typeof SHARE_DOMAINS)[number];

/**
 * The distinguished value for "the entire record", which is what every grant
 * written before this release was consented as.
 *
 * It is deliberately NOT a member of {@link SHARE_DOMAINS}: a scoped grant
 * naming it would be a scope that means "no scope", and the one thing a
 * narrowing must never be able to express is its own absence. A route
 * declaring `record` is a route that reads across sections, and a scoped
 * grant never reaches one.
 */
export const ENTIRE_RECORD = "record";

/**
 * What a delegable route declares it touches: one section, or the record as a
 * whole.
 */
export type ShareScope = ShareDomain | typeof ENTIRE_RECORD;

const DOMAIN_SET: ReadonlySet<string> = new Set<string>(SHARE_DOMAINS);

/**
 * Is this a section name?
 *
 * The one place an untrusted string becomes a {@link ShareDomain}. `record`
 * answers false here on purpose — see {@link ENTIRE_RECORD}.
 */
export function isShareDomain(value: unknown): value is ShareDomain {
  return typeof value === "string" && DOMAIN_SET.has(value);
}
