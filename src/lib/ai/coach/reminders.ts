/**
 * v1.22 — Coach episodic reminder memory: capture + grammar.
 *
 * The missing memory type between `CoachFact` (durable traits) and `CoachPlan`
 * (standing if-then habits): a time-anchored "bring this back later" intent the
 * user explicitly asked the Coach to remember ("remind me about my sleep next
 * week"). Captured inline on EVERY turn via the provider-neutral
 * `---REMEMBER---` sentinel — so a casual "remember this" in a SHORT chat is no
 * longer lost waiting for the >20-turn memory worker.
 *
 * Friction tier (matches the design): a plain note the user EXPLICITLY asked
 * for is captured silently as `status: "active"` — confirming "should I remember
 * what you just told me to remember?" is the annoying anti-pattern. The
 * propose→confirm rule stays where it belongs: durable traits/plans the model
 * INFERRED (those still flow through the extractor + a confirm card).
 *
 * Defence-in-depth mirrors `suggest-reminder.ts` / `keyvalues.ts`: a byte cap on
 * the payload, a single block kept, the `when` validated against a CLOSED
 * grammar (ISO date / relative `+Nd`-`+Nw` / a context-cue enum), the metric
 * validated against a loose key pattern, and a malformed block dropped (the user
 * never sees the raw marker). The note TEXT is encrypted via `bytes-codec.ts`
 * (the same AES-256-GCM codec as `CoachPlan`); `metric`, `status`, the trigger
 * fields and the dates stay plain so the sweep + picker filter without a decrypt.
 *
 * Server-only — the capture path reads `@/lib/db`.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

import { encryptToBytes } from "./bytes-codec";

/** App-side closed status enum (NOT a DB enum — matches the schema column). */
export const COACH_REMINDER_STATUSES = [
  "proposed",
  "active",
  "due",
  "surfaced",
  "done",
  "dismissed",
] as const;

/** App-side closed trigger-kind enum (matches the schema column). */
export const COACH_REMINDER_TRIGGER_KINDS = ["date", "context"] as const;
export type CoachReminderTriggerKind =
  (typeof COACH_REMINDER_TRIGGER_KINDS)[number];

/**
 * Closed context-cue enum. A `context` reminder fires when the cue is satisfied
 * (evaluated by the daily sweep against persisted rows). The set is deliberately
 * small and deterministic — "next time you log X" / "next time you open the app".
 */
export const COACH_REMINDER_CONTEXT_CUES = [
  "NEXT_BP_LOGGED",
  "NEXT_WEIGHT_LOGGED",
  "NEXT_SLEEP_LOGGED",
  "NEXT_APP_OPEN",
] as const;
export type CoachReminderContextCue =
  (typeof COACH_REMINDER_CONTEXT_CUES)[number];

/** Per-field caps (mirror the Zod gate + the prompt instruction). */
export const REMINDER_NOTE_MAX_CHARS = 280;
export const REMINDER_METRIC_MAX_CHARS = 60;
/** Hard cap on non-terminal reminders per user (active + proposed + due/surfaced). */
export const MAX_REMINDERS_PER_USER = 50;
/** How many reminders the recall sub-block carries into the snapshot. */
export const REMINDERS_INJECT_TOP_N = 6;
/** Bounds on the relative-`+Nd` grammar (1 day .. 1 year out). */
const MIN_RELATIVE_DAYS = 1;
const MAX_RELATIVE_DAYS = 366;

const OPEN_SENTINEL = "---REMEMBER---";
const CLOSE_SENTINEL = "---END---";
/** Hard cap on the sentinel payload before parsing (prompt-injection guard). */
const SENTINEL_BYTE_CAP = 1024;

/** A loose metric key the model may name ("SLEEP", "BLOOD_PRESSURE"). */
const METRIC_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE_RE = /^\+(\d{1,3})([dw])$/i;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The resolved trigger a valid `when` grammar maps onto. */
export interface ResolvedTrigger {
  triggerKind: CoachReminderTriggerKind;
  dueAt: Date | null;
  contextCue: CoachReminderContextCue | null;
}

function isContextCue(value: string): value is CoachReminderContextCue {
  return (COACH_REMINDER_CONTEXT_CUES as readonly string[]).includes(value);
}

/**
 * Resolve the closed `when` grammar into a trigger, or `null` when the token is
 * unparseable / out of bounds (the caller drops the reminder). Accepts:
 *   - an ISO calendar date `YYYY-MM-DD`  → date trigger, dueAt 09:00 UTC that day
 *   - a relative `+Nd` / `+Nw`           → date trigger, dueAt now + N days/weeks
 *   - a context-cue token from the enum  → context trigger, dueAt null
 */
export function resolveWhenGrammar(
  whenRaw: string,
  now: Date,
): ResolvedTrigger | null {
  const when = whenRaw.trim();
  if (!when) return null;

  if (ISO_DATE_RE.test(when)) {
    // Anchor at 09:00 UTC on the named day — a deterministic, timezone-stable
    // fire moment for the daily sweep (push delivery + per-tz receptivity are
    // not wired here; this is in-app surfacing only).
    const dueAt = new Date(`${when}T09:00:00.000Z`);
    if (Number.isNaN(dueAt.getTime())) return null;
    return { triggerKind: "date", dueAt, contextCue: null };
  }

  const rel = RELATIVE_RE.exec(when);
  if (rel) {
    const n = Number.parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const days = unit === "w" ? n * 7 : n;
    if (days < MIN_RELATIVE_DAYS || days > MAX_RELATIVE_DAYS) return null;
    return {
      triggerKind: "date",
      dueAt: new Date(now.getTime() + days * MS_PER_DAY),
      contextCue: null,
    };
  }

  const cue = when.toUpperCase();
  if (isContextCue(cue)) {
    return { triggerKind: "context", dueAt: null, contextCue: cue };
  }

  return null;
}

/** The fields a valid `---REMEMBER---` block yields. */
export interface ParsedReminderSentinel {
  note: string;
  /** Resolved trigger when a valid `when` was given; null = a recall-only note. */
  trigger: ResolvedTrigger | null;
  metric: string | null;
}

export interface RememberParseResult {
  /** The reply with the block stripped (run AFTER the other sentinels). */
  prose: string;
  reminder: ParsedReminderSentinel | null;
  /** True when an opening sentinel was seen but yielded no valid reminder. */
  malformed: boolean;
}

/** Pull one `key: value` line out of the block body (first match wins). */
function fieldLine(body: string, key: string): string | null {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== key) continue;
    const value = line
      .slice(colon + 1)
      .trim()
      // Strip a trailing inline comment + surrounding quotes/backticks.
      .replace(/\s+#.*$/, "")
      .replace(/^["'`]|["'`]$/g, "")
      .trim();
    if (value) return value;
  }
  return null;
}

/**
 * Strip the `---REMEMBER---` block out of a reply and resolve its fields. Run
 * AFTER the KEYVALUES + SUGGEST-REMINDER strips so the prose it receives is
 * already free of those blocks. A missing `note`, or a present-but-unparseable
 * `when`, drops the reminder (`malformed: true`) while still removing the raw
 * marker from the prose.
 */
export function parseRememberSentinel(
  raw: string,
  now: Date,
): RememberParseResult {
  if (!raw) return { prose: "", reminder: null, malformed: false };

  const openIdx = raw.indexOf(OPEN_SENTINEL);
  if (openIdx === -1) return { prose: raw, reminder: null, malformed: false };

  const before = raw.slice(0, openIdx);
  const afterOpen = raw.slice(openIdx + OPEN_SENTINEL.length);
  const closeRel = afterOpen.indexOf(CLOSE_SENTINEL);
  const bodyRaw = closeRel === -1 ? afterOpen : afterOpen.slice(0, closeRel);
  const body =
    bodyRaw.length > SENTINEL_BYTE_CAP
      ? bodyRaw.slice(0, SENTINEL_BYTE_CAP)
      : bodyRaw;
  const after =
    closeRel === -1 ? "" : afterOpen.slice(closeRel + CLOSE_SENTINEL.length);
  const prose = `${before}${after}`.replace(/^\s+|\s+$/gu, "");

  const noteRaw = fieldLine(body, "note");
  if (!noteRaw) return { prose, reminder: null, malformed: true };
  const note = noteRaw.slice(0, REMINDER_NOTE_MAX_CHARS).trim();
  if (!note) return { prose, reminder: null, malformed: true };

  // `when` is optional. Present-but-invalid is a malformed drop; absent is a
  // recall-only note (active, no due moment).
  const whenRaw = fieldLine(body, "when");
  let trigger: ResolvedTrigger | null = null;
  if (whenRaw) {
    trigger = resolveWhenGrammar(whenRaw, now);
    if (!trigger) return { prose, reminder: null, malformed: true };
  }

  let metric: string | null = null;
  const metricRaw = fieldLine(body, "metric");
  if (metricRaw && METRIC_KEY_RE.test(metricRaw)) {
    metric = metricRaw.slice(0, REMINDER_METRIC_MAX_CHARS).toUpperCase();
  }

  return { prose, reminder: { note, trigger, metric }, malformed: false };
}

/**
 * The one system-prompt clause that teaches the model to emit `---REMEMBER---`.
 * Appended to the assembled Coach system prompt in the chat route (the canonical
 * system-prompt module is owned elsewhere). Provider-neutral; EN + DE only (the
 * Coach reasons in de/en).
 */
export function buildRememberAddendum(locale: string | undefined): string {
  if (locale?.toLowerCase().startsWith("de")) {
    return `WENN die Person dich bittet, dir etwas zu merken oder sie später daran zu erinnern, hänge GENAU EINEN Block ans Ende deiner Antwort:
---REMEMBER---
note: <kurz, in der Formulierung der Person, worum es geht>
when: <optional: ISO-Datum JJJJ-MM-TT | relativ +Nd / +Nw | ein Kontext-Cue: NEXT_BP_LOGGED, NEXT_WEIGHT_LOGGED, NEXT_SLEEP_LOGGED, NEXT_APP_OPEN>
metric: <optional, z. B. SLEEP, BLOOD_PRESSURE>
---END---
Erfinde NIEMALS eine Erinnerung, um die die Person nicht ausdrücklich gebeten hat. Bestätige kurz im Fließtext, dass die Erinnerung zur Bestätigung vorgemerkt ist ("Vorgemerkt — bestätige sie in den Einstellungen, dann melde ich mich."). Lass "when" weg, wenn keine Zeit genannt wurde.`;
  }
  return `WHEN the user asks you to remember something or remind them later, append EXACTLY ONE block at the end of your reply:
---REMEMBER---
note: <short, in the user's own framing, what to bring back>
when: <optional: ISO date YYYY-MM-DD | relative +Nd / +Nw | a context cue: NEXT_BP_LOGGED, NEXT_WEIGHT_LOGGED, NEXT_SLEEP_LOGGED, NEXT_APP_OPEN>
metric: <optional, e.g. SLEEP, BLOOD_PRESSURE>
---END---
NEVER invent a reminder the user did not explicitly ask for. Acknowledge briefly in prose that the reminder is queued for their confirmation ("Noted — confirm it in settings and I'll bring it back."). Omit "when" if no time was stated.`;
}

type PrismaLike = Pick<typeof prisma, "coachReminder">;

/**
 * Persist a sentinel-captured reminder field-by-field (no mass assignment),
 * always `status: "proposed"` — the user promotes it to `active` through the
 * settings confirm control (`PATCH /api/coach/reminders/[id]`), exactly like a
 * Coach-extracted plan. The per-user cap refuses a write once the non-terminal
 * set is full. Best-effort: a failure never breaks the chat turn (the caller
 * fires it fire-and-forget).
 *
 * Returns the created id, or `null` when the cap displaced it / a write failed.
 */
export async function captureReminderFromSentinel(args: {
  userId: string;
  conversationId: string;
  parsed: ParsedReminderSentinel;
  now?: Date;
  db?: PrismaLike;
}): Promise<string | null> {
  const db = args.db ?? prisma;
  const { userId, conversationId, parsed } = args;

  const nonTerminal = await db.coachReminder.count({
    where: {
      userId,
      deletedAt: null,
      status: { in: ["proposed", "active", "due", "surfaced"] },
    },
  });
  if (nonTerminal >= MAX_REMINDERS_PER_USER) {
    annotate({
      action: { name: "coach.reminder.capture_capped" },
      meta: { conversationId },
    });
    return null;
  }

  const created = await db.coachReminder.create({
    data: {
      userId,
      noteEncrypted: encryptToBytes(parsed.note),
      metric: parsed.metric,
      triggerKind: parsed.trigger?.triggerKind ?? "date",
      dueAt: parsed.trigger?.dueAt ?? null,
      contextCue: parsed.trigger?.contextCue ?? null,
      // v1.30.25 — captured as `proposed`, not `active`. This was the only
      // model-driven write that persisted straight from model output with no
      // confirm step; its sibling extractors (`plans.ts`, `suggest-action.ts`)
      // have always written `proposed` and let the user-facing PATCH promote.
      // The gap mattered because a `---REMEMBER---` block is emitted by the
      // model, and the model reads a prompt containing document-sourced text —
      // so a hostile lab document could induce a reminder, and the reminder
      // recall block would then feed that text back into every later turn
      // independently of the row that seeded it. `proposed` breaks that loop
      // for free: `buildCoachRemindersBlock` already selects only
      // due / surfaced / active, so a proposed reminder never re-enters the
      // prompt, and the daily sweep never fires it, until the user confirms.
      status: "proposed",
      source: "sentinel",
      sourceConversationId: conversationId,
    },
    select: { id: true },
  });

  annotate({
    action: { name: "coach.reminder.captured" },
    meta: {
      conversationId,
      triggerKind: parsed.trigger?.triggerKind ?? "none",
      hasDue: parsed.trigger?.dueAt != null,
    },
  });
  return created.id;
}
