/**
 * PATCH  /api/coach/reminders/[id] — confirm / update a reminder's lifecycle.
 * DELETE /api/coach/reminders/[id] — soft-delete one reminder.
 *
 * v1.22 — the user-confirm + management surface for the Coach episodic
 * reminders. `status` confirms a `proposed` reminder (→ active), marks it
 * `done` / `dismissed`, or re-activates it; `when` re-schedules (snooze) via the
 * closed grammar. The body never carries the note text, so a client can never
 * inject or overwrite a reminder's prose — only its lifecycle / timing.
 *
 * Ownership + existence privacy: every mutation is scoped
 * `where: { id, userId, deletedAt: null }` via `updateMany`, so a cross-user id,
 * an unknown id, or an already-deleted reminder all resolve to a `count: 0`
 * no-op rather than a P2025 throw — the existence channel never leaks across
 * accounts. PATCH on a 0-count match returns 404; DELETE returns the idempotent
 * `{ deleted: false }`.
 *
 * PATCH is Coach use (it confirms, resolves or reschedules what the Coach
 * captured) and is gated by `requireModuleEnabled(userId, "coach")`. DELETE is
 * not: erasing one's own stored reminder never depends on the Coach being
 * available, the same rule as the stored facts, conversations and plans.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { resolveWhenGrammar } from "@/lib/ai/coach/reminders";
import { coachReminderPatchSchema } from "@/lib/validations/coach-reminder";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const MUTATE_RATE_LIMIT = 40;
const MUTATE_WINDOW_MS = 60_000;

async function enforceMutateLimit(
  op: string,
  userId: string,
): Promise<Response | null> {
  const rl = await checkRateLimit(
    `coach-reminders:${op}:${userId}`,
    MUTATE_RATE_LIMIT,
    MUTATE_WINDOW_MS,
  );
  if (rl.allowed) return null;
  const response = apiError("Too many requests", 429);
  for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
    response.headers.set(k, v);
  }
  return response;
}

export const PATCH = apiHandler(async (req: NextRequest, ctx: RouteCtx) => {
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "coach");
  if (!gate.enabled) return gate.response;

  const limited = await enforceMutateLimit("patch", user.id);
  if (limited) return limited;

  const { id } = await ctx.params;

  const parsed = await parseJsonBody(req, coachReminderPatchSchema, {
    maxBytes: 4 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  // Field-by-field (no mass assignment): only the lifecycle / timing fields the
  // body carried are written; the note + encrypted text are never touched here.
  const data: {
    status?: string;
    dueAt?: Date | null;
    triggerKind?: string;
    contextCue?: string | null;
  } = {};
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  if (parsed.data.when !== undefined) {
    if (parsed.data.when === null) {
      data.dueAt = null;
      data.triggerKind = "date";
      data.contextCue = null;
    } else {
      const trigger = resolveWhenGrammar(parsed.data.when, new Date());
      if (!trigger) return apiError("coach.reminder.invalidWhen", 422);
      data.dueAt = trigger.dueAt;
      data.triggerKind = trigger.triggerKind;
      data.contextCue = trigger.contextCue;
    }
  }

  const { count } = await prisma.coachReminder.updateMany({
    where: { id, userId: user.id, deletedAt: null },
    data,
  });

  if (count === 0) return apiError("Reminder not found", 404);

  const row = await prisma.coachReminder.findFirst({
    where: { id, userId: user.id },
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
  if (!row) return apiError("Reminder not found", 404);

  let note: string | null = null;
  try {
    note = decryptFromBytes(row.noteEncrypted);
  } catch {
    note = null;
  }

  annotate({
    action: { name: "coach.reminders.updated" },
    meta: { status: row.status },
  });

  return apiSuccess({
    reminder: {
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
    },
  });
});

export const DELETE = apiHandler(
  async (_request: NextRequest, ctx: RouteCtx) => {
    const { user } = await requireAuth();

    const limited = await enforceMutateLimit("delete", user.id);
    if (limited) return limited;

    const { id } = await ctx.params;

    const { count } = await prisma.coachReminder.updateMany({
      where: { id, userId: user.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    const deleted = count > 0;
    annotate({
      action: { name: "coach.reminders.deleted" },
      meta: { deleted },
    });
    return apiSuccess({ deleted });
  },
);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
