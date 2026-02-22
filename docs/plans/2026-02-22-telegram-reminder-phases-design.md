# Telegram Reminder Phases Design

**Date:** 2026-02-22
**Status:** Approved

## Overview

Redesign the Telegram medication reminder system from "send every 15 minutes" to a phase-based approach where each phase (green, yellow, orange, red) triggers exactly one notification. Only one reminder message per medication exists in the chat at any time — old messages are deleted when a new phase fires or when the user responds.

## Requirements

1. **Phase-based reminders**: Green, Yellow, Orange, Red — one notification per phase transition
2. **Single message per medication**: When a new phase fires, delete the previous reminder for that medication
3. **Per-medication isolation**: Different medications are independent
4. **Message cleanup on action**: When user responds (taken/snooze/skip), delete the message
5. **Configurable phase timings**: Default timings, overridable per medication
6. **Values as minutes or percentage**: Phase timings can be absolute minutes or percentage of window duration
7. **Bot commands**: `/help` shows available commands, "Hi"/"Hallo" gets a greeting response
8. **Check interval**: Still every 15 minutes, but only send if a new phase has been entered

## Phase Definitions (Defaults)

Relative to window end:

| Phase | Default | Mode | Description |
|-------|---------|------|-------------|
| Green | 60 | MINUTES before end | Friendly reminder, window ending soon |
| Yellow | 30 | MINUTES before end | Getting urgent |
| Orange | 0 | MINUTES after end | Now overdue |
| Red | 240 | MINUTES after end | Missed, requires acknowledgment |

**Percentage mode**: Value is percentage of total window duration (windowEnd - windowStart).
- Example: 2h window (120 min), Green at 50% = 60 min before end
- Example: 2h window, Red at 200% = 240 min after end

**Constraint**: Green must not fire before windowStart.

## Database Changes

### New Enum: `ReminderPhase`

```
GREEN, YELLOW, ORANGE, RED
```

### New Enum: `PhaseMode`

```
MINUTES, PERCENT
```

### New Table: `ReminderPhaseConfig`

Per-medication phase timing override. If no row exists, defaults are used.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| id | String @id @default(cuid()) | auto | PK |
| medicationId | String @unique | FK | 1:1 with Medication |
| greenValue | Int | 60 | Green phase value |
| greenMode | PhaseMode | MINUTES | Green phase mode |
| yellowValue | Int | 30 | Yellow phase value |
| yellowMode | PhaseMode | MINUTES | Yellow phase mode |
| orangeValue | Int | 0 | Orange phase value |
| orangeMode | PhaseMode | MINUTES | Orange phase mode |
| redValue | Int | 240 | Red phase value |
| redMode | PhaseMode | MINUTES | Red phase mode |

### New Table: `TelegramReminderMessage`

Tracks active reminder messages per medication per schedule per day.

| Field | Type | Description |
|-------|------|-------------|
| id | String @id @default(cuid()) | PK |
| medicationId | String | FK → Medication |
| scheduleId | String | FK → MedicationSchedule |
| chatId | String | Telegram Chat ID |
| messageId | Int | Telegram Message ID |
| phase | ReminderPhase | Which phase was sent |
| sentAt | DateTime @default(now()) | When sent |
| date | String | Date string (YYYY-MM-DD) for day grouping |

Unique constraint: `(medicationId, scheduleId, date, phase)` — prevents duplicate phase notifications.

## Reminder Worker Logic (every 15 min)

For each medication + schedule:

1. Calculate `minutesToWindowEnd` and `minutesPastWindowEnd`
2. Calculate window duration for percentage conversion
3. Resolve phase config (per-medication or defaults)
4. Convert percentage values to absolute minutes using window duration
5. Determine current phase:
   - Before green threshold: no reminder needed
   - Between green and yellow thresholds: GREEN (but not before windowStart)
   - Between yellow threshold and window end: YELLOW
   - Between window end and red threshold: ORANGE
   - Past red threshold: RED
6. Check `TelegramReminderMessage` for existing notification for this phase + med + schedule + date
7. If new phase entered:
   a. Delete ALL existing `TelegramReminderMessage` records for this medication (across all schedules) — also delete the Telegram messages
   b. Send new phase notification
   c. Store message ID in `TelegramReminderMessage`
8. RED phase: Create missed intake event + send with acknowledgment buttons only (no snooze)

## Message Templates

| Phase | Emoji | Text |
|-------|-------|------|
| GREEN | 🟢 | `Erinnerung:\n<b>Name</b> (Dosis, Zeitfenster)\nZeitfenster endet in X Min.` |
| YELLOW | 🟡 | `Bald fällig:\n<b>Name</b> (Dosis, Zeitfenster)\nNoch X Min. Zeit.` |
| ORANGE | 🟠 | `Überfällig:\n<b>Name</b> (Dosis, Zeitfenster)\nSeit X Min. überfällig.` |
| RED | 🔴 | `Verpasst:\n<b>Name</b> (Dosis, Zeitfenster)\nAls verpasst markiert.` |

### Inline Keyboard per Phase

**GREEN/YELLOW/ORANGE:**
```
[Genommen]
[🕐 1h] [🕐 3h] [⏭ Überspringen]
```

**RED:**
```
[Genommen] [✓ Bestätigen]
```

## Telegram Bot Enhancements

### `/help` Command

Response:
```
Verfügbare Befehle:

/help — Diese Hilfe anzeigen
/start — Bot starten

Textbefehle:
genommen <Name> — Einnahme bestätigen

Über die Buttons in Erinnerungen:
• Genommen — Einnahme bestätigen
• 🕐 1h / 🕐 3h — Erinnerung verschieben
• ⏭ Überspringen — Einnahme überspringen
• ✓ Bestätigen — Verpasste Einnahme bestätigen
```

### Greeting

User sends "Hi" / "Hallo" / "Hey" → Bot responds with same greeting.

## Message Lifecycle

```
Phase transition → Query TelegramReminderMessage for this medication
                 → Delete old Telegram messages (best-effort)
                 → Delete old DB records
                 → Send new message
                 → Store message ID in TelegramReminderMessage

User presses button → Process action (taken/snooze/skip/acknowledge)
                    → Delete Telegram message
                    → Delete DB record
```

No more 24h auto-delete needed — replaced by phase tracking.

## UI: Phase Configuration

**Access**: Medication edit → Three-dot menu → "Erinnerungsphasen" (Clock icon)

**Dialog** with 4 rows, each containing:
- Phase label + color indicator (🟢🟡🟠🔴)
- Input field for value
- Toggle between "Min" and "%"

**Footer:**
- "Auf Defaults zurücksetzen" button
- Cancel / Save buttons

**API Endpoint**: `PUT /api/medications/[id]/phase-config`

## Migration Notes

- Existing 24h cleanup jobs (`telegram-message-cleanup`) should be gracefully handled during transition
- No data migration needed — new tables are additive
- Existing snooze mechanism (`snoozedUntil` on Medication) remains unchanged
