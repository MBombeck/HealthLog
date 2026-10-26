/**
 * GET  /api/coach/reminders — list the caller's Coach episodic reminders.
 * POST /api/coach/reminders — create one manually (the ledger "+ add" path).
 *
 * v1.22 — the management + in-app-surface read for the durable
 * "remind me about X" memory the Coach captures inline via the `---REMEMBER---`
 * sentinel. The note free-text is decrypted on the fly; an undecryptable row (a
 * key rotated out of the map) is skipped rather than 500ing the whole list.
 *
 * Ownership: every query is scoped `where: { userId, ... }`, so a caller can
 * only ever see / create their own reminders. The owner is always narrowed from
 * the session, never the body.
 *
 * GET is not gated on the Coach. A reminder is the person's own stored record:
 * reading it never depends on the Coach being available, the same rule as the
 * stored facts, conversations and plans (a Coach switched off by the operator
 * or hidden by the person must not lock them out of what it kept). POST is
 * Coach use and stays gated by `requireModuleEnabled(userId, "coach")`.
 *
 * `?status=` optionally filters (one status, or a comma set like `due,surfaced`
 * for the in-app tile). Omitted returns the non-terminal set (proposed / active
 * / due / surfaced), soonest-due first.
 */
import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit } from "@/lib/rate-limit";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  resolveWhenGrammar,
  MAX_REMINDERS_PER_USER,
} from "@/lib/ai/coach/reminders";
import {
  coachRemindersListQuerySchema,
  coachReminderCreateSchema,
} from "@/lib/validations/coach-reminder";

const NON_TERMINAL = ["proposed", "active", "due", "surfaced"] as const;

interface ReminderRow {
  id: string;
  metric: string | null;
  noteEncrypted: Uint8Array;
  triggerKind: string;
  dueAt: Date | null;
  contextCue: string | null;
  status: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: ReminderRow, note: string) {
  return {
    id: row.id,
    note,
    metric: row.metric,
    triggerKind: row.triggerKind,
    dueAt: row.dueAt?.toISOString() ?? null,
    contextCue: row.contextCue,
    status: row.status,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const GET = apiHandler(async (req: Request) => {
  // The RECORD's reminder ledger. A "remind me about X" note is a statement
  // about the owner's own health, stored on the owner's row and encrypted with
  // it — the same shape as a mood note or a measurement note, both of which
  // are already delegable reads. A delegate reading it is the caregiver case
  // the feature exists for; an actor answer here would light the FAB's dot for
  // the delegate's own ledger while the page shows another person's record,
  // which is the failure mode this whole mode system exists to prevent.
  //
  // No Coach gate: the ledger is readable whatever the Coach's state, for the
  // owner and for a delegate with a read grant alike, like the mood note.
  const { user } = await requireRecordAuth("read", "record");

  const url = new URL(req.url);
  const parsed = coachRemindersListQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
  });
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  const statusWhere = parsed.data.status
    ? { status: { in: parsed.data.status } }
    : { status: { in: [...NON_TERMINAL] } };

  const rows = (await prisma.coachReminder.findMany({
    where: { userId: user.id, deletedAt: null, ...statusWhere },
    orderBy: [{ dueAt: "asc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      metric: true,
      noteEncrypted: true,
      triggerKind: true,
      dueAt: true,
      contextCue: true,
      status: true,
      source: true,
      createdAt: true,
      updatedAt: true,
    },
  })) as ReminderRow[];

  const reminders: ReturnType<typeof toDto>[] = [];
  for (const row of rows) {
    let note: string;
    try {
      note = decryptFromBytes(row.noteEncrypted);
    } catch {
      // Fail closed per row — never surface ciphertext, never 500 the list.
      continue;
    }
    reminders.push(toDto(row, note));
  }

  annotate({
    action: { name: "coach.reminders.listed" },
    meta: { count: reminders.length },
  });

  return apiSuccess({ reminders });
});

export const POST = apiHandler(async (req: Request) => {
  // Deliberately still bare, so it refuses under a switch. Writing into
  // somebody else's Coach memory is not adding a reading to their record: the
  // note is what the Coach reads back to the OWNER in their own conversation,
  // and putting a delegate's words in that voice is not a thing a caregiver
  // grant should buy. A delegate who wants to record something writes it where
  // it belongs — a measurement, a side effect, an allergy — all of which are
  // delegable creates that file an audit row naming them.
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "coach");
  if (!gate.enabled) return gate.response;

  const rate = await checkRateLimit(
    `coach-reminders:create:${user.id}`,
    30,
    60_000,
  );
  if (!rate.allowed) return apiError("Too many requests", 429);

  const parsed = await parseJsonBody(req, coachReminderCreateSchema, {
    maxBytes: 4 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  // Resolve the optional `when` against the closed grammar; an invalid token
  // 422s rather than silently dropping the timing the user asked for.
  const now = new Date();
  let trigger: ReturnType<typeof resolveWhenGrammar> = null;
  if (parsed.data.when) {
    trigger = resolveWhenGrammar(parsed.data.when, now);
    if (!trigger) return apiError("coach.reminder.invalidWhen", 422);
  }

  // Per-user cap on the non-terminal set.
  const nonTerminal = await prisma.coachReminder.count({
    where: {
      userId: user.id,
      deletedAt: null,
      status: { in: [...NON_TERMINAL] },
    },
  });
  if (nonTerminal >= MAX_REMINDERS_PER_USER) {
    return apiError("coach.reminder.capReached", 409);
  }

  // Field-by-field — no mass assignment. Manual reminders are active on create.
  const created = await prisma.coachReminder.create({
    data: {
      userId: user.id,
      noteEncrypted: encryptToBytes(parsed.data.note),
      metric: parsed.data.metric ?? null,
      triggerKind: trigger?.triggerKind ?? "date",
      dueAt: trigger?.dueAt ?? null,
      contextCue: trigger?.contextCue ?? null,
      status: "active",
      source: "manual",
    },
    select: {
      id: true,
      metric: true,
      noteEncrypted: true,
      triggerKind: true,
      dueAt: true,
      contextCue: true,
      status: true,
      source: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  annotate({
    action: { name: "coach.reminders.created" },
    meta: { triggerKind: created.triggerKind, hasDue: created.dueAt != null },
  });

  return apiSuccess(
    { reminder: toDto(created as ReminderRow, parsed.data.note) },
    201,
  );
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
