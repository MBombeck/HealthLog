/**
 * Reminder phase resolution logic.
 * Determines which phase a medication schedule is in based on
 * current time relative to the schedule window end.
 */

export type ReminderPhase = "GREEN" | "YELLOW" | "ORANGE" | "RED";
export type PhaseMode = "MINUTES" | "PERCENT";

export interface PhaseConfig {
  greenValue: number;
  greenMode: PhaseMode;
  yellowValue: number;
  yellowMode: PhaseMode;
  orangeValue: number;
  orangeMode: PhaseMode;
  redValue: number;
  redMode: PhaseMode;
}

export const DEFAULT_PHASE_CONFIG: PhaseConfig = {
  greenValue: 60,
  greenMode: "MINUTES",
  yellowValue: 30,
  yellowMode: "MINUTES",
  orangeValue: 0,
  orangeMode: "MINUTES",
  redValue: 240,
  redMode: "MINUTES",
};

/**
 * Convert a phase value to absolute minutes using the window duration.
 */
function resolveMinutes(
  value: number,
  mode: PhaseMode,
  windowDurationMin: number,
): number {
  if (mode === "PERCENT") {
    return Math.round((value / 100) * windowDurationMin);
  }
  return value;
}

/**
 * Resolve all phase thresholds to absolute minutes.
 * "Before" phases (green, yellow): minutes before window end.
 * "After" phases (orange, red): minutes after window end.
 */
export function resolvePhaseThresholds(
  config: PhaseConfig,
  windowDurationMin: number,
): {
  greenMinBefore: number;
  yellowMinBefore: number;
  orangeMinAfter: number;
  redMinAfter: number;
} {
  return {
    greenMinBefore: resolveMinutes(
      config.greenValue,
      config.greenMode,
      windowDurationMin,
    ),
    yellowMinBefore: resolveMinutes(
      config.yellowValue,
      config.yellowMode,
      windowDurationMin,
    ),
    orangeMinAfter: resolveMinutes(
      config.orangeValue,
      config.orangeMode,
      windowDurationMin,
    ),
    redMinAfter: resolveMinutes(
      config.redValue,
      config.redMode,
      windowDurationMin,
    ),
  };
}

/**
 * Determine the current phase for a schedule based on minutes to window end.
 *
 * @param minutesToEnd - Positive = before window end, negative = after window end
 * @param minutesFromStart - Minutes since window start (negative = before window start)
 * @param thresholds - Resolved absolute-minute thresholds
 * @returns The current phase, or null if no phase applies yet
 */
export function determinePhase(
  minutesToEnd: number,
  minutesFromStart: number,
  thresholds: ReturnType<typeof resolvePhaseThresholds>,
): ReminderPhase | null {
  const minutesPastEnd = -minutesToEnd;

  // After window end
  if (minutesToEnd < 0) {
    if (minutesPastEnd >= thresholds.redMinAfter) return "RED";
    if (minutesPastEnd >= thresholds.orangeMinAfter) return "ORANGE";
    return "ORANGE";
  }

  // Before window end
  if (minutesToEnd <= thresholds.yellowMinBefore) return "YELLOW";
  if (
    minutesToEnd <= thresholds.greenMinBefore &&
    minutesFromStart >= 0 // Don't fire green before window start
  ) {
    return "GREEN";
  }

  return null; // Not in any phase yet
}

/**
 * Get the message template for a phase.
 */
export function getPhaseMessage(
  phase: ReminderPhase,
  medName: string,
  doseInfo: string,
  timeWindow: string,
  minutesToEnd: number,
): { title: string; message: string } {
  const minutesPastEnd = -minutesToEnd;
  const absMinutes = Math.abs(minutesToEnd);

  switch (phase) {
    case "GREEN":
      return {
        title: `🟢 Erinnerung: ${medName}`,
        message: `🟢 Erinnerung:\n<b>${medName}</b> (${doseInfo}, ${timeWindow})\nZeitfenster endet in ${absMinutes} Min.`,
      };
    case "YELLOW":
      return {
        title: `🟡 Bald fällig: ${medName}`,
        message: `🟡 Bald fällig:\n<b>${medName}</b> (${doseInfo}, ${timeWindow})\nNoch ${absMinutes} Min. Zeit.`,
      };
    case "ORANGE":
      return {
        title: `🟠 Überfällig: ${medName}`,
        message: `🟠 Überfällig:\n<b>${medName}</b> (${doseInfo}, ${timeWindow})\nSeit ${minutesPastEnd} Min. überfällig.`,
      };
    case "RED":
      return {
        title: `🔴 Verpasst: ${medName}`,
        message: `🔴 Verpasst:\n<b>${medName}</b> (${doseInfo}, ${timeWindow})\nAls verpasst markiert.`,
      };
  }
}

/**
 * Get the inline keyboard for a phase.
 */
export function getPhaseKeyboard(
  phase: ReminderPhase,
  medicationId: string,
): { inline_keyboard: { text: string; callback_data: string }[][] } {
  if (phase === "RED") {
    return {
      inline_keyboard: [
        [
          { text: "Genommen", callback_data: `taken:${medicationId}` },
          { text: "✓ Bestätigen", callback_data: `ack:${medicationId}` },
        ],
      ],
    };
  }

  return {
    inline_keyboard: [
      [{ text: "Genommen", callback_data: `taken:${medicationId}` }],
      [
        { text: "🕐 1h", callback_data: `snooze:${medicationId}:60` },
        { text: "🕐 3h", callback_data: `snooze:${medicationId}:180` },
        { text: "⏭ Überspringen", callback_data: `skip:${medicationId}` },
      ],
    ],
  };
}
