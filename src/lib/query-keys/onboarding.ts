/**
 * Query keys — the needs-based setup flow (v1.39 C2).
 * Part of the centralized factory; aggregated in `./index.ts`.
 *
 * The flow has no read of its own: its state rides `GET /api/auth/me` as
 * `onboarding`, so every screen reads `queryKeys.authMe()` and every write
 * below invalidates it. What lives here are the mutation keys, one per
 * endpoint, so a screen that persists an answer and a settings card that
 * restarts the flow cannot collide on an anonymous mutation.
 */
export const onboardingKeys = {
  /** `PATCH /api/onboarding/answers` — one step, answered or skipped. */
  onboardingAnswerMutation: () => ["onboarding", "answer"] as const,
  /** `POST /api/onboarding/complete` — the confirm screen, and "skip for now". */
  onboardingCompleteMutation: () => ["onboarding", "complete"] as const,
  /** `POST /api/onboarding/restart` — "Set up again", from Settings. */
  onboardingRestartMutation: () => ["onboarding", "restart"] as const,
  /** `POST /api/onboarding/disclaimer` — the one-time acknowledgment. */
  onboardingDisclaimerMutation: () => ["onboarding", "disclaimer"] as const,
  /**
   * The latest reading of one area, read back after the first-result step
   * logged it so the screen can show the value on its tile. Rides under the
   * `["measurements"]` prefix so `measurementDependentKeys` evicts it.
   */
  onboardingLatestReading: (area: string) =>
    ["measurements", "onboarding-latest", area] as const,
  /**
   * The upcoming-visit count the checklist's "prepare the visit" row reads
   * off the visits list's meta. Its own key under the `["encounters"]`
   * prefix: the list surfaces cache the rows under `encounters()`, and a
   * second `queryFn` shape on the same key would poison that cell, while
   * the prefix still lets `encounterDependentKeys` evict this one.
   */
  onboardingUpcomingVisits: () =>
    ["encounters", "onboarding-upcoming"] as const,
};
