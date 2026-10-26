/**
 * Query keys — opt-in mental-health screeners (PHQ-9 / GAD-7).
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const mentalHealthKeys = {
  /** The caller's screener history, optionally filtered by instrument. */
  mentalHealthAssessments: (instrument?: string) =>
    ["mental-health-assessments", instrument ?? null] as const,
  /** One administration with its decrypted per-item answers. */
  mentalHealthAssessmentDetail: (id: string) =>
    ["mental-health-assessment-detail", id] as const,
  /** Every questionnaire's text in one app language (a static chunk). */
  mentalHealthWording: (locale: string) =>
    ["mental-health-wording", locale] as const,
};
