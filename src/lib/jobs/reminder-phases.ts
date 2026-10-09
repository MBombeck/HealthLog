/**
 * Reminder phase resolution logic.
 * Determines which phase a medication schedule is in based on
 * current time relative to the schedule window end.
 */

import { coerceLocale, type Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";

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
 * The first phase a slot's window reaches, which is the reminder that
 * announces the dose; every later phase is a follow-up for a dose that is
 * still open.
 *
 * It is not always GREEN. GREEN needs the window to have opened AND to be
 * within `greenMinBefore` of its end, while YELLOW needs only the second
 * condition with the smaller `yellowMinBefore`. A window no longer than the
 * YELLOW lead (a point slot such as 07:00 to 07:00 is zero minutes long)
 * reaches YELLOW first and never shows GREEN, and so does any configuration
 * whose GREEN lead is not longer than its YELLOW lead.
 */
export function openingPhase(
  thresholds: ReturnType<typeof resolvePhaseThresholds>,
  windowDurationMin: number,
): ReminderPhase {
  if (
    windowDurationMin <= thresholds.yellowMinBefore ||
    thresholds.greenMinBefore <= thresholds.yellowMinBefore
  ) {
    return "YELLOW";
  }
  return "GREEN";
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
 * The reminder templates and the Telegram inline-keyboard labels are
 * translated in every shipped bundle, so the resolver admits every shipped
 * locale. It used to admit only de / en, which pushed a French, Spanish,
 * Italian or Polish account an English reminder on every channel.
 */
const resolveLocale = coerceLocale;

/**
 * Get the message template for a phase, localised to the recipient
 * user. Strings live in `messages/{de,en}.json` under
 * `medicationReminders.phase*`. The reminder worker passes the user's
 * stored locale; absent / unknown locales fall back to the app default.
 *
 * v1.4 marathon — closes the v3 audit "Locale-Mixing" CRIT finding
 * (German-only Telegram / Web Push templates regardless of user locale).
 */
export function getPhaseMessage(
  phase: ReminderPhase,
  medName: string,
  doseInfo: string,
  timeWindow: string,
  minutesToEnd: number,
  locale: Locale | string | null | undefined,
): { title: string; message: string } {
  const t = getServerTranslator(resolveLocale(locale)).t;
  const absMinutes = Math.abs(minutesToEnd);
  const minutesPastEnd = Math.max(0, -minutesToEnd);

  const params = (extra: Record<string, string | number>) => ({
    medName,
    doseInfo,
    timeWindow,
    ...extra,
  });

  switch (phase) {
    case "GREEN":
      return {
        title: t("medicationReminders.phaseGreenTitle", { medName }),
        message: t(
          "medicationReminders.phaseGreenMessage",
          params({ minutes: absMinutes }),
        ),
      };
    case "YELLOW":
      return {
        title: t("medicationReminders.phaseYellowTitle", { medName }),
        message: t(
          "medicationReminders.phaseYellowMessage",
          params({ minutes: absMinutes }),
        ),
      };
    case "ORANGE":
      return {
        title: t("medicationReminders.phaseOrangeTitle", { medName }),
        message: t(
          "medicationReminders.phaseOrangeMessage",
          params({ minutes: minutesPastEnd }),
        ),
      };
    case "RED":
      return {
        title: t("medicationReminders.phaseRedTitle", { medName }),
        message: t(
          "medicationReminders.phaseRedMessage",
          params({ minutes: 0 }),
        ),
      };
  }
}

/**
 * Get the inline keyboard for a phase. Button labels follow the user's
 * locale; callback_data values are stable English identifiers and must
 * NOT be translated (the bot dispatcher matches on them).
 */
export function getPhaseKeyboard(
  phase: ReminderPhase,
  medicationId: string,
  locale: Locale | string | null | undefined,
): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const t = getServerTranslator(resolveLocale(locale)).t;

  if (phase === "RED") {
    return {
      inline_keyboard: [
        [
          {
            text: t("medicationReminders.buttonTaken"),
            callback_data: `taken:${medicationId}`,
          },
          {
            text: t("medicationReminders.buttonConfirm"),
            callback_data: `ack:${medicationId}`,
          },
        ],
      ],
    };
  }

  return {
    inline_keyboard: [
      [
        {
          text: t("medicationReminders.buttonTaken"),
          callback_data: `taken:${medicationId}`,
        },
      ],
      [
        {
          text: t("medicationReminders.buttonSnoozeOneHour"),
          callback_data: `snooze:${medicationId}:60`,
        },
        {
          text: t("medicationReminders.buttonSnoozeThreeHours"),
          callback_data: `snooze:${medicationId}:180`,
        },
        {
          text: t("medicationReminders.buttonSkip"),
          callback_data: `skip:${medicationId}`,
        },
      ],
    ],
  };
}
