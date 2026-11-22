/**
 * The dose writes a Telegram button records: a take and a skip, each
 * converging onto the slot the reminder message names. Split out of
 * `telegram-webhook-handlers.ts` so the handlers stay dispatch; every write
 * here ends like a web write does (caches, the rollup of the day, the
 * cross-device intake sync).
 */
import { prisma } from "@/lib/db";
import { createAdHocIntake } from "@/lib/medications/ad-hoc-intake";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import { refreshDoseSlot } from "@/lib/medications/dose-day-refresh";
import {
  applyCanonicalSlotWrite,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
} from "@/lib/medications/scheduling/slot-upsert";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  consumeForIntake,
  restoreForIntake,
} from "@/lib/medications/inventory/consumption";
import { getUserTodayBounds, localHmAsUtc } from "@/lib/tz/local-day";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { afterDoseChange } from "@/lib/medications/after-dose-change";
import { findTelegramDoseMedication } from "@/lib/telegram-dose-medications";

/**
 * The slot a Telegram action should converge onto.
 *
 * The reminder context knows its own slot: the dispatcher records every
 * reminder message as a `TelegramReminderMessage` row carrying the
 * local `date` + `timeOfDay` of the dose it fired for. When the action
 * callback carries the chat/message ids, that row names the EXACT slot
 * — preferred over band attribution, which would orphan a confirmation
 * tapped hours after the reminder (band closed → ad-hoc) even though
 * the user is answering a specific dose prompt.
 *
 * Returns the canonical band anchor (validated against the schedule's
 * real slots), or `null` when no reminder row matches / the instant is
 * not a real slot — the caller then falls back to band attribution.
 */
async function resolveReminderSlot(input: {
  userId: string;
  medicationId: string;
  userTz: string;
  chatId: string;
  messageId: number;
}): Promise<Date | null> {
  const reminder = await prisma.telegramReminderMessage.findFirst({
    where: {
      recipientUserId: input.userId,
      medicationId: input.medicationId,
      chatId: input.chatId,
      messageId: input.messageId,
    },
    select: { date: true, timeOfDay: true },
  });
  if (!reminder) return null;
  const instant = reminderLocalInstant(
    reminder.date,
    reminder.timeOfDay,
    input.userTz,
  );
  if (!instant) return null;
  // Validate against the medication's real band anchors so a stale or
  // malformed reminder row can never park a dose on a non-slot instant.
  return resolveForcedSlotForWrite({
    userId: input.userId,
    medicationId: input.medicationId,
    userTz: input.userTz,
    slotInstant: instant,
  });
}

/**
 * Mint the UTC instant of local `timeOfDay` on the local calendar day
 * `date` (YYYY-MM-DD) in `tz`. Probes a reference instant a day either
 * side of UTC noon so the result is correct in every zone offset, then
 * derives the DST-correct instant via `localHmAsUtc`.
 */
function reminderLocalInstant(
  date: string,
  timeOfDay: string,
  tz: string,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(timeOfDay)) {
    return null;
  }
  const [hour, minute] = timeOfDay.split(":").map(Number);
  const base = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return null;
  for (const shiftDays of [0, -1, 1]) {
    const ref = new Date(base.getTime() + shiftDays * 24 * 60 * 60 * 1000);
    const parts = wallClockInTz(ref, tz);
    const localDay = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(
      parts.day,
    ).padStart(2, "0")}`;
    if (localDay === date) return localHmAsUtc(ref, tz, hour, minute);
  }
  return null;
}

export async function markMedicationTaken(
  userId: string,
  medicationId: string,
  idempotencyKey: string,
  locale: Locale,
  userTz: string | null,
  reminderRef?: { chatId: string; messageId: number },
): Promise<{ ok: boolean; message: string; medicationName?: string }> {
  const { t } = getServerTranslator(locale);
  const tz = userTz || DEFAULT_TIMEZONE;
  // The reminder's own slot, when the message names one: the course is
  // judged on that dose, not on the moment of the tap.
  const reminderSlot = reminderRef
    ? await resolveReminderSlot({
        userId,
        medicationId,
        userTz: tz,
        chatId: reminderRef.chatId,
        messageId: reminderRef.messageId,
      })
    : null;
  const medication = await findTelegramDoseMedication(
    userId,
    userTz,
    { id: medicationId },
    reminderSlot ?? undefined,
  );
  if (!medication) {
    return { ok: false, message: t("telegram.errorMedicationInactive") };
  }

  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: { userId, medicationId: medication.id, idempotencyKey },
    select: { id: true },
  });

  let scheduledFor: Date | null = null;
  // The slot already held a take (another device, the pill box): this tap
  // recorded nothing, and the answer says so.
  let recordedBefore = false;
  if (!existing) {
    const takenAt = new Date();

    // Converge onto the slot's canonical row instead of bare-
    // creating a second row anchored at `now`. The old shape left the
    // worker-minted pending REMINDER row open: the slot later auto-missed
    // and compliance punished a dose the user explicitly confirmed.
    // Prefer the reminder's own slot (the message names the dose it fired
    // for); fall back to band attribution on the tap instant.
    let canonicalSlot: Date | null = reminderSlot;
    if (canonicalSlot === null) {
      const attribution = await resolveSlotForWriteByBand({
        userId,
        medicationId: medication.id,
        userTz: tz,
        takenAt,
      });
      canonicalSlot = attribution.slotInstant;
    }

    // The intake write and the snooze reset commit atomically — a
    // recorded dose must never leave the medication snoozed-out of its
    // own reminders, and a snooze reset must never land without the dose
    // (the pre-band shape used a batch transaction here; the slot
    // convergence dropped it). The canonical slot write accepts the
    // transaction client; its P2002 race-recovery cannot continue inside
    // an aborted Postgres transaction, so the rare create race rolls the
    // whole write back instead of converging in place — Telegram
    // redelivers the non-200 update and the retry finds the raced row.
    const written = await prisma.$transaction(async (tx) => {
      let slotScheduledFor: Date;
      let eventId: string;
      // Only a genuine pending→taken transition may consume
      // inventory units; a redelivered button press converging onto an
      // already-taken slot row (including a pre-stamp row) must not.
      let consumedTransition = true;
      let alreadyTaken = false;
      if (canonicalSlot) {
        const applied = await applyCanonicalSlotWrite({
          client: tx,
          userId,
          medicationId: medication.id,
          canonicalSlot,
          takenAt,
          skipped: false,
          isExplicitTaken: true,
          isExplicitSkip: false,
          idempotencyKey,
          createSource: "REMINDER",
          attributionSource: "AUTO",
          takenVia: "TELEGRAM",
        });
        slotScheduledFor = applied.row.scheduledFor;
        eventId = applied.row.id;
        consumedTransition = applied.consumedTransition;
        alreadyTaken = applied.alreadyTaken === true;
      } else {
        // Ad-hoc / PRN — standalone row under the documented contract
        // (`scheduledFor = takenAt`), off any slot row on the same instant.
        const created = await createAdHocIntake(tx, {
          userId,
          medicationId: medication.id,
          scheduledFor: takenAt,
          takenAt,
          skipped: false,
          source: "REMINDER",
          takenVia: "TELEGRAM",
          idempotencyKey,
        });
        slotScheduledFor = created.scheduledFor;
        eventId = created.id;
      }
      await tx.medication.update({
        where: { id: medication.id },
        data: { snoozedUntil: null },
      });
      return { slotScheduledFor, eventId, consumedTransition, alreadyTaken };
    });
    scheduledFor = written.slotScheduledFor;
    recordedBefore = written.alreadyTaken;
    // The button confirmed a take; consume inventory units.
    // Runs after the intake transaction committed (the dose record must
    // never hinge on the stock write); the stamp keeps a Telegram
    // redelivery exactly-once and the transition gate keeps a re-press
    // on an already-taken slot from decrementing through a pre-stamp
    // row.
    if (written.consumedTransition) {
      await consumeForIntake({
        client: prisma,
        userId,
        medicationId: medication.id,
        eventId: written.eventId,
        intakeAt: takenAt,
      });
    }
    // The confirmation must reflect on the next read (today feed, card
    // pill, compliance) rather than wait out the cache TTL.
    invalidateUserMedications(userId, { evict: true });
    // Wake the owner's iOS devices like a web take does, so a running Live
    // Activity and the widgets reconcile a dose confirmed in Telegram.
    afterDoseChange({
      scope: "intakes",
      userId,
      originDeviceToken: null,
      recorded: written.alreadyTaken
        ? undefined
        : {
            medicationId: medication.id,
            intakeId: written.eventId,
            slotInstant: written.slotScheduledFor,
            outcome: "taken",
            takenAt,
            takenVia: "TELEGRAM",
          },
    });
  }

  // Refresh the compliance rollup for the
  // affected day so the next read after the cache miss reflects the
  // new dose. Only fires when the write landed a row.
  if (scheduledFor) {
    await refreshDoseSlot({
      userId,
      medicationId: medication.id,
      scheduledFor,
      tz: userTz,
    });
  }

  return {
    ok: true,
    message:
      existing || recordedBefore
        ? t("telegram.alreadyRecorded", { name: medication.name })
        : t("telegram.recordedAsTaken", { name: medication.name }),
    medicationName: medication.name,
  };
}

/**
 * Record a Telegram "skip" on the dose the reminder message names, or on the
 * band the skip moment falls in. Idempotent per message. A skip on a slot
 * that already holds a take (an old reminder button after the pill box
 * recorded the dose) writes nothing and answers `alreadyTaken`.
 */
export async function markMedicationSkipped(input: {
  userId: string;
  userTz: string | null;
  medicationId: string;
  chatId: string;
  messageId: number | undefined;
}): Promise<"skipped" | "alreadyTaken"> {
  const { userId, userTz, medicationId, chatId, messageId } = input;
  const msgId = messageId ?? "na";
  const idempotencyKey =
    `telegram:skip:${chatId}:${msgId}:${medicationId}`.slice(0, 128);

  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: { userId: userId, medicationId: medicationId, idempotencyKey },
    select: { id: true },
  });

  let skippedScheduledFor: Date | null = null;
  if (!existing) {
    const skipMoment = new Date();
    const tz = userTz || DEFAULT_TIMEZONE;
    // The rest of the person's own day, not of the server's: the process
    // runs in UTC, so a Berlin skip after 01:00 used to snooze the next
    // local morning's reminders as well.
    const endOfDay = getUserTodayBounds(skipMoment, tz).end;

    // A Telegram skip answers a specific dose prompt, so it
    // must converge onto the slot's pending row like a take does. The
    // old shape inserted a second row anchored at `now` and left the
    // pending REMINDER row open to auto-miss — the user's deliberate
    // skip recorded as a miss AND an orphan. Prefer the reminder's own
    // slot; fall back to the band the skip moment falls in.
    let canonicalSlot: Date | null =
      messageId !== undefined
        ? await resolveReminderSlot({
            userId: userId,
            medicationId: medicationId,
            userTz: tz,
            chatId,
            messageId,
          })
        : null;
    if (canonicalSlot === null) {
      const attribution = await resolveSlotForWriteByBand({
        userId: userId,
        medicationId: medicationId,
        userTz: tz,
        takenAt: skipMoment,
      });
      canonicalSlot = attribution.slotInstant;
    }

    // Atomic like the take path: the skip row and the rest-of-day
    // snooze commit together, so a failure can never leave the user
    // re-reminded for a recorded skip or silenced without one. Same
    // P2002 trade-off as the take path — the rare create race rolls
    // back and Telegram's redelivery converges on the raced row.
    const writtenSkip = await prisma.$transaction(async (tx) => {
      let alreadyTaken = false;
      let slotScheduledFor: Date;
      let eventId: string;
      if (canonicalSlot) {
        const applied = await applyCanonicalSlotWrite({
          client: tx,
          userId: userId,
          medicationId: medicationId,
          canonicalSlot,
          takenAt: null,
          skipped: true,
          isExplicitTaken: false,
          isExplicitSkip: true,
          idempotencyKey,
          createSource: "REMINDER",
        });
        alreadyTaken = applied.alreadyTaken === true;
        slotScheduledFor = applied.row.scheduledFor;
        eventId = applied.row.id;
      } else {
        const created = await createAdHocIntake(tx, {
          userId: userId,
          medicationId: medicationId,
          scheduledFor: skipMoment,
          takenAt: null,
          skipped: true,
          source: "REMINDER",
          idempotencyKey,
        });
        slotScheduledFor = created.scheduledFor;
        eventId = created.id;
      }
      // A skip on a slot answers that slot, and the worker never reminds
      // an answered slot, so no snooze is needed. Snoozing the medication
      // to the end of the day here made every other open slot of it read
      // as snoozed in the today list. Only a skip that found no slot falls
      // back to the snooze, which the worker and the today list both scope
      // to the dose that was open (`snooze-scope.ts`).
      if (!canonicalSlot) {
        await tx.medication.update({
          where: { id: medicationId },
          data: { snoozedUntil: endOfDay },
        });
      }
      return { slotScheduledFor, eventId, alreadyTaken };
    });
    if (writtenSkip.alreadyTaken) return "alreadyTaken";
    skippedScheduledFor = writtenSkip.slotScheduledFor;
    // An explicit skip can downgrade a previously-taken
    // slot row (last-write-wins); refund whatever its consumption
    // stamp recorded. No-op for a never-consumed row.
    await restoreForIntake({
      client: prisma,
      userId: userId,
      eventId: writtenSkip.eventId,
    });
    invalidateUserMedications(userId, { evict: true });
    afterDoseChange({
      scope: "intakes",
      userId,
      originDeviceToken: null,
      recorded: {
        medicationId,
        intakeId: writtenSkip.eventId,
        slotInstant: writtenSkip.slotScheduledFor,
        outcome: "skipped",
        takenAt: null,
        takenVia: null,
      },
    });
  }

  // Refresh the compliance rollup for the skipped
  // event's user-day so the next read sees the (scheduled, skipped)
  // counts incremented.
  if (skippedScheduledFor) {
    await refreshDoseSlot({
      userId: userId,
      medicationId: medicationId,
      scheduledFor: skippedScheduledFor,
      tz: userTz,
    });
  }
  return "skipped";
}
