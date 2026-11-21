/**
 * The ActivityKit content-state the server sends when it ends a medication
 * Live Activity.
 *
 * It is a wire contract with the iOS app's
 * `MedicationActivityAttributes.ContentState`, whose decoder is synthesised:
 * every non-optional field is required, defaults included, so a key the
 * server leaves out fails the decode and the push does nothing. The earlier
 * `"content-state": {}` failed on the first key. The app's struct and this
 * builder are held to the same list of keys by
 * `live-activity-content-state.test.ts`.
 *
 * Dates travel the way ActivityKit's default decoder reads them: seconds
 * since 2001-01-01T00:00:00Z (Foundation's reference date), not Unix seconds.
 * No health data rides along; the push token addresses the Activity.
 */

/** Unix seconds of Foundation's reference date, 2001-01-01T00:00:00Z. */
const APPLE_REFERENCE_EPOCH_S = 978_307_200;

export function appleReferenceSeconds(at: Date): number {
  return at.getTime() / 1000 - APPLE_REFERENCE_EPOCH_S;
}

export type LiveActivityTimeFormat = "AUTO" | "H12" | "H24";

export interface MedicationLiveActivityContentState {
  status: "pending" | "taken" | "snoozed";
  countdownTarget: number;
  confirmed: boolean;
  pendingConfirm: boolean;
  isOverdue: boolean;
  timeFormatRaw: LiveActivityTimeFormat;
}

/**
 * The final state of an Activity the server ends because its dose was
 * answered elsewhere. The Activity is dismissed at once, so the state only
 * has to decode and read as done.
 */
export function endedMedicationContentState(input: {
  resolvedAt: Date;
  timeFormat: LiveActivityTimeFormat | null | undefined;
}): MedicationLiveActivityContentState {
  return {
    status: "taken",
    countdownTarget: appleReferenceSeconds(input.resolvedAt),
    confirmed: false,
    pendingConfirm: false,
    isOverdue: false,
    timeFormatRaw: input.timeFormat ?? "AUTO",
  };
}
