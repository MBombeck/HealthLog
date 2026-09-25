import { prisma } from "@/lib/db";
import { isP2025 } from "@/lib/prisma-errors";
import { decrypt } from "@/lib/crypto";
import {
  answerTelegramCallbackQuery,
  deleteMessage,
  sendTelegramMessage,
} from "@/lib/telegram";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { locales, type Locale } from "@/lib/i18n/config";
import { foldForMatch } from "@/lib/i18n/fold-for-match";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
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
import { localHmAsUtc } from "@/lib/tz/local-day";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import {
  logTelegramMood,
  attachTelegramMoodNote,
} from "@/lib/mood/create-from-telegram";
import { scheduleTelegramAutoDelete } from "@/lib/telegram-cleanup";
import { satisfyReminder } from "@/lib/measurement-reminders/satisfy";
import {
  isTelegramCapturableType,
  logTelegramMeasurement,
} from "@/lib/measurements/create-from-telegram";
// v1.39.1 (#1033) — every Telegram path that offers, records or snoozes a
// dose (the /add list, the "taken" keyword, the reminder buttons) leaves a
// medication kept as a record out, as the web and the today list do.
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";

/**
 * Telegram webhook update handlers, split out of
 * `src/app/api/telegram/webhook/route.ts` (v1.28.26 file-size split —
 * pure code motion, no behaviour change) so the route stays a thin
 * shell: rate limit, shared-secret check, JSON parse, dispatch. The
 * callback (button-tap) and free-text paths plus their medication /
 * mood / measurement helpers live here. The userId is always resolved
 * from the linked chat via `findTelegramUser` — never from the payload.
 */

/* ──────────────────────────────────────────────────────────────────────────
 * Bare-word aliases.
 *
 * The bot's real commands are slash commands (`/help`, `/start`, `/add`) plus
 * the `taken <name>` text command, and `telegram.helpBody` documents exactly
 * those in all six bundles — none of that depends on the reader's language.
 * What did depend on it were the two undocumented courtesies below, which knew
 * English and German: "aide", "ayuda", "aiuto" and "pomoc" reached the intake
 * keyword instead, failed it, and the handler returned without replying at all.
 * Silence is the worst answer to someone asking for help.
 *
 * These are ordinary words, not app labels, so there is nothing in the bundles
 * to derive them from. They are matched on the FOLDED text so "cześć" and
 * "czesc" are one entry and a stray capital or accent cannot miss.
 * ────────────────────────────────────────────────────────────────────────── */

/** "Help", in every language the app ships. */
const HELP_WORDS: readonly string[] = [
  "help",
  "hilfe",
  "aide",
  "ayuda",
  "aiuto",
  "pomoc",
];

/** Greetings the bot answers with a wave, in every language the app ships. */
const GREETING_WORDS: readonly string[] = [
  "hi",
  "hello",
  "hey",
  "hallo",
  "moin",
  "bonjour",
  "salut",
  "hola",
  "buenas",
  "ciao",
  "salve",
  "czesc",
  "witaj",
  "dzien dobry",
];

/**
 * True when the whole message is one of `words`. Folded on both sides, so the
 * comparison is case-, accent- and punctuation-insensitive; anchored to the
 * whole message, so "help me log my weight" is not swallowed as a command.
 */
function isBareCommandWord(text: string, words: readonly string[]): boolean {
  const folded = foldForMatch(text);
  return folded !== "" && words.includes(folded);
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id: number | string };
    reply_to_message?: {
      message_id?: number;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number | string };
    message?: {
      message_id?: number;
      chat?: { id: number | string };
    };
  };
}

function toChatId(value: number | string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Resolve the bot locale for an existing Telegram user.
 *
 * Defaults to "de" when User.locale is null — existing bots were set up in
 * German and we don't want to silently flip them. Users who have switched
 * the UI to English (User.locale = "en") get an English bot too.
 */
function resolveBotLocale(value: string | null | undefined): Locale {
  if (value && (locales as readonly string[]).includes(value)) {
    return value as Locale;
  }
  return "de";
}

async function cleanupReminderTracking(
  recipientUserId: string,
  medicationId: string,
): Promise<void> {
  try {
    await prisma.telegramReminderMessage.deleteMany({
      where: {
        recipientUserId,
        medicationId,
        medication: { userId: recipientUserId },
      },
    });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * A managed-record reminder is tracked under the Guardian recipient so a
 * replacement can delete the prior message. Its callback must never mutate
 * the managed record, even if a crafted Telegram update supplies action data.
 */
async function isManagedReminderCallback(input: {
  recipientUserId: string;
  chatId: string;
  messageId: number;
}): Promise<boolean> {
  const reminder = await prisma.telegramReminderMessage.findFirst({
    where: {
      recipientUserId: input.recipientUserId,
      chatId: input.chatId,
      messageId: input.messageId,
    },
    select: { medication: { select: { userId: true } } },
  });
  return (
    reminder?.medication?.userId !== undefined &&
    reminder.medication.userId !== input.recipientUserId
  );
}

// v1.19.0 — the auto-delete window dropped from 1 h to ~30 min and moved to
// the shared `scheduleTelegramAutoDelete` helper so the inbound (free-text)
// and outbound (unanswered prompt) paths agree on the window.
async function scheduleAutoDelete(
  userId: string,
  chatId: string,
  messageIds: number[],
): Promise<void> {
  await scheduleTelegramAutoDelete(userId, chatId, messageIds);
}

async function findTelegramUser(chatId: string) {
  return prisma.user.findFirst({
    where: {
      telegramEnabled: true,
      telegramChatId: chatId,
      telegramBotToken: { not: null },
    },
    select: {
      id: true,
      telegramBotToken: true,
      locale: true,
      // v1.4.39 W-MED — pulled into the select so the post-write
      // compliance-rollup hook can anchor the user-day bucket.
      timezone: true,
    },
  });
}

/**
 * v1.16.9 — the slot a Telegram action should converge onto.
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

async function markMedicationTaken(
  userId: string,
  medicationId: string,
  idempotencyKey: string,
  locale: Locale,
  userTz: string | null,
  reminderRef?: { chatId: string; messageId: number },
): Promise<{ ok: boolean; message: string; medicationName?: string }> {
  const { t } = getServerTranslator(locale);
  const medication = await prisma.medication.findFirst({
    where: { id: medicationId, userId, active: true, ...TRACKED_INTAKE_WHERE },
    select: { id: true, name: true },
  });
  if (!medication) {
    return { ok: false, message: t("telegram.errorMedicationInactive") };
  }

  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: { userId, medicationId: medication.id, idempotencyKey },
    select: { id: true },
  });

  let scheduledFor: Date | null = null;
  if (!existing) {
    const takenAt = new Date();
    const tz = userTz || DEFAULT_TIMEZONE;

    // v1.16.9 — converge onto the slot's canonical row instead of bare-
    // creating a second row anchored at `now`. The old shape left the
    // worker-minted pending REMINDER row open: the slot later auto-missed
    // and compliance punished a dose the user explicitly confirmed.
    // Prefer the reminder's own slot (the message names the dose it fired
    // for); fall back to band attribution on the tap instant.
    let canonicalSlot: Date | null = reminderRef
      ? await resolveReminderSlot({
          userId,
          medicationId: medication.id,
          userTz: tz,
          chatId: reminderRef.chatId,
          messageId: reminderRef.messageId,
        })
      : null;
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
      // v1.16.10 — only a genuine pending→taken transition may consume
      // inventory units; a redelivered button press converging onto an
      // already-taken slot row (including a pre-stamp row) must not.
      let consumedTransition = true;
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
        });
        slotScheduledFor = applied.row.scheduledFor;
        eventId = applied.row.id;
        consumedTransition = applied.consumedTransition;
      } else {
        // Ad-hoc / PRN — standalone row under the documented contract
        // (`scheduledFor = takenAt`).
        const created = await tx.medicationIntakeEvent.create({
          data: {
            userId,
            medicationId: medication.id,
            scheduledFor: takenAt,
            takenAt,
            skipped: false,
            source: "REMINDER",
            idempotencyKey,
          },
        });
        slotScheduledFor = created.scheduledFor;
        eventId = created.id;
      }
      await tx.medication.update({
        where: { id: medication.id },
        data: { snoozedUntil: null },
      });
      return { slotScheduledFor, eventId, consumedTransition };
    });
    scheduledFor = written.slotScheduledFor;
    // v1.16.10 — the button confirmed a take; consume inventory units.
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
  }

  // v1.4.39 W-MED — refresh the compliance rollup for the
  // affected day so the next read after the cache miss reflects the
  // new dose. Only fires when the write landed a row.
  if (scheduledFor) {
    await recomputeMedicationComplianceForEvent({
      userId,
      medicationId: medication.id,
      scheduledFor,
      tz: userTz,
    });
  }

  return {
    ok: true,
    message: existing
      ? t("telegram.alreadyRecorded", { name: medication.name })
      : t("telegram.recordedAsTaken", { name: medication.name }),
    medicationName: medication.name,
  };
}

export async function handleCallback(update: TelegramUpdate) {
  const callback = update.callback_query;
  if (!callback) return;

  const chatId =
    toChatId(callback.message?.chat?.id) ?? toChatId(callback.from?.id);
  if (!chatId) return;

  const user = await findTelegramUser(chatId);
  if (!user?.telegramBotToken) return;
  const botToken = decrypt(user.telegramBotToken);
  const locale = resolveBotLocale(user.locale);
  const { t } = getServerTranslator(locale);

  const data = callback.data ?? "";
  const messageId = callback.message?.message_id;

  if (
    messageId !== undefined &&
    /^(taken|snooze|skip|ack):/.test(data) &&
    (await isManagedReminderCallback({
      recipientUserId: user.id,
      chatId,
      messageId,
    }))
  ) {
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.errorInvalidAction"),
    );
    return;
  }

  if (data.startsWith("taken:")) {
    const medicationId = data.slice("taken:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const msgId = messageId ?? "na";
    const idempotencyKey =
      `telegram:cb:${chatId}:${msgId}:${medicationId}`.slice(0, 128);

    const result = await markMedicationTaken(
      user.id,
      medicationId,
      idempotencyKey,
      locale,
      user.timezone,
      messageId !== undefined ? { chatId, messageId } : undefined,
    );
    await answerTelegramCallbackQuery(botToken, callback.id, result.message);
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(user.id, medicationId);
  } else if (data.startsWith("snooze:")) {
    // Format: "snooze:{medicationId}:{minutes}"
    const parts = data.split(":");
    const medicationId = parts[1];
    const minutes = parseInt(parts[2], 10);
    if (!medicationId || !Number.isFinite(minutes)) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const medication = await prisma.medication.findFirst({
      where: {
        id: medicationId,
        userId: user.id,
        active: true,
        ...TRACKED_INTAKE_WHERE,
      },
      select: { id: true, name: true },
    });
    if (!medication) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorMedicationNotFound"),
      );
      return;
    }

    await prisma.medication.update({
      where: { id: medication.id },
      data: { snoozedUntil: new Date(Date.now() + minutes * 60000) },
    });

    const duration =
      minutes <= 60
        ? t("telegram.snoozeOneHour")
        : t("telegram.snoozeThreeHours");
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.snoozedFor", { name: medication.name, duration }),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(user.id, medicationId);
  } else if (data.startsWith("skip:")) {
    const medicationId = data.slice("skip:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const medication = await prisma.medication.findFirst({
      where: {
        id: medicationId,
        userId: user.id,
        active: true,
        ...TRACKED_INTAKE_WHERE,
      },
      select: { id: true, name: true },
    });
    if (!medication) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorMedicationNotFound"),
      );
      return;
    }

    const msgId = messageId ?? "na";
    const idempotencyKey =
      `telegram:skip:${chatId}:${msgId}:${medicationId}`.slice(0, 128);

    const existing = await prisma.medicationIntakeEvent.findFirst({
      where: { userId: user.id, medicationId: medication.id, idempotencyKey },
      select: { id: true },
    });

    let skippedScheduledFor: Date | null = null;
    if (!existing) {
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      const skipMoment = new Date();
      const tz = user.timezone || DEFAULT_TIMEZONE;

      // v1.16.9 — a Telegram skip answers a specific dose prompt, so it
      // must converge onto the slot's pending row like a take does. The
      // old shape inserted a second row anchored at `now` and left the
      // pending REMINDER row open to auto-miss — the user's deliberate
      // skip recorded as a miss AND an orphan. Prefer the reminder's own
      // slot; fall back to the band the skip moment falls in.
      let canonicalSlot: Date | null =
        messageId !== undefined
          ? await resolveReminderSlot({
              userId: user.id,
              medicationId: medication.id,
              userTz: tz,
              chatId,
              messageId,
            })
          : null;
      if (canonicalSlot === null) {
        const attribution = await resolveSlotForWriteByBand({
          userId: user.id,
          medicationId: medication.id,
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
        let slotScheduledFor: Date;
        let eventId: string;
        if (canonicalSlot) {
          const applied = await applyCanonicalSlotWrite({
            client: tx,
            userId: user.id,
            medicationId: medication.id,
            canonicalSlot,
            takenAt: null,
            skipped: true,
            isExplicitTaken: false,
            isExplicitSkip: true,
            idempotencyKey,
            createSource: "REMINDER",
          });
          slotScheduledFor = applied.row.scheduledFor;
          eventId = applied.row.id;
        } else {
          const created = await tx.medicationIntakeEvent.create({
            data: {
              userId: user.id,
              medicationId: medication.id,
              scheduledFor: skipMoment,
              takenAt: null,
              skipped: true,
              source: "REMINDER",
              idempotencyKey,
            },
          });
          slotScheduledFor = created.scheduledFor;
          eventId = created.id;
        }
        await tx.medication.update({
          where: { id: medication.id },
          data: { snoozedUntil: endOfDay },
        });
        return { slotScheduledFor, eventId };
      });
      skippedScheduledFor = writtenSkip.slotScheduledFor;
      // v1.16.10 — an explicit skip can downgrade a previously-taken
      // slot row (last-write-wins); refund whatever its consumption
      // stamp recorded. No-op for a never-consumed row.
      await restoreForIntake({
        client: prisma,
        userId: user.id,
        eventId: writtenSkip.eventId,
      });
      invalidateUserMedications(user.id, { evict: true });
    }

    // v1.4.39 W-MED — refresh the compliance rollup for the skipped
    // event's user-day so the next read sees the (scheduled, skipped)
    // counts incremented.
    if (skippedScheduledFor) {
      await recomputeMedicationComplianceForEvent({
        userId: user.id,
        medicationId: medication.id,
        scheduledFor: skippedScheduledFor,
        tz: user.timezone,
      });
    }

    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.skipped", { name: medication.name }),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(user.id, medicationId);
  } else if (data.startsWith("ack:")) {
    const medicationId = data.slice("ack:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const medication = await prisma.medication.findFirst({
      where: { id: medicationId, userId: user.id },
      select: { id: true, name: true },
    });

    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      medication
        ? t("telegram.confirmed", { name: medication.name })
        : t("telegram.genericConfirmed"),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    await cleanupReminderTracking(user.id, medicationId);
  } else if (data.startsWith("add:")) {
    // Format: "add:{medicationId}" or "add:{medicationId}:umid:{userMsgId}"
    const withoutPrefix = data.slice("add:".length);
    const umidIdx = withoutPrefix.indexOf(":umid:");
    const medicationId =
      umidIdx >= 0 ? withoutPrefix.slice(0, umidIdx) : withoutPrefix.trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const msgId = messageId ?? "na";
    const idempotencyKey =
      `telegram:add:${chatId}:${msgId}:${medicationId}`.slice(0, 128);

    const result = await markMedicationTaken(
      user.id,
      medicationId,
      idempotencyKey,
      locale,
      user.timezone,
    );
    await answerTelegramCallbackQuery(botToken, callback.id, result.message);
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    // Also delete the user's /add command message if encoded
    const userMsgMatch = data.match(/:umid:(\d+)$/);
    if (userMsgMatch) {
      const userMsgId = parseInt(userMsgMatch[1], 10);
      if (Number.isFinite(userMsgId)) {
        await deleteMessage(botToken, chatId, userMsgId).catch(() => {});
      }
    }
  } else if (data.startsWith("cancel_add")) {
    // Delete the bot's selection message
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
    // Delete the user's original /add command message if encoded
    const userMsgMatch = data.match(/:umid:(\d+)$/);
    if (userMsgMatch) {
      const userMsgId = parseInt(userMsgMatch[1], 10);
      if (Number.isFinite(userMsgId)) {
        await deleteMessage(botToken, chatId, userMsgId).catch(() => {});
      }
    }
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.cancelled"),
    );
  } else if (data.startsWith("mood:")) {
    // v1.19.0 — log a mood entry 1–5 from a MOOD_REMINDER prompt tap.
    // The score is the ONLY accepted value; the userId is resolved from
    // the linked chat above, never from the payload. Confirmation is a
    // calm callback toast — no chat echo (restraint).
    const score = parseInt(data.slice("mood:".length).trim(), 10);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }

    const msgId = messageId ?? "na";
    // Stable per-tap dedup id (Telegram redelivers non-200 updates). The
    // mood-create helper upserts on `(userId, source, externalId)`.
    const externalId = `telegram:mood:${chatId}:${msgId}:${score}`.slice(
      0,
      120,
    );

    const moodResult = await logTelegramMood({
      userId: user.id,
      score,
      tz: user.timezone,
      externalId,
    });

    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.moodLogged", { score: String(score) }),
    );
    // Delete the prompt immediately on a tap; the unanswered-prompt
    // scheduled deletion (written at send time) is then a harmless no-op.
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }

    // Offer an optional note via force_reply. The reply (when it arrives)
    // is correlated back to this mood entry through TelegramPromptContext.
    const notePrompt = await sendTelegramMessage(
      botToken,
      chatId,
      t("telegram.moodNotePrompt"),
      {
        replyMarkup: {
          force_reply: true,
          input_field_placeholder: t("telegram.buttonMoodNote"),
        },
      },
    );
    if (notePrompt.ok && notePrompt.messageId) {
      try {
        await prisma.telegramPromptContext.create({
          data: {
            userId: user.id,
            chatId,
            promptMsgId: notePrompt.messageId,
            kind: "mood_note",
            refId: moodResult.moodEntryId,
            // Force-reply context lifespan: the same ~30-min window as the
            // deletion sweep. A reply after this is treated as expired.
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          },
        });
      } catch {
        // Best-effort — without the context row the note simply can't bind.
      }
      // The note prompt itself self-cleans on the ~30-min sweep whether or
      // not the user replies.
      await scheduleAutoDelete(user.id, chatId, [notePrompt.messageId]);
    }
  } else if (data.startsWith("mood_later")) {
    // v1.19.0 — restrained "remind me later" for the mood nudge. Clears
    // today's dispatch ledger so the next cron tick (inside the user's
    // reminder-hour window) re-fires the prompt, mirroring how the
    // medication snooze lets the tick re-remind. The prompt is deleted now.
    const tz = user.timezone || DEFAULT_TIMEZONE;
    const parts = wallClockInTz(new Date(), tz);
    const localDate = `${parts.year.toString().padStart(4, "0")}-${parts.month
      .toString()
      .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
    try {
      await prisma.moodReminderDispatch.deleteMany({
        where: { userId: user.id, date: localDate },
      });
    } catch {
      // Best-effort — a failure just means the day's nudge isn't re-armed.
    }
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.remindLater", { duration: t("telegram.snoozeOneHour") }),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
  } else if (data.startsWith("measure_done:")) {
    // v1.19.0 — mark a Vorsorge/measurement reminder done; satisfy the
    // cadence via the shared primitive.
    const reminderId = data.slice("measure_done:".length).trim();
    // An appointment reminder is not addressable here, the same refusal the
    // by-id HTTP family makes: it belongs to a visit, is managed through the
    // visit routes, and sits in a different sharing domain. The lookup answers
    // "not found" rather than acting on it — satisfying one would mark an
    // appointment attended from a chat button, and postponing one would move a
    // date the visit record still believes it owns.
    const reminder = await prisma.measurementReminder.findFirst({
      where: {
        id: reminderId,
        userId: user.id,
        deletedAt: null,
        origin: { not: "ENCOUNTER" },
      },
      select: {
        id: true,
        userId: true,
        // v1.19.2 — the target metric; drives the optional numeric capture.
        measurementType: true,
        intervalDays: true,
        rrule: true,
        anchorDate: true,
        notifyHour: true,
        nextDueAt: true,
        lastSatisfiedAt: true,
        lastSkippedAt: true,
        createdAt: true,
      },
    });
    if (!reminder) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.measurementNotFound"),
      );
      return;
    }
    const tz = user.timezone || DEFAULT_TIMEZONE;
    await satisfyReminder(prisma, reminder, tz, new Date(), "telegram");
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.measurementDone"),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }

    // v1.19.2 — optional numeric value capture. When the reminder names a
    // single-value metric (BP and free-text Vorsorge are excluded), offer a
    // force-reply prompt; a numeric reply is captured as a Measurement
    // (source=TELEGRAM) in `handleTextMessage`. The reply binds to THIS
    // reminder + user through a TelegramPromptContext keyed on the prompt
    // message id, the SAME strict chat/message binding the mood-note path
    // uses — the userId is never read from the inbound payload. Optional and
    // self-cleaning: ignoring the prompt leaves the cadence already
    // satisfied, and the prompt is swept on the ~30-min auto-delete.
    if (isTelegramCapturableType(reminder.measurementType)) {
      const valuePrompt = await sendTelegramMessage(
        botToken,
        chatId,
        t("telegram.measureValuePrompt"),
        {
          replyMarkup: {
            force_reply: true,
            input_field_placeholder: t("telegram.buttonMeasureValue"),
          },
        },
      );
      if (valuePrompt.ok && valuePrompt.messageId) {
        try {
          await prisma.telegramPromptContext.create({
            data: {
              userId: user.id,
              chatId,
              promptMsgId: valuePrompt.messageId,
              kind: "measure_value",
              refId: reminder.id,
              // Same ~30-min window as the deletion sweep; a later reply is
              // treated as expired.
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            },
          });
        } catch {
          // Best-effort — without the context row the value simply can't bind.
        }
        await scheduleAutoDelete(user.id, chatId, [valuePrompt.messageId]);
      }
    }
  } else if (data.startsWith("measure_later:")) {
    // v1.19.0 — postpone a measurement reminder by N minutes (one-shot
    // nudge). Pushes `nextDueAt` forward; the cron re-fires once due AND in
    // the user's notify-hour window. Mirrors the medication snooze.
    const parts = data.split(":");
    const reminderId = parts[1];
    const minutes = parseInt(parts[2] ?? "180", 10);
    if (!reminderId || !Number.isFinite(minutes)) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.errorInvalidAction"),
      );
      return;
    }
    // An appointment reminder is not addressable here, the same refusal the
    // by-id HTTP family makes: it belongs to a visit, is managed through the
    // visit routes, and sits in a different sharing domain. The lookup answers
    // "not found" rather than acting on it — satisfying one would mark an
    // appointment attended from a chat button, and postponing one would move a
    // date the visit record still believes it owns.
    const reminder = await prisma.measurementReminder.findFirst({
      where: {
        id: reminderId,
        userId: user.id,
        deletedAt: null,
        origin: { not: "ENCOUNTER" },
      },
      select: { id: true },
    });
    if (!reminder) {
      await answerTelegramCallbackQuery(
        botToken,
        callback.id,
        t("telegram.measurementNotFound"),
      );
      return;
    }
    await prisma.measurementReminder.update({
      where: { id: reminder.id },
      data: { nextDueAt: new Date(Date.now() + minutes * 60000) },
    });
    const duration =
      minutes <= 60
        ? t("telegram.snoozeOneHour")
        : t("telegram.snoozeThreeHours");
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.remindLater", { duration }),
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
  } else {
    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      t("telegram.errorUnknownAction"),
    );
  }
}

export async function handleTextMessage(update: TelegramUpdate) {
  const message = update.message;
  const text = message?.text?.trim();
  const chatId = toChatId(message?.chat?.id);
  if (!text || !chatId) return;

  const user = await findTelegramUser(chatId);
  if (!user?.telegramBotToken) return;
  const botToken = decrypt(user.telegramBotToken);
  const locale = resolveBotLocale(user.locale);
  const { t } = getServerTranslator(locale);

  // v1.19.0 — force-reply note capture. When this message replies to a
  // tracked mood-note prompt, attach the text to the just-logged mood entry
  // and clean up both messages. The context row is keyed on
  // `(chatId, promptMsgId)` and scoped to THIS user, so a reply can only
  // ever attach to that user's own entry.
  const replyToId = message?.reply_to_message?.message_id;
  if (replyToId !== undefined) {
    const context = await prisma.telegramPromptContext.findUnique({
      where: {
        chatId_promptMsgId: { chatId, promptMsgId: replyToId },
      },
      select: {
        id: true,
        userId: true,
        kind: true,
        refId: true,
        expiresAt: true,
      },
    });
    if (
      context &&
      context.userId === user.id &&
      (context.kind === "mood_note" || context.kind === "measure_value")
    ) {
      // The delete IS the replay guard: consuming the context row is what
      // stops a redelivered reply from being applied to the entry twice. Make
      // it authoritative — if the delete fails for any reason OTHER than the
      // row already being gone (P2025), do NOT apply the reply; abort and let
      // Telegram redeliver against a still-present row. P2025 means the row
      // was already consumed, which is the guard succeeding, so proceed.
      try {
        await prisma.telegramPromptContext.delete({
          where: { id: context.id },
        });
      } catch (err) {
        if (!isP2025(err)) return;
      }
      const userMsgId = message?.message_id;
      if (context.expiresAt.getTime() < Date.now()) {
        const resp = await sendTelegramMessage(
          botToken,
          chatId,
          context.kind === "measure_value"
            ? t("telegram.measureValueExpired")
            : t("telegram.moodNoteExpired"),
        );
        const toDelete = [userMsgId, replyToId, resp.messageId].filter(
          (id): id is number => id != null,
        );
        if (toDelete.length > 0) {
          await scheduleAutoDelete(user.id, chatId, toDelete);
        }
        return;
      }

      if (context.kind === "measure_value") {
        // v1.19.2 — numeric value capture for a measurement reminder. The
        // reminder named on the context row carries the expected metric; the
        // userId is the chat-resolved one (never the payload). A non-numeric
        // / out-of-range reply gets a calm hint, not a write. The reply, the
        // prompt, and the confirmation all self-clean on the ~30-min sweep.
        const reminder = await prisma.measurementReminder.findFirst({
          where: { id: context.refId, userId: user.id, deletedAt: null },
          select: { measurementType: true },
        });
        let confirmation: string;
        if (!isTelegramCapturableType(reminder?.measurementType)) {
          confirmation = t("telegram.measurementNotFound");
        } else {
          const externalId = `telegram:measure:${chatId}:${replyToId}`.slice(
            0,
            120,
          );
          const result = await logTelegramMeasurement({
            userId: user.id,
            type: reminder.measurementType,
            rawText: text,
            tz: user.timezone,
            externalId,
          });
          confirmation =
            result.status === "ok"
              ? t("telegram.measureValueSaved")
              : result.status === "out_of_range"
                ? t("telegram.measureValueOutOfRange")
                : t("telegram.measureValueInvalid");
        }
        const resp = await sendTelegramMessage(botToken, chatId, confirmation);
        const toDelete = [userMsgId, replyToId, resp.messageId].filter(
          (id): id is number => id != null,
        );
        if (toDelete.length > 0) {
          await scheduleAutoDelete(user.id, chatId, toDelete);
        }
        return;
      }

      const attached = await attachTelegramMoodNote({
        userId: user.id,
        moodEntryId: context.refId,
        note: text,
      });
      const resp = await sendTelegramMessage(
        botToken,
        chatId,
        attached
          ? t("telegram.moodNoteSaved")
          : t("telegram.errorInvalidAction"),
      );
      // Self-clean the note, the prompt, and the confirmation in ~30 min.
      const toDelete = [userMsgId, replyToId, resp.messageId].filter(
        (id): id is number => id != null,
      );
      if (toDelete.length > 0) {
        await scheduleAutoDelete(user.id, chatId, toDelete);
      }
      return;
    }
  }

  // Help / start. The slash commands are locale-independent by construction and
  // are what `telegram.helpBody` documents in every bundle. The BARE word is an
  // undocumented convenience that used to know English and German only, so a
  // French user typing "aide" got silence — the handler falls through to the
  // intake keyword and returns without a reply.
  if (
    /^\/help\b/i.test(text) ||
    /^\/start\b/i.test(text) ||
    isBareCommandWord(text, HELP_WORDS)
  ) {
    const userMsgId = message?.message_id;
    const resp = await sendTelegramMessage(
      botToken,
      chatId,
      `${t("telegram.helpHeader")}\n\n${t("telegram.helpBody")}`,
    );
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  if (/^\/add\b/i.test(text)) {
    const userMsgId = message?.message_id;
    const meds = await prisma.medication.findMany({
      where: { userId: user.id, active: true, ...TRACKED_INTAKE_WHERE },
      select: { id: true, name: true, dose: true },
      orderBy: { name: "asc" },
    });

    if (meds.length === 0) {
      const resp = await sendTelegramMessage(
        botToken,
        chatId,
        t("telegram.noActiveMedications"),
      );
      const toDelete = [userMsgId, resp.messageId].filter(
        (id): id is number => id != null,
      );
      if (toDelete.length > 0) {
        await scheduleAutoDelete(user.id, chatId, toDelete);
      }
      return;
    }

    if (meds.length === 1) {
      const idempotencyKey =
        `telegram:add:${update.update_id}:${meds[0].id}`.slice(0, 128);
      const result = await markMedicationTaken(
        user.id,
        meds[0].id,
        idempotencyKey,
        locale,
        user.timezone,
      );
      const resp = await sendTelegramMessage(
        botToken,
        chatId,
        result.ok
          ? `${escapeHtml(result.message)}`
          : `${escapeHtml(result.message)}`,
      );
      const toDelete = [userMsgId, resp.messageId].filter(
        (id): id is number => id != null,
      );
      if (toDelete.length > 0) {
        await scheduleAutoDelete(user.id, chatId, toDelete);
      }
      return;
    }

    // Encode user's message ID in callback data so cancel/add can delete it
    const umidSuffix = userMsgId ? `:umid:${userMsgId}` : "";
    const keyboard = {
      inline_keyboard: [
        ...meds.map((med) => [
          {
            text: `${med.name} (${med.dose})`,
            callback_data: `add:${med.id}${umidSuffix}`,
          },
        ]),
        [
          {
            text: t("telegram.cancelButton"),
            callback_data: `cancel_add${umidSuffix}`,
          },
        ],
      ],
    };
    const resp = await sendTelegramMessage(
      botToken,
      chatId,
      t("telegram.whichMedication"),
      { parseMode: "HTML", replyMarkup: keyboard },
    );
    // Fallback auto-delete if user never interacts with the selection
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  // Greeting responses (kept locale-independent)
  if (isBareCommandWord(text, GREETING_WORDS)) {
    const userMsgId = message?.message_id;
    const reply = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    const resp = await sendTelegramMessage(botToken, chatId, `${reply}! 👋`);
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  // Accept both "genommen <name>" (DE) and "taken <name>" (EN) regardless of
  // the user's UI locale — keeps backwards compatibility.
  const intakeKeyword = /^(?:genommen|taken)\b/i;
  if (!intakeKeyword.test(text)) return;

  const userMsgId = message?.message_id;
  const nameInput = text.replace(intakeKeyword, "").trim();

  let medicationId: string | null = null;
  if (nameInput) {
    const med = await prisma.medication.findFirst({
      where: {
        userId: user.id,
        active: true,
        ...TRACKED_INTAKE_WHERE,
        name: { equals: nameInput, mode: "insensitive" },
      },
      select: { id: true },
    });
    medicationId = med?.id ?? null;
  } else {
    const meds = await prisma.medication.findMany({
      where: { userId: user.id, active: true, ...TRACKED_INTAKE_WHERE },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 2,
    });
    if (meds.length === 1) {
      medicationId = meds[0].id;
    } else {
      const resp = await sendTelegramMessage(
        botToken,
        chatId,
        t("telegram.askMedicationName"),
      );
      const toDelete = [userMsgId, resp.messageId].filter(
        (id): id is number => id != null,
      );
      if (toDelete.length > 0) {
        await scheduleAutoDelete(user.id, chatId, toDelete);
      }
      return;
    }
  }

  if (!medicationId) {
    const resp = await sendTelegramMessage(
      botToken,
      chatId,
      t("telegram.medicationNotFoundExact"),
    );
    const toDelete = [userMsgId, resp.messageId].filter(
      (id): id is number => id != null,
    );
    if (toDelete.length > 0) {
      await scheduleAutoDelete(user.id, chatId, toDelete);
    }
    return;
  }

  const idempotencyKey =
    `telegram:text:${update.update_id}:${medicationId}`.slice(0, 128);
  const result = await markMedicationTaken(
    user.id,
    medicationId,
    idempotencyKey,
    locale,
    user.timezone,
  );
  const resp = await sendTelegramMessage(
    botToken,
    chatId,
    result.ok
      ? `✅ ${escapeHtml(result.message)}`
      : `⚠️ ${escapeHtml(result.message)}`,
  );
  const toDelete = [userMsgId, resp.messageId].filter(
    (id): id is number => id != null,
  );
  if (toDelete.length > 0) {
    await scheduleAutoDelete(user.id, chatId, toDelete);
  }
}
