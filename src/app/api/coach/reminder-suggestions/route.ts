/**
 * POST /api/coach/reminder-suggestions — act on a Coach cadence suggestion.
 *
 * v1.18.1 (Workstream C). The Coach proposes an evidence-based measurement
 * cadence (the `---SUGGEST-REMINDER---` sentinel → `suggestion` SSE frame →
 * action card). This endpoint is what the card's buttons call:
 *
 *   - `accept`  → create a `MeasurementReminder` with `origin: COACH`,
 *                 routed through the SAME engine + endpoint semantics as the
 *                 Vorsorge surface. The server resolves the cadence from the
 *                 closed catalog (metric + interval/rrule + course window) —
 *                 the client sends only the cadence id, never a schedule.
 *   - `dismiss` → dismissal memory (never re-suggest this cadence).
 *   - `stop`    → the explicit "you measure enough — stop" path.
 *
 * Triple-dedup completion: the CREATE path here refuses a second live
 * COACH reminder for the same metric, so a re-tap or a stale card cannot
 * double-create even though the SUGGEST gate already deduped at emit time.
 */
import { NextRequest } from "next/server";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import {
  parseCoachPrefs,
  DEFAULT_REMINDER_SUGGESTION_PREFS,
} from "@/lib/validations/coach-prefs";
import { coachReminderSuggestionActionSchema } from "@/lib/validations/coach-reminder-suggestion";
import { CADENCE_CATALOG, isCadenceId } from "@/lib/ai/coach/suggest-reminder";
import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

async function postAction(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();
  // The Coach surface gates the suggestion card; mirror the gate here so a
  // disabled-coach account cannot drive the endpoint directly.
  const gate = await requireModuleEnabled(user.id, "coach");
  if (!gate.enabled) return gate.response;

  // Per-user rate limit — the action card is one-tap, so a tight per-user
  // bucket (userId, never IP) is the right granularity. Mirrors the
  // labs/restore convention; a trust-violation can never widen it.
  const rate = await checkRateLimit(
    `coach:reminder-suggestion:${user.id}`,
    30,
    60_000,
  );
  if (!rate.allowed) {
    return apiError("coach.suggestion.rateLimited", 429);
  }

  const parsed = await parseJsonBody(
    request,
    coachReminderSuggestionActionSchema,
    { maxBytes: 4 * 1024 },
  );
  if (!parsed.ok) return parsed.error;
  const { cadenceId, action } = parsed.data;

  if (!isCadenceId(cadenceId)) {
    return apiError("coach.suggestion.unknownCadence", 422);
  }
  const cadence = CADENCE_CATALOG[cadenceId];

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { coachPrefsJson: true, timezone: true },
  });
  const coachPrefs = parseCoachPrefs(row?.coachPrefsJson);
  const suggestionPrefs =
    coachPrefs.reminderSuggestions ?? DEFAULT_REMINDER_SUGGESTION_PREFS;

  // ── dismiss / stop: prefs-only writes ────────────────────────
  if (action === "dismiss" || action === "stop") {
    const next = {
      ...suggestionPrefs,
      ...(action === "stop" ? { stopped: true } : {}),
      dismissedCadences:
        action === "dismiss" &&
        !suggestionPrefs.dismissedCadences.includes(cadenceId)
          ? [...suggestionPrefs.dismissedCadences, cadenceId].slice(0, 32)
          : suggestionPrefs.dismissedCadences,
    };
    await prisma.user.update({
      where: { id: user.id },
      data: {
        coachPrefsJson: { ...coachPrefs, reminderSuggestions: next },
      },
    });
    annotate({
      action: { name: `coach.reminder.${action}` },
      meta: { cadenceId },
    });
    return apiSuccess({ ok: true, action });
  }

  // ── accept: create the reminder (origin: COACH) ──────────────
  // Module-toggle re-check at create time (defence in depth — the gate
  // already checked at emit, but a stale card could outlive a module flip).
  if (cadence.module) {
    const moduleGate = await requireModuleEnabled(user.id, cadence.module);
    if (!moduleGate.enabled) return moduleGate.response;
  }

  // Third dedup: refuse a second live COACH reminder for the same metric.
  const existing = await prisma.measurementReminder.findFirst({
    where: {
      userId: user.id,
      origin: "COACH",
      measurementType: cadence.measurementType,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (existing) {
    annotate({
      action: { name: "coach.reminder.accept.duplicate" },
      meta: { cadenceId, reminderId: existing.id },
    });
    return apiSuccess(
      { ok: true, action: "accept", reminder: null, duplicate: true },
      200,
    );
  }

  const timezone = row?.timezone || DEFAULT_TIMEZONE;
  const now = new Date();
  const endsOn =
    cadence.courseDays != null
      ? new Date(now.getTime() + cadence.courseDays * 24 * 60 * 60 * 1000)
      : null;

  const scheduleInput: ReminderScheduleInput = {
    intervalDays: cadence.intervalDays,
    rrule: cadence.rrule,
    anchorDate: null,
    notifyHour: cadence.notifyHour,
    lastSatisfiedAt: null,
    createdAt: now,
    endsOn,
  };
  const nextDueAt = computeReminderNextDueAt(scheduleInput, timezone, now);

  // Field-by-field — no mass assignment. `origin: COACH` is the
  // provenance the UI labels and the SUGGEST gate dedupes against.
  let created;
  try {
    created = await prisma.measurementReminder.create({
      data: {
        userId: user.id,
        label: cadence.labelKey,
        measurementType: cadence.measurementType,
        intervalDays: cadence.intervalDays,
        rrule: cadence.rrule,
        anchorDate: null,
        endsOn,
        origin: "COACH",
        notifyHour: cadence.notifyHour,
        location: null,
        enabled: true,
        nextDueAt,
      },
    });
  } catch (err) {
    // Structural dedup backstop: the 0172 partial unique index
    // (`origin = 'COACH' AND deleted_at IS NULL` per user+metric) wins the
    // race the read-then-create above can lose. Treat the violation as the
    // same idempotent "already have one" outcome.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      annotate({
        action: { name: "coach.reminder.accept.duplicate" },
        meta: { cadenceId, reason: "unique-violation" },
      });
      return apiSuccess(
        { ok: true, action: "accept", reminder: null, duplicate: true },
        200,
      );
    }
    throw err;
  }

  await auditLog("measurementReminder.create.coach", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { reminderId: created.id, cadenceId },
  });
  annotate({
    action: { name: "coach.reminder.accept" },
    meta: { cadenceId, reminderId: created.id },
  });

  return apiSuccess(
    {
      ok: true,
      action: "accept",
      reminder: toMeasurementReminderDto(created),
      duplicate: false,
    },
    201,
  );
}

export const POST = apiHandler(postAction);
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
