/**
 * Telegram's "Remind me later" on a dose reminder: `snooze:{medicationId}:{minutes}`.
 *
 * The reminder's button carries the person's snooze length
 * (`notificationPrefs.medication.snoozeMinutes`, the one value the web card
 * and the app use); a button from an older message (the former 1 h / 3 h
 * pair) still answers with its own minutes. Either way the minutes are held
 * to the setting's range, so a hand-made callback cannot park a medication
 * for days.
 */
import { snoozeData } from "@/lib/medications/snooze-scope";
import { afterDoseChange } from "@/lib/medications/after-dose-change";
import { prisma } from "@/lib/db";
import { findTelegramDoseMedication } from "@/lib/telegram-dose-medications";
import {
  MAX_SNOOZE_MINUTES,
  MIN_SNOOZE_MINUTES,
} from "@/lib/medications/snooze-length";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** The minutes a snooze callback asks for, held to the range; NaN when absent. */
export function snoozeMinutesOfCallback(data: string): number {
  const asked = parseInt(data.split(":")[2] ?? "", 10);
  return Number.isFinite(asked)
    ? Math.min(Math.max(asked, MIN_SNOOZE_MINUTES), MAX_SNOOZE_MINUTES)
    : NaN;
}

export async function answerDoseSnooze(input: {
  data: string;
  user: { id: string; timezone: string | null };
  t: Translate;
  /** Answer the callback with this text. */
  reply: (text: string) => Promise<unknown>;
  /** After the snooze: drop the reminder message and its tracking. */
  done: (medicationId: string) => Promise<void>;
}): Promise<void> {
  const { data, user, t, reply, done } = input;
  const medicationId = data.split(":")[1];
  const minutes = snoozeMinutesOfCallback(data);
  if (!medicationId || !Number.isFinite(minutes)) {
    await reply(t("telegram.errorInvalidAction"));
    return;
  }
  const medication = await findTelegramDoseMedication(user.id, user.timezone, {
    id: medicationId,
  });
  if (!medication) {
    await reply(t("telegram.errorMedicationNotFound"));
    return;
  }
  await prisma.medication.update({
    where: { id: medication.id },
    data: snoozeData(new Date(Date.now() + minutes * 60000)),
  });
  // The snoozed dose is no longer due on the phone either.
  afterDoseChange({ userId: user.id, scope: "intakes" });
  await reply(
    t("telegram.snoozedFor", {
      name: medication.name,
      duration: t("telegram.snoozeMinutes", { minutes }),
    }),
  );
  await done(medicationId);
}
