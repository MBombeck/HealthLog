# Telegram Reminder Phases — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the "send every 15 minutes" reminder approach with a phase-based system (green/yellow/orange/red) that sends exactly one notification per phase transition, tracks messages per medication, and deletes old messages when new ones arrive.

**Architecture:** New Prisma models (`ReminderPhaseConfig`, `TelegramReminderMessage`) track phase configuration and active messages. The existing `handleReminderCheck()` in `reminder-worker.ts` is rewritten to determine the current phase, check if that phase was already notified, and only send+track when a new phase is entered. The Telegram sender is updated to delete previous messages before sending. Bot webhook gains `/help` command and greeting support. A new UI dialog lets users configure phase timings per medication.

**Tech Stack:** Prisma 7, pg-boss v12, Next.js 16 App Router, shadcn/ui, TanStack Query, Zod v4

**Design doc:** `docs/plans/2026-02-22-telegram-reminder-phases-design.md`

---

### Task 1: Database Schema — Add Enums and Models

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: Add ReminderPhase and PhaseMode enums**

After the `IntakeSource` enum (line ~204), add:

```prisma
enum ReminderPhase {
  GREEN
  YELLOW
  ORANGE
  RED

  @@map("reminder_phase")
}

enum PhaseMode {
  MINUTES
  PERCENT

  @@map("phase_mode")
}
```

**Step 2: Add ReminderPhaseConfig model**

After the `MedicationIntakeEvent` model (line ~222), add:

```prisma
model ReminderPhaseConfig {
  id           String    @id @default(cuid())
  medicationId String    @unique @map("medication_id")
  greenValue   Int       @default(60) @map("green_value")
  greenMode    PhaseMode @default(MINUTES) @map("green_mode")
  yellowValue  Int       @default(30) @map("yellow_value")
  yellowMode   PhaseMode @default(MINUTES) @map("yellow_mode")
  orangeValue  Int       @default(0) @map("orange_value")
  orangeMode   PhaseMode @default(MINUTES) @map("orange_mode")
  redValue     Int       @default(240) @map("red_value")
  redMode      PhaseMode @default(MINUTES) @map("red_mode")

  medication Medication @relation(fields: [medicationId], references: [id], onDelete: Cascade)

  @@map("reminder_phase_configs")
}
```

**Step 3: Add TelegramReminderMessage model**

```prisma
model TelegramReminderMessage {
  id           String        @id @default(cuid())
  medicationId String        @map("medication_id")
  scheduleId   String        @map("schedule_id")
  chatId       String        @map("chat_id")
  messageId    Int           @map("message_id")
  phase        ReminderPhase
  sentAt       DateTime      @default(now()) @map("sent_at")
  date         String        // YYYY-MM-DD for day grouping

  medication Medication         @relation(fields: [medicationId], references: [id], onDelete: Cascade)
  schedule   MedicationSchedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade)

  @@unique([medicationId, scheduleId, date, phase])
  @@index([medicationId, date])
  @@map("telegram_reminder_messages")
}
```

**Step 4: Add relations to existing models**

In the `Medication` model (line ~162), add after `intakeEvents`:
```prisma
  phaseConfig        ReminderPhaseConfig?
  telegramMessages   TelegramReminderMessage[]
```

In the `MedicationSchedule` model (line ~183), add after the `medication` relation:
```prisma
  telegramMessages TelegramReminderMessage[]
```

**Step 5: Create migration**

Run: `pnpm db:migrate -- --name add_reminder_phase_tracking`

Expected: Migration file created successfully.

**Step 6: Generate Prisma client**

Run: `pnpm db:generate`

Expected: Prisma Client generated successfully.

**Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add ReminderPhaseConfig and TelegramReminderMessage models

New database tables for phase-based reminder tracking:
- ReminderPhaseConfig: per-medication configurable phase timings
- TelegramReminderMessage: tracks active Telegram messages per medication"
```

---

### Task 2: Phase Resolution Helper

**Files:**
- Create: `src/lib/jobs/reminder-phases.ts`

**Step 1: Create the phase resolution module**

```typescript
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
    // Between window end and orange threshold — still ORANGE (orange starts at 0 by default)
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
```

**Step 2: Commit**

```bash
git add src/lib/jobs/reminder-phases.ts
git commit -m "feat: add reminder phase resolution helpers

Pure functions for determining current phase, resolving configurable
thresholds (minutes or percentage), and generating phase-specific
message templates and keyboards."
```

---

### Task 3: Update Telegram Sender — Phase-Aware Message Tracking

**Files:**
- Modify: `src/lib/notifications/senders/telegram.ts`
- Modify: `src/lib/notifications/types.ts`

**Step 1: Extend NotificationPayload metadata**

In `src/lib/notifications/types.ts`, the `metadata` field on `NotificationPayload` (line 61) is already `Record<string, unknown>`. No type change needed, but the reminder worker will now pass:
- `medicationId: string`
- `scheduleId: string`
- `phase: ReminderPhase`
- `date: string` (YYYY-MM-DD)
- `replyMarkup: object` (inline keyboard from `getPhaseKeyboard`)

**Step 2: Rewrite sendViaTelegram**

Replace the entire content of `src/lib/notifications/senders/telegram.ts`:

```typescript
import { sendTelegramMessage, deleteMessage } from "@/lib/telegram";
import type { SendMessageResult } from "@/lib/telegram";
import type {
  TelegramChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let senderPrisma: PrismaClient | null = null;

function getSenderPrisma(): PrismaClient {
  if (!senderPrisma) {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    });
    senderPrisma = new PrismaClient({ adapter });
  }
  return senderPrisma;
}

/**
 * Delete all existing Telegram reminder messages for a medication on a given date.
 * Best-effort: logs errors but never throws.
 */
async function deleteExistingReminders(
  botToken: string,
  medicationId: string,
  date: string,
): Promise<void> {
  const prisma = getSenderPrisma();
  try {
    const existing = await prisma.telegramReminderMessage.findMany({
      where: { medicationId, date },
    });

    for (const msg of existing) {
      try {
        await deleteMessage(botToken, msg.chatId, msg.messageId);
      } catch {
        // Best-effort: message may already be deleted
      }
    }

    if (existing.length > 0) {
      await prisma.telegramReminderMessage.deleteMany({
        where: { medicationId, date },
      });
    }
  } catch (err) {
    console.error("[telegram] Failed to delete existing reminders:", err);
  }
}

/**
 * Send notification via Telegram.
 * For MEDICATION_REMINDER events with phase metadata:
 *  1. Delete existing reminder messages for this medication
 *  2. Send new message with phase-specific keyboard
 *  3. Track the message in TelegramReminderMessage table
 *
 * For non-reminder events, sends as before without tracking.
 */
export async function sendViaTelegram(
  config: TelegramChannelConfig,
  payload: NotificationPayload,
): Promise<SendMessageResult> {
  const medicationId = payload.metadata?.medicationId as string | undefined;
  const scheduleId = payload.metadata?.scheduleId as string | undefined;
  const phase = payload.metadata?.phase as string | undefined;
  const date = payload.metadata?.date as string | undefined;
  const replyMarkup = payload.metadata?.replyMarkup as object | undefined;

  // Phase-aware: delete old messages before sending new one
  if (medicationId && phase && date) {
    await deleteExistingReminders(config.botToken, medicationId, date);
  }

  // Build reply markup: use provided phase keyboard, or default for non-phase reminders
  const keyboard =
    replyMarkup ??
    (payload.eventType === "MEDICATION_REMINDER" && medicationId
      ? {
          inline_keyboard: [
            [
              {
                text: "Genommen",
                callback_data: `taken:${medicationId}`,
              },
            ],
            [
              {
                text: "🕐 1h",
                callback_data: `snooze:${medicationId}:60`,
              },
              {
                text: "🕐 3h",
                callback_data: `snooze:${medicationId}:180`,
              },
              {
                text: "⏭ Überspringen",
                callback_data: `skip:${medicationId}`,
              },
            ],
          ],
        }
      : undefined);

  const result = await sendTelegramMessage(
    config.botToken,
    config.chatId,
    payload.message,
    {
      parseMode: "HTML",
      replyMarkup: keyboard as Parameters<typeof sendTelegramMessage>[3] extends { replyMarkup?: infer R } ? R : never,
    },
  );

  // Track the message in DB for later deletion
  if (result.ok && result.messageId && medicationId && scheduleId && phase && date) {
    const prisma = getSenderPrisma();
    try {
      await prisma.telegramReminderMessage.upsert({
        where: {
          medicationId_scheduleId_date_phase: {
            medicationId,
            scheduleId,
            date,
            phase: phase as "GREEN" | "YELLOW" | "ORANGE" | "RED",
          },
        },
        create: {
          medicationId,
          scheduleId,
          chatId: config.chatId,
          messageId: result.messageId,
          phase: phase as "GREEN" | "YELLOW" | "ORANGE" | "RED",
          date,
        },
        update: {
          chatId: config.chatId,
          messageId: result.messageId,
        },
      });
    } catch (err) {
      console.error("[telegram] Failed to track reminder message:", err);
    }
  }

  return result;
}
```

**Step 3: Commit**

```bash
git add src/lib/notifications/senders/telegram.ts
git commit -m "feat: phase-aware Telegram sender with message tracking

Deletes previous reminder messages for a medication before sending
new phase notifications. Tracks message IDs in TelegramReminderMessage
table for later cleanup. Removes 24h auto-delete scheduling."
```

---

### Task 4: Rewrite Reminder Worker — Phase-Based Logic

**Files:**
- Modify: `src/lib/jobs/reminder-worker.ts`

**Step 1: Replace handleReminderCheck function**

Replace the entire `handleReminderCheck` function (lines 159-361) with the new phase-based logic. The new function should:

1. Clean up expired snoozes (same as before)
2. Fetch all active medications with schedules AND phaseConfig
3. For each medication + schedule:
   - Calculate window duration, minutesToEnd, minutesFromStart
   - Resolve phase config (per-medication or defaults)
   - Determine current phase via `determinePhase()`
   - Query `TelegramReminderMessage` for this med+schedule+date to see if phase already sent
   - If new phase: dispatch notification with phase metadata
   - If RED phase: also create missed intake event (same as before)

Add import at the top of the file:
```typescript
import {
  DEFAULT_PHASE_CONFIG,
  resolvePhaseThresholds,
  determinePhase,
  getPhaseMessage,
  getPhaseKeyboard,
} from "@/lib/jobs/reminder-phases";
```

Replace `handleReminderCheck`:

```typescript
async function handleReminderCheck(jobs: Job<ReminderCheckPayload>[]) {
  void jobs;
  const prisma = getWorkerPrisma();
  try {
    recordReminderCheck();
    const now = new Date();

    // Clean up expired snoozes
    await prisma.medication.updateMany({
      where: { snoozedUntil: { lt: now } },
      data: { snoozedUntil: null },
    });

    // Get all active medications with schedules and phase config
    const medications = await prisma.medication.findMany({
      where: { active: true },
      include: {
        schedules: true,
        phaseConfig: true,
        user: {
          select: {
            id: true,
            timezone: true,
          },
        },
      },
    });

    for (const med of medications) {
      const userTz = med.user.timezone || "Europe/Berlin";
      const { start: todayStart, end: todayEnd } = getUserTodayBounds(
        now,
        userTz,
      );

      const currentTime = now.toLocaleTimeString("de-DE", {
        timeZone: userTz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const todayDow = getDayOfWeekInTz(now, userTz);

      // Get today's date string in user's timezone for message tracking
      const localDateStr = now.toLocaleDateString("sv-SE", {
        timeZone: userTz,
      }); // YYYY-MM-DD format

      // Count existing intake events for this medication today
      const eventCount = await prisma.medicationIntakeEvent.count({
        where: {
          medicationId: med.id,
          userId: med.user.id,
          scheduledFor: { gte: todayStart, lte: todayEnd },
        },
      });

      // Resolve phase configuration
      const phaseConfig = med.phaseConfig ?? DEFAULT_PHASE_CONFIG;

      let schedulesProcessed = 0;
      const sortedSchedules = [...med.schedules].sort((a, b) =>
        a.windowStart.localeCompare(b.windowStart),
      );

      for (const schedule of sortedSchedules) {
        // Check day-of-week / recurrence constraints
        const recurrence = parseScheduleRecurrence(schedule.daysOfWeek);
        if (
          recurrence.daysOfWeek.length > 0 &&
          !recurrence.daysOfWeek.includes(todayDow)
        ) {
          continue;
        }

        const startMins = parseTimeToMinutes(schedule.windowStart);
        const endMins = parseTimeToMinutes(schedule.windowEnd);
        const currentMins = parseTimeToMinutes(currentTime);
        const windowDuration = endMins - startMins;
        const minutesToEnd = endMins - currentMins;
        const minutesFromStart = currentMins - startMins;

        // Skip if enough intake events exist
        if (eventCount > schedulesProcessed) {
          schedulesProcessed++;
          continue;
        }

        // Skip if medication is snoozed
        if (med.snoozedUntil && now < med.snoozedUntil) {
          schedulesProcessed++;
          continue;
        }

        // Resolve phase thresholds
        const thresholds = resolvePhaseThresholds(phaseConfig, windowDuration);

        // Determine current phase
        const currentPhase = determinePhase(
          minutesToEnd,
          minutesFromStart,
          thresholds,
        );

        if (!currentPhase) {
          schedulesProcessed++;
          continue;
        }

        // Check if this phase was already notified today
        const existingMessage =
          await prisma.telegramReminderMessage.findUnique({
            where: {
              medicationId_scheduleId_date_phase: {
                medicationId: med.id,
                scheduleId: schedule.id,
                date: localDateStr,
                phase: currentPhase,
              },
            },
          });

        if (existingMessage) {
          // Already sent for this phase — skip
          schedulesProcessed++;
          continue;
        }

        const doseInfo = schedule.dose ?? med.dose;
        const timeWindow = `${schedule.windowStart}–${schedule.windowEnd}`;

        // RED phase: create missed intake event
        if (currentPhase === "RED") {
          const [h, m] = schedule.windowStart.split(":").map(Number);
          const scheduledFor = new Date(
            todayStart.getTime() + h * 3600000 + m * 60000,
          );

          const existingMissed = await prisma.medicationIntakeEvent.count({
            where: {
              medicationId: med.id,
              userId: med.user.id,
              scheduledFor,
              takenAt: null,
              source: "REMINDER",
            },
          });

          if (existingMissed === 0) {
            await prisma.medicationIntakeEvent.create({
              data: {
                userId: med.user.id,
                medicationId: med.id,
                scheduledFor,
                takenAt: null,
                skipped: false,
                source: "REMINDER",
              },
            });

            console.log(
              `[reminder] Missed dose: ${med.name} for user ${med.user.id}, schedule ${schedule.windowStart}-${schedule.windowEnd}`,
            );
          }
        }

        // Send notification if enabled
        if (med.notificationsEnabled) {
          const { title, message } = getPhaseMessage(
            currentPhase,
            med.name,
            doseInfo,
            timeWindow,
            minutesToEnd,
          );

          const keyboard = getPhaseKeyboard(currentPhase, med.id);

          console.log(
            `[reminder] Phase ${currentPhase}: ${med.name} for user ${med.user.id}, schedule ${schedule.windowStart}-${schedule.windowEnd}`,
          );

          try {
            await dispatchNotification({
              eventType: "MEDICATION_REMINDER",
              userId: med.user.id,
              title,
              message,
              metadata: {
                medicationId: med.id,
                scheduleId: schedule.id,
                phase: currentPhase,
                date: localDateStr,
                replyMarkup: keyboard,
              },
            });
          } catch (notifErr) {
            console.error(
              `[reminder] Notification dispatch failed for ${currentPhase} phase ${med.name}:`,
              notifErr,
            );
          }
        }

        schedulesProcessed++;
      }
    }
  } catch (err) {
    console.error("[reminder] handleReminderCheck failed:", err);
    recordError();
  }
}
```

**Step 2: Remove the old AppSettings threshold query**

The old code reads `reminderMissedMinutes` from AppSettings (lines 167-173). This is replaced by per-medication `ReminderPhaseConfig`. Remove that query. The `missedMinutes` constant is no longer needed since we use `thresholds.redMinAfter` from the phase config.

**Step 3: Commit**

```bash
git add src/lib/jobs/reminder-worker.ts
git commit -m "feat: rewrite reminder worker with phase-based logic

Replaces repeated 15-minute notifications with phase-aware system.
Each phase (GREEN/YELLOW/ORANGE/RED) sends exactly one notification.
Uses TelegramReminderMessage table to prevent duplicate sends.
Passes phase metadata to dispatcher for message tracking."
```

---

### Task 5: Update Webhook — Add /help, Greeting, and Acknowledge Callback

**Files:**
- Modify: `src/app/api/telegram/webhook/route.ts`

**Step 1: Add `ack:` callback handler**

In `handleCallback` (line ~119), add a new branch after the `skip:` handler (before the `else` at line ~235):

```typescript
  } else if (data.startsWith("ack:")) {
    const medicationId = data.slice("ack:".length).trim();
    if (!medicationId) {
      await answerTelegramCallbackQuery(botToken, callback.id, "Ungültige Aktion.");
      return;
    }

    const medication = await prisma.medication.findFirst({
      where: { id: medicationId, userId: user.id },
      select: { id: true, name: true },
    });

    await answerTelegramCallbackQuery(
      botToken,
      callback.id,
      medication ? `${medication.name} bestätigt.` : "Bestätigt.",
    );
    if (messageId) {
      await deleteMessage(botToken, chatId, messageId);
    }
  }
```

**Step 2: Add DB cleanup on callback actions**

After deleting the Telegram message in each callback handler (`taken:`, `snooze:`, `skip:`, `ack:`), also delete the corresponding `TelegramReminderMessage` record. Add this helper at the top of the file (after imports):

```typescript
async function cleanupReminderTracking(medicationId: string): Promise<void> {
  try {
    await prisma.telegramReminderMessage.deleteMany({
      where: { medicationId },
    });
  } catch {
    // Best-effort cleanup
  }
}
```

Then call `await cleanupReminderTracking(medicationId);` after `deleteMessage` in each callback handler.

**Step 3: Update handleTextMessage for /help and greeting**

Replace the `/start` and `hilfe` handler block (lines 250-257) with:

```typescript
  if (/^\/help\b/i.test(text) || /^\/start\b/i.test(text) || /^hilfe$/i.test(text)) {
    await sendTelegramMessage(
      botToken,
      chatId,
      `<b>Verfügbare Befehle:</b>\n\n` +
        `/help — Diese Hilfe anzeigen\n` +
        `/start — Bot starten\n\n` +
        `<b>Textbefehle:</b>\n` +
        `genommen &lt;Name&gt; — Einnahme bestätigen\n\n` +
        `<b>Über die Buttons in Erinnerungen:</b>\n` +
        `• Genommen — Einnahme bestätigen\n` +
        `• 🕐 1h / 🕐 3h — Erinnerung verschieben\n` +
        `• ⏭ Überspringen — Einnahme überspringen\n` +
        `• ✓ Bestätigen — Verpasste Einnahme bestätigen`,
    );
    return;
  }

  // Greeting responses
  const greetings = ["hi", "hallo", "hey", "moin"];
  const lowerText = text.toLowerCase();
  const matchedGreeting = greetings.find((g) => lowerText === g);
  if (matchedGreeting) {
    // Reply with the same greeting, capitalized
    const reply = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    await sendTelegramMessage(botToken, chatId, `${reply}! 👋`);
    return;
  }
```

**Step 4: Commit**

```bash
git add src/app/api/telegram/webhook/route.ts
git commit -m "feat: add /help command, greeting support, and ack callback

/help shows all available commands and button explanations.
Hi/Hallo/Hey/Moin gets a greeting response.
ack: callback handles missed-dose acknowledgment.
All callbacks clean up TelegramReminderMessage records."
```

---

### Task 6: Phase Config API Endpoint

**Files:**
- Create: `src/app/api/medications/[id]/phase-config/route.ts`
- Create: `src/lib/validations/phase-config.ts`

**Step 1: Create Zod validation schema**

Create `src/lib/validations/phase-config.ts`:

```typescript
import { z } from "zod/v4";

const phaseModeSchema = z.enum(["MINUTES", "PERCENT"]);

export const phaseConfigSchema = z.object({
  greenValue: z.number().int().min(0).max(1440),
  greenMode: phaseModeSchema,
  yellowValue: z.number().int().min(0).max(1440),
  yellowMode: phaseModeSchema,
  orangeValue: z.number().int().min(0).max(1440),
  orangeMode: phaseModeSchema,
  redValue: z.number().int().min(0).max(1440),
  redMode: phaseModeSchema,
});

export type PhaseConfigInput = z.infer<typeof phaseConfigSchema>;
```

**Step 2: Create API route**

Create `src/app/api/medications/[id]/phase-config/route.ts`:

```typescript
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { phaseConfigSchema } from "@/lib/validations/phase-config";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  const config = await prisma.reminderPhaseConfig.findUnique({
    where: { medicationId: id },
  });

  // Return config or defaults
  return apiSuccess(
    config ?? {
      greenValue: 60,
      greenMode: "MINUTES",
      yellowValue: 30,
      yellowMode: "MINUTES",
      orangeValue: 0,
      orangeMode: "MINUTES",
      redValue: 240,
      redMode: "MINUTES",
    },
  );
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  const body = await request.json();
  const parsed = phaseConfigSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Ungültige Eingabe", 400);
  }

  const config = await prisma.reminderPhaseConfig.upsert({
    where: { medicationId: id },
    create: {
      medicationId: id,
      ...parsed.data,
    },
    update: parsed.data,
  });

  return apiSuccess(config);
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const { id } = await params;
  const medication = await prisma.medication.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!medication || medication.userId !== sessionData.user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  await prisma.reminderPhaseConfig.deleteMany({
    where: { medicationId: id },
  });

  return apiSuccess({ reset: true });
}
```

**Step 3: Commit**

```bash
git add src/lib/validations/phase-config.ts src/app/api/medications/\[id\]/phase-config/route.ts
git commit -m "feat: add phase config API endpoint

GET/PUT/DELETE /api/medications/[id]/phase-config
Allows reading, updating, and resetting per-medication phase timings."
```

---

### Task 7: Phase Config UI Dialog

**Files:**
- Create: `src/components/medications/phase-config-dialog.tsx`
- Modify: `src/components/medications/medication-form.tsx`
- Modify: `messages/de.json`
- Modify: `messages/en.json`

**Step 1: Add i18n strings**

Add to `messages/de.json` in the `medications` section:

```json
"phaseConfig": "Erinnerungsphasen",
"phaseConfigDescription": "Konfiguriere die Zeitpunkte für Erinnerungen.",
"phaseGreen": "Grün",
"phaseYellow": "Gelb",
"phaseOrange": "Orange",
"phaseRed": "Rot",
"phaseMinutes": "Min",
"phasePercent": "%",
"phaseBeforeEnd": "vor Ende",
"phaseAfterEnd": "nach Ende",
"phaseResetDefaults": "Auf Defaults zurücksetzen",
"phaseSaved": "Erinnerungsphasen gespeichert",
"phaseReset": "Auf Defaults zurückgesetzt"
```

Add equivalent English strings to `messages/en.json`.

**Step 2: Create PhaseConfigDialog component**

Create `src/components/medications/phase-config-dialog.tsx`:

A Dialog with 4 rows (one per phase). Each row has:
- Color dot + phase name label
- Number input for value
- Toggle button between "Min" and "%" (using the Button component)
- Label showing "vor Ende" or "nach Ende"

Uses TanStack Query to fetch/mutate via `/api/medications/[id]/phase-config`.

Include a "Auf Defaults zurücksetzen" button that calls DELETE on the endpoint, then refetches.

The component should accept `medicationId: string` and `open: boolean` and `onOpenChange: (open: boolean) => void` props.

**Step 3: Integrate into medication-form.tsx**

In `medication-form.tsx`:

1. Import `PhaseConfigDialog` and `Clock` icon from lucide-react
2. Add state: `const [phaseConfigOpen, setPhaseConfigOpen] = useState(false);`
3. Add a new `DropdownMenuItem` in the three-dot menu (edit mode), after the API Endpoint item and before the separator (line ~722):

```tsx
<DropdownMenuItem onClick={() => setPhaseConfigOpen(true)}>
  <Clock className="mr-2 h-4 w-4" />
  {t("medications.phaseConfig")}
</DropdownMenuItem>
```

4. Add the dialog component before the closing tag of the form:

```tsx
{isEdit && initial?.id && (
  <PhaseConfigDialog
    medicationId={initial.id}
    open={phaseConfigOpen}
    onOpenChange={setPhaseConfigOpen}
  />
)}
```

**Step 4: Commit**

```bash
git add src/components/medications/phase-config-dialog.tsx src/components/medications/medication-form.tsx messages/de.json messages/en.json
git commit -m "feat: add phase configuration UI dialog

New dialog accessible from medication edit three-dot menu.
Allows configuring per-medication reminder phase timings
with support for absolute minutes and percentage values."
```

---

### Task 8: Remove Legacy 24h Cleanup

**Files:**
- Modify: `src/lib/jobs/reminder-worker.ts`
- Modify: `src/lib/notifications/senders/telegram.ts` (already done in Task 3)

**Step 1: Keep the `handleTelegramCleanup` handler but make it a no-op for new messages**

The handler should still exist to process any remaining jobs in the queue from before the migration. It can stay as-is — it just won't receive new jobs since `sendViaTelegram` no longer schedules them.

No code changes needed since Task 3 already removed the scheduling in `sendViaTelegram`.

**Step 2: Commit** (skip if no changes)

---

### Task 9: Verify Build and Type Check

**Step 1: Run type check**

Run: `pnpm typecheck`

Expected: No type errors.

**Step 2: Run linter**

Run: `pnpm lint`

Expected: No lint errors.

**Step 3: Run build**

Run: `pnpm build`

Expected: Build succeeds.

**Step 4: Fix any issues found**

Address any type errors, lint issues, or build failures.

**Step 5: Commit fixes if needed**

```bash
git add -A
git commit -m "fix: resolve type/lint issues from reminder phases implementation"
```

---

### Task 10: Final Review and Push

**Step 1: Review all changes**

Run: `git log --oneline -10` and `git diff main~N..HEAD --stat` to review all commits.

**Step 2: Push**

Run: `git push`

Expected: Push succeeds.
