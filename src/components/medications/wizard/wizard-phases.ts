/**
 * The four phases the medication wizard's progress band shows: Medication,
 * Dose, Schedule, Review. The eight raw steps stay as they are; this table
 * only says which segment each one fills and how far.
 *
 * The fill is read from the raw step, never from the cadence path, so it
 * cannot move when the person picks a cadence: on step 5 the band reads the
 * same before and after "Every day", and stepping back to step 4 after "Just
 * once" shows the quarter it showed on the way in.
 */
export const MEDICATION_PHASES = [
  "medication",
  "dose",
  "schedule",
  "review",
] as const;

export type MedicationPhase = (typeof MEDICATION_PHASES)[number];

const STEP_PHASE: Record<number, { phase: number; fraction: number }> = {
  1: { phase: 0, fraction: 0.5 },
  2: { phase: 0, fraction: 1 },
  3: { phase: 1, fraction: 1 },
  4: { phase: 2, fraction: 0.25 },
  5: { phase: 2, fraction: 0.5 },
  6: { phase: 2, fraction: 0.75 },
  7: { phase: 2, fraction: 1 },
  8: { phase: 3, fraction: 1 },
};

/**
 * The raw step a tap on a phase segment lands on. Each is on every cadence
 * path (one-shot and as-needed skip only 5 to 7), so a jump never lands
 * off-path.
 */
export const PHASE_LANDING_STEP: readonly number[] = [1, 3, 4, 8];

/** The phase index and the fill of its segment for a raw step (1 to 8). */
export function phaseForStep(step: number): {
  phase: number;
  fraction: number;
} {
  return STEP_PHASE[step] ?? { phase: 0, fraction: 0 };
}
