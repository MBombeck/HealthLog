/**
 * Why a Coach step found nothing or failed: the one list behind the
 * `CoachStepReason` type and the `step` frame's schema.
 *
 * `outside_window`: no readings in the window read. `outside_reach`: readings
 * exist, all of them older than the lookback limit set for the Coach; the
 * answer names the limit, and a method entry says `outside_window` for it.
 *
 * Client-safe: no server import.
 */
export const COACH_STEP_REASONS = [
  "no_data",
  "outside_window",
  "outside_reach",
  "module_disabled",
  "retrieval_failed",
  "invalid_arguments",
] as const;
