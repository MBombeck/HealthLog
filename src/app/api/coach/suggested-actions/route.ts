/**
 * POST /api/coach/suggested-actions — confirm a generalised Coach action card.
 *
 * v1.22 — the confirm half of the generalised propose→confirm moat. The
 * Coach proposes an action via the closed `---SUGGEST-ACTION---` sentinel →
 * `suggestedAction` SSE frame → `<SuggestedActionCard>`. This endpoint is what
 * the card's confirm button calls. It switches on the CLOSED `actionType`
 * allowlist and, for each, builds the entity FIELD-BY-FIELD from a
 * server-resolved spec:
 *
 *   - `checkup.create` → a preventive-care Vorsorge `MeasurementReminder`
 *     (free-text label + a closed interval id the SERVER resolves to an RRULE),
 *     minted through the SAME engine the Vorsorge surface uses.
 *   - `reminder.note`  → a `CoachReminder` (note + optional closed `when`
 *     grammar + optional metric).
 *
 * HARD SAFETY: never auto-apply (this endpoint runs only on the explicit
 * confirm tap); closed allowlist only (the discriminated-union Zod gate rejects
 * any other `actionType`); NEVER a medication / dose / clinical-target change.
 * Cookie-auth, coach module-gated, per-user rate-limited, owner-scoped — no
 * IDOR, no mass assignment.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  resolveWhenGrammar,
  MAX_REMINDERS_PER_USER,
} from "@/lib/ai/coach/reminders";
import { CHECKUP_INTERVAL_CATALOG } from "@/lib/ai/coach/suggest-action";
import { coachSuggestedActionSchema } from "@/lib/validations/coach-reminder";
import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

const CHECKUP_NOTIFY_HOUR = 9;

async function postAction(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "coach");
  if (!gate.enabled) return gate.response;

  const rate = await checkRateLimit(
    `coach:suggested-action:${user.id}`,
    30,
    60_000,
  );
  if (!rate.allowed) return apiError("coach.action.rateLimited", 429);

  const parsed = await parseJsonBody(request, coachSuggestedActionSchema, {
    maxBytes: 4 * 1024,
  });
  if (!parsed.ok) return parsed.error;
  const action = parsed.data;

  // ── checkup.create → a preventive-care Vorsorge reminder ─────
  if (action.actionType === "checkup.create") {
    // The model named an interval id; the SERVER owns the RRULE so the model
    // can never mint an arbitrary schedule.
    const preset = CHECKUP_INTERVAL_CATALOG[action.interval];
    if (!preset) return apiError("coach.action.unknownInterval", 422);

    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { timezone: true },
    });
    const timezone = row?.timezone || DEFAULT_TIMEZONE;
    const now = new Date();
    const scheduleInput: ReminderScheduleInput = {
      intervalDays: null,
      rrule: preset.rrule,
      anchorDate: null,
      notifyHour: CHECKUP_NOTIFY_HOUR,
      lastSatisfiedAt: null,
      createdAt: now,
      endsOn: null,
    };
    const nextDueAt = computeReminderNextDueAt(scheduleInput, timezone, now);

    // Field-by-field — no mass assignment. A free-text checklist Vorsorge
    // (measurementType null) so it resolves only on a manual "done". origin
    // COACH marks the provenance.
    const created = await prisma.measurementReminder.create({
      data: {
        userId: user.id,
        label: action.label,
        measurementType: null,
        intervalDays: null,
        rrule: preset.rrule,
        anchorDate: null,
        endsOn: null,
        origin: "COACH",
        notifyHour: CHECKUP_NOTIFY_HOUR,
        location: null,
        enabled: true,
        nextDueAt,
      },
    });

    await auditLog("measurementReminder.create.coachAction", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { reminderId: created.id, interval: action.interval },
    });
    annotate({
      action: { name: "coach.action.applied" },
      meta: { actionType: action.actionType, interval: action.interval },
    });

    return apiSuccess(
      {
        ok: true,
        actionType: action.actionType,
        reminder: toMeasurementReminderDto(created),
      },
      201,
    );
  }

  // ── reminder.note → a CoachReminder ──────────────────────────
  const now = new Date();
  let trigger: ReturnType<typeof resolveWhenGrammar> = null;
  if (action.when) {
    trigger = resolveWhenGrammar(action.when, now);
    if (!trigger) return apiError("coach.reminder.invalidWhen", 422);
  }

  const nonTerminal = await prisma.coachReminder.count({
    where: {
      userId: user.id,
      deletedAt: null,
      status: { in: ["proposed", "active", "due", "surfaced"] },
    },
  });
  if (nonTerminal >= MAX_REMINDERS_PER_USER) {
    return apiError("coach.reminder.capReached", 409);
  }

  const created = await prisma.coachReminder.create({
    data: {
      userId: user.id,
      noteEncrypted: encryptToBytes(action.note),
      metric: action.metric ?? null,
      triggerKind: trigger?.triggerKind ?? "date",
      dueAt: trigger?.dueAt ?? null,
      contextCue: trigger?.contextCue ?? null,
      status: "active",
      source: "action",
    },
    select: { id: true },
  });

  annotate({
    action: { name: "coach.action.applied" },
    meta: {
      actionType: action.actionType,
      hasDue: trigger?.dueAt != null,
    },
  });

  return apiSuccess(
    { ok: true, actionType: action.actionType, reminderId: created.id },
    201,
  );
}

export const POST = apiHandler(postAction);
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
