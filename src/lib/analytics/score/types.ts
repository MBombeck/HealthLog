import type { BpTargets } from "@/lib/analytics/bp-targets";
import type { BpGrade, BpScoreBasis } from "@/lib/analytics/bp-grade";
import type {
  Derived,
  DerivedProvenanceSource,
} from "@/lib/insights/derived/types";
// Type-only, so the rule module can keep importing this one without a
// runtime cycle. The tier's definition belongs beside the rule that
// produces it; its NAME belongs here, where the wire shape is declared.
import type { ScoreBreadthTier } from "./breadth";
import type { GlucoseUnit } from "@/lib/glucose";

/**
 * The scoring method's identity.
 *
 * Moves whenever the method changes, which is what lets a stored day say
 * which rules produced it and lets each account be told once that the
 * rules moved (`healthScoreNoticeItemKey`). It is NOT the schema version
 * of the report.
 *
 * 4 — v1.38: three domains stopped being the price of admission. A score
 *     is computed from whatever is readable and says how broad that is
 *     (`scoreBasis`); only an account with nothing readable at all is
 *     refused. Accounts that were below the old floor start their series
 *     here, and no v3 number changes meaning — the arithmetic is the
 *     same, the set it runs over is what widened.
 * 3 — v1.35.1: green starts at 70 rather than 75, matching the two other
 *     scores in the app, and the fitness pillar left the catalogue.
 * 2 — the composite the previous line shipped.
 */
export const SCORE_VERSION = 4 as const;

/**
 * The pillars a score can be built from.
 *
 * v1.35.2 — FITNESS is gone. The schema records VO₂max but cannot tell a
 * measured test apart from a device estimate, so every FITNESS row
 * reached the scorer unproven and was refused: the pillar had never once
 * produced a value on any account. A pillar that cannot score is not a
 * choice, and listing it as one put chrome in front of a thing that
 * recomputes nothing. Reading it back is still safe — a stored recipe
 * naming it passes through `orderedUniquePillars`, which keeps only ids
 * this catalogue knows.
 */
export const SCORE_PILLAR_IDS = [
  "BLOOD_PRESSURE",
  "GLYCAEMIA",
  "ACTIVITY",
  "SLEEP",
  "ADIPOSITY",
  "WELLBEING",
  "LIPIDS",
] as const;

export type ScorePillarId = (typeof SCORE_PILLAR_IDS)[number];

/**
 * Sanitise a list of pillar ids: registry order, no duplicates, and
 * anything outside the catalogue dropped. Everything that narrows the
 * score's composition goes through here, so a stored blob, a caller's
 * argument and the scorer itself cannot disagree about what a valid
 * pillar set looks like.
 */
export function orderedUniquePillars(ids: readonly unknown[]): ScorePillarId[] {
  const present = new Set(ids);
  return SCORE_PILLAR_IDS.filter((id) => present.has(id));
}
export type ScoreBand = "green" | "yellow" | "red";
export type ScoreDomain =
  "cardiometabolic" | "activity" | "sleep" | "adiposity" | "wellbeing";

/**
 * Which domain each pillar speaks to. The composite recommends three
 * distinct domains and reports how many it had, so this map is part of
 * the breadth rule and not decoration: three of the seven pillars share
 * the cardiometabolic domain, which is why a selection of four pillars
 * can still be a one-area score.
 *
 * One map, read by the scorer when it builds a pillar result and by the
 * breadth rule when it judges a selection, so the two can never drift
 * into disagreeing about what counts as a distinct area.
 */
export const SCORE_PILLAR_DOMAINS: Record<ScorePillarId, ScoreDomain> = {
  BLOOD_PRESSURE: "cardiometabolic",
  GLYCAEMIA: "cardiometabolic",
  ACTIVITY: "activity",
  SLEEP: "sleep",
  ADIPOSITY: "adiposity",
  WELLBEING: "wellbeing",
  LIPIDS: "cardiometabolic",
};

/**
 * The three kinds of yardstick a pillar may be scored against, and there
 * is deliberately no fourth.
 *
 * Each names something published: a threshold a clinical body set, a band
 * drawn from a population distribution, a range a guideline recommends.
 * What is missing from the list is the kind this score spent two releases
 * removing — a target derived from the person's own profile that nobody
 * set and no surface named. The weight pillar once graded against
 * 22 × height², expanded by 2 kg either side, and it was the only thing
 * producing that pillar's band.
 *
 * A user's own yardstick is not excluded from the app, only from the
 * scored band: it rides `PillarValue.personalReference` and is shown
 * beside the reference rather than in place of it (blood pressure does
 * this today), or it stays unscored context entirely (the weight goal).
 *
 * A runtime list rather than a bare union, because
 * `reference-citation-guard.test.ts` checks emitted references against it
 * and a type alone disappears at runtime.
 */
export const PILLAR_REFERENCE_KINDS = [
  "clinical-threshold",
  "population-percentile",
  "guideline-band",
] as const;

export type PillarReferenceKind = (typeof PILLAR_REFERENCE_KINDS)[number];

export interface PillarObserved {
  value: number;
  unit: string;
  /** Complete display value, including paired or panel values where needed. */
  label: string;
  asOf: string;
  /** Persisted source labels that contributed to the observation. */
  sources: string[];
}

export interface PillarReference {
  kind: PillarReferenceKind;
  low: number | null;
  high: number | null;
  /** Complete display band for paired or multi-marker references. */
  label: string;
  /**
   * Who says so. A citation a reader could go and look up — a guideline
   * body and year ("ESH 2023"), the papers behind a plateau, or the
   * reporting laboratory whose ranges came with the panel. Never a
   * yardstick the app invented on the person's behalf; that is what the
   * guard beside this file exists to keep out.
   */
  source: string;
}

export interface PillarValue {
  score: number;
  observed: PillarObserved;
  reference: PillarReference;
  /** Optional user-authored yardstick, displayed beside the scored reference. */
  personalReference?: PillarReference;
  /**
   * Which input set this score and by how much, resolved on the server so
   * no client ever re-derives it. Blood pressure only for now: it is the
   * one pillar that scores the WORSE of two axes, so the number alone
   * cannot say which one it came from. Optional by design — a pillar that
   * has nothing of the kind to say says nothing.
   */
  scoreBasis?: BpScoreBasis;
  /** Score points that a weekly move must clear before it is narrated. */
  noiseFloor: number;
  /** Slow markers contribute to level but never to the weekly delta. */
  deltaEligible: boolean;
  /** Input/scoring mode identity used to form like-for-like deltas. */
  deltaIdentity: string;
}

export interface ScorePillarResult {
  id: ScorePillarId;
  domain: ScoreDomain;
  result: Derived<PillarValue>;
}

/**
 * v1.38 — what the number rests on, resolved on the server.
 *
 * The score is computed the same way at every breadth, so this block is
 * the only thing that tells a partial score apart from a full one. It is
 * resolved beside `configured` and for the same reason: no client
 * re-derives it, and no client counts domains out of `composition`
 * (three of the seven pillars share one area, so that count would be
 * wrong more often than right).
 *
 * `physiological` is a fact about the set, not a warning. An account
 * scoring on activity alone reads false and still gets its number; the
 * old rule refused that account outright and told it nothing.
 */
export interface ScoreBasis {
  /** Distinct domains counted. */
  domains: number;
  /** The breadth the method recommends — `SCORE_RECOMMENDED_DOMAINS`. */
  recommended: number;
  tier: ScoreBreadthTier;
  /** Whether any counted pillar rests on a physiological measurement. */
  physiological: boolean;
}

export interface CompositeValue {
  score: number;
  /**
   * The worse of the number's band and the worst counted pillar's band, the
   * meaning every shipped app colours the ring by. Stored per day.
   */
  band: ScoreBand;
  /**
   * 1.50: the band of the number alone, the rule every HealthLog score
   * follows. The web draws this and names `bandSetter` beside it.
   */
  numberBand: ScoreBand;
  /**
   * The worst counted pillar, when its band is worse than `numberBand`;
   * null otherwise. Exactly then `band` is worse than `numberBand`.
   */
  bandSetter: ScorePillarId | null;
  /** Registry-ordered eligible pillar ids. Part of the number's identity. */
  composition: ScorePillarId[];
  /**
   * v1.35.0 — the resolved "this score is configured" flag: true when the
   * account's composition differs from the one its defaults would resolve
   * to today. Server-resolved so no client interprets a config blob, and
   * never a per-pillar detail. `resolveScoreConfigured` in `./config`
   * owns the definition and the reasons behind it.
   */
  configured: boolean;
  /**
   * v1.38 — how broad the set behind the number is. Optional on the type
   * so an older cached composite or a fixture written before the field
   * existed stays valid (the additive-contract pattern the snapshot and
   * digest blocks have followed six times); `computeComposite` always
   * sets it on the ok arm.
   */
  scoreBasis?: ScoreBasis;
  /** Equal-weighted floor across delta-eligible pillars. */
  noiseFloor: number;
  scoreVersion: typeof SCORE_VERSION;
}

export type ScoreDeltaReason =
  | "algorithm_changed"
  /**
   * The person changed their own recipe inside the comparison window.
   * Distinct from `algorithm_changed` (we changed the method for
   * everybody) and from `composition_changed` (the two windows ended up
   * with different pillar sets): here both windows are computed under
   * the NEW recipe in one request, so the sets agree and the arithmetic
   * looks comparable when it is not. Without this reason the settings
   * action reads as a health event.
   */
  | "config_changed"
  | "composition_changed"
  | "first_eligibility_window"
  | "below_noise_floor"
  | "no_previous_window"
  | "no_current_score";

export interface WeightGoalValue {
  currentKg: number;
  target: { min: number; max: number };
  distanceKg: number;
  /** Positive means the distance to the personal band narrowed. */
  deltaKg: number | null;
  asOf: string;
  source: string;
}

export interface RestModeAnnotation {
  active: true;
  since: string | null;
  episodeCount: number;
}

export interface HealthScoreReport {
  composite: Derived<CompositeValue>;
  pillars: ScorePillarResult[];
  delta: number | null;
  deltaReason: ScoreDeltaReason | null;
  scoreVersion: typeof SCORE_VERSION;
  weightGoal: Derived<WeightGoalValue>;
  algorithmNotice: { itemKey: string; dismissed: boolean } | null;
  /**
   * v1.38 — a pillar joined or left the set behind the number since the
   * last day this account has a stored score for.
   *
   * The gap this closes: the delta is already suppressed on a composition
   * change, so nobody is told they dropped six points they did not drop —
   * and nobody is told anything at all. The level moves, the panel shows a
   * different number, and the cause is invisible. Under the adaptive
   * minimum that matters more rather than less: compositions are smaller
   * and sit closer to their floors, so a pillar rolling out of its window
   * is likelier.
   *
   * Absent rather than null on a payload written before the field existed,
   * which is why it is optional — the additive-contract pattern the
   * snapshot and digest blocks have followed six times. Null when there is
   * nothing to say: no prior stored day, an unchanged set, or a change the
   * method and recipe notice already owns.
   */
  compositionNotice?: ScoreCompositionNotice | null;
  restMode?: RestModeAnnotation | null;
}

/**
 * What left, what joined, and whether the person already said they saw it.
 *
 * Both lists are registry-ordered pillar ids, never localised strings: the
 * surfaces already own the pillar labels, and the reason a departed pillar
 * stopped counting is on that pillar's own row in the same report.
 *
 * The tier can move with the set (full to partial, or back) and this is
 * the notice for that too — the tier is a function of the composition, so
 * a second notice saying the same thing in other words would be two
 * announcements of one event.
 */
export interface ScoreCompositionNotice {
  /** `health-score:v<scoreVersion>:composition:<hash of the sorted set>`. */
  itemKey: string;
  /** Counted on the last stored day, not counted now. */
  left: ScorePillarId[];
  /** Counted now, not counted on the last stored day. */
  joined: ScorePillarId[];
  dismissed: boolean;
}

export interface DomainReadState {
  source: DerivedProvenanceSource;
  readFailed: boolean;
}

export interface BloodPressurePillarInput extends DomainReadState {
  asOf: Date;
  pairCount: number;
  /**
   * The graded score together with the basis that produced it — one
   * value, from one grading run against one set of targets.
   */
  graded: BpGrade | null;
  representative: { sys: number; dia: number } | null;
  oldestAt: Date | null;
  latestAt: Date | null;
  target: BpTargets | null;
  personalTarget?: BpTargets | null;
  sources: string[];
}

export interface HbA1cReading {
  value: number;
  unit: string;
  at: Date;
  source: string;
}

export interface GlucoseReading {
  value: number;
  at: Date;
  source: string;
}

export interface GlycaemiaPillarInput extends DomainReadState {
  asOf: Date;
  /**
   * The unit the fasting-glucose labels are written in. The scored value,
   * its `unit` and the reference band stay canonical mg/dL; only the two
   * human-readable labels follow the reader.
   */
  glucoseUnit: GlucoseUnit;
  hba1cReadFailed?: boolean;
  fastingReadFailed?: boolean;
  hba1c: HbA1cReading[];
  fastingGlucose: GlucoseReading[];
}

export interface ActivityDay {
  day: string;
  value: number;
}

export interface ActivityPillarInput extends DomainReadState {
  asOf: Date;
  timezone: string;
  ageYears: number | null;
  days: ActivityDay[];
  sources: string[];
}

export interface SleepPillarNight {
  night: string;
  asleepMinutes: number;
  midpoint: number | null;
}

export interface SleepPillarInput extends DomainReadState {
  asOf: Date;
  timezone: string;
  ageYears: number | null;
  nights: SleepPillarNight[];
  sources: string[];
}

export interface AdiposityReading {
  type: "WAIST_CIRCUMFERENCE" | "WAIST_TO_HEIGHT";
  value: number;
  unit: string;
  at: Date;
  source: string;
}

export interface AdiposityPillarInput extends DomainReadState {
  asOf: Date;
  heightCm: number | null;
  rows: AdiposityReading[];
}

export interface WellbeingAssessment {
  instrument: "PHQ9" | "GAD7" | "WHO5";
  totalScore: number;
  item9Flagged: boolean;
  at: Date;
}

export interface WellbeingPillarInput extends DomainReadState {
  asOf: Date;
  assessments: WellbeingAssessment[];
}

export interface LipidReading {
  marker: string;
  value: number;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  panel: string | null;
  at: Date;
  source: string;
}

export interface LipidsPillarInput extends DomainReadState {
  asOf: Date;
  rows: LipidReading[];
}

export interface PillarInputs {
  BLOOD_PRESSURE: BloodPressurePillarInput;
  GLYCAEMIA: GlycaemiaPillarInput;
  ACTIVITY: ActivityPillarInput;
  SLEEP: SleepPillarInput;
  ADIPOSITY: AdiposityPillarInput;
  WELLBEING: WellbeingPillarInput;
  LIPIDS: LipidsPillarInput;
}
