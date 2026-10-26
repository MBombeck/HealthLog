/**
 * v1.25.3 — shared types for the opt-in mental-health screener surface.
 *
 * The 387-line monolith split into a folder of focused components; these are
 * the seams they plug into. The wire shapes mirror the assessment route's
 * `shapeRow` / create response (`src/app/api/mental-health/assessments/route.ts`)
 * — totals + bands + flags only on the list. The per-item answers ride ONLY
 * the per-administration detail read (`…/assessments/[id]`), which decrypts
 * them for the history's expandable answer breakdown.
 */
import type { InstrumentId } from "@/lib/mental-health/instruments";
import type { AssessmentWording } from "@/lib/mental-health/wording/types";

export type { InstrumentId };

export type Phase = "choose" | "form" | "result";

/** What a completed check-in submits. */
export interface CheckInAnswers {
  items: number[];
  /** The unscored PHQ-9 follow-up, when it was answered. */
  functionalDifficulty?: number;
  /** The reader answered in the English original of their language's text. */
  englishOriginal: boolean;
}

export interface AssessmentRow {
  id: string;
  instrument: InstrumentId;
  /** The reader's app language — re-derives crisis resources. */
  locale: string;
  /** Which text the answers were given in; null before v1.46 recorded it. */
  wording: AssessmentWording | null;
  totalScore: number;
  severityBand: string;
  item9Flagged: boolean;
  crisisShownAt: string | null;
  takenAt: string;
}

/**
 * One administration with its decrypted answers (`GET …/assessments/[id]`).
 * `items: null` + `itemsUnavailable` is the server's honest degrade for a row
 * whose blob cannot be decrypted — the score fields still answer.
 */
export interface AssessmentDetail extends AssessmentRow {
  items: number[] | null;
  /** The unscored PHQ-9 functional follow-up, when it was answered. */
  functionalDifficulty: number | null;
  itemsUnavailable: boolean;
}

export interface CrisisSet {
  emergencyNumber: string;
  resources: { id: string; contacts: string[] }[];
}

export interface CreateResponse {
  assessment: AssessmentRow;
  actionThreshold: number;
  crisis: CrisisSet | null;
}

/** v1.44 — `GET /api/mental-health/assessments` `trends[]` (`computeAssessmentTrends`). */
export interface AssessmentTrendDto {
  instrument: "PHQ9" | "GAD7" | "WHO5";
  n: number;
  threshold: number;
  higherIsBetter: boolean;
  first: { score: number; takenAt: string };
  previous: { score: number; takenAt: string } | null;
  latest: { score: number; takenAt: string };
  changeFromPrevious: number | null;
  changeFromFirst: number | null;
  sincePrevious: "improved" | "worsened" | "within_threshold" | null;
  sinceFirst: "improved" | "worsened" | "within_threshold" | null;
}
