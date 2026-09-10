/**
 * Top-level medication-intake aggregator + writer.
 *
 *   GET  /api/medications/intake?scope=today
 *     → array of today's intake events for the user (across medications).
 *
 *   GET  /api/medications/intake?scope=compliance&days=N
 *     → per-day { date, scheduled, taken } for the last N days.
 *
 *   POST /api/medications/intake
 *     Body: { intakeId, status: "taken" | "skipped" | "snoozed", takenAt?, snoozedUntil? }
 *     Updates the named MedicationIntakeEvent and returns the updated row.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { checkRecordWriteRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import {
  buildScheduleAnchoredComplianceBuckets,
  type ScheduleAnchoredComplianceBucket,
} from "@/lib/analytics/schedule-anchored-compliance";
import { startOfLocalDayInTz } from "@/lib/tz/local-day";
import { projectTodayIntakesAndRecompute } from "@/lib/medications/scheduling/project-today-intakes";
import {
  applyCanonicalSlotWrite,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
} from "@/lib/medications/scheduling/slot-upsert";
import { resolveInjectionSiteForWrite } from "@/lib/medications/injection-site-write";
import {
  consumeForIntake,
  restoreForIntake,
} from "@/lib/medications/inventory/consumption";
import {
  intakeAggregateQuerySchema,
  intakeStatusUpdateSchema,
  type InjectionSiteValue,
} from "@/lib/validations/medication";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { dispatchMedicationIntakeWebClear } from "@/lib/notifications/web-push-clear";
import { notifyDelegatedIntake } from "@/lib/notifications/delegated-intake";
import { countOutstandingDosesToday } from "@/lib/medications/outstanding-doses";

// The query + body schemas moved to `@/lib/validations/medication` when this
// endpoint joined the published contract: the OpenAPI registry generates from
// the validation modules, and a schema that only exists inside a handler is
// one the spec has to restate — which is a second copy to keep in step.

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "medications");

  const parsed = intakeAggregateQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422 + audit breadcrumb keyed
    // `medications.intake.list.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.list.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; iOS-sent
    // query strings can flow into Zod issue messages.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.36.0 — through `auditLog()` rather than a bare `prisma.auditLog
    // .create`, because that helper is the only thing that stamps
    // `actorUserId`. Filed under the resolved record either way; without the
    // stamp a delegate's malformed query would read as the owner's own.
    void auditLog("medications.intake.list.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { scope, days } = parsed.data;

  // v1.4.25 W7b — anchor "today" and per-day compliance buckets to the
  // user's display timezone so a 23:30 reading in Pacific/Auckland lands
  // in today's bucket rather than yesterday's Berlin one.
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;

  if (scope === "today") {
    const todayStart = startOfLocalDayInTz(new Date(), userTz);
    const todayEnd = new Date(todayStart.getTime() + 86_400_000);

    // v1.4.39 W-SERVER-FIX — project pending intake rows for every
    // active schedule whose window opens today, then idempotently
    // backfill any missing rows. Pre-fix the endpoint returned `[]`
    // for daily meds (`schedule.daysOfWeek = null` in the DB) until
    // the reminder worker entered the RED phase at the end of the
    // dose window — leaving the iOS Dashboard tile + the "Erfassen"
    // sheet empty for the whole morning. Shared helper mirrors the
    // dashboard-summary call site so the two routes converge on the
    // same row set.
    const { projected, backfilled } = await projectTodayIntakesAndRecompute({
      userId: user.id,
      userTz,
      todayStart,
      todayEnd,
    });

    const events = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: user.id,
        // v1.7.0 sync — exclude tombstoned rows from the today list.
        deletedAt: null,
        scheduledFor: { gte: todayStart, lt: todayEnd },
      },
      orderBy: { scheduledFor: "asc" },
      include: { medication: { select: { id: true, snoozedUntil: true } } },
    });

    annotate({
      action: { name: "medications.intake.today" },
      meta: {
        count: events.length,
        projected,
        backfilled,
      },
    });

    return apiSuccess(
      events.map((e) => ({
        id: e.id,
        medicationId: e.medicationId,
        scheduledAt: e.scheduledFor.toISOString(),
        takenAt: e.takenAt?.toISOString() ?? null,
        status: e.skipped
          ? "skipped"
          : e.takenAt
            ? "taken"
            : // v1.15.9 — a never-acted dose the auto-miss cron flipped is a
              // terminal MISS, not a perpetual "pending". (Today's freshly
              // projected rows are < 24 h old so this rarely fires here, but
              // a stale row surfacing in the window reads honestly.)
              e.autoMissed
              ? "missed"
              : e.medication.snoozedUntil &&
                  e.medication.snoozedUntil > new Date()
                ? "snoozed"
                : "pending",
        snoozedUntil: e.medication.snoozedUntil?.toISOString() ?? null,
      })),
    );
  }

  // v1.4.34 IW-G — compliance: per-day scheduled vs taken for the last
  // N days. Cached at a 15-minute TTL because daily compliance buckets
  // are slow-moving (intake events trickle in, yesterday's row doesn't
  // move). Cache key carries the userTz so a user who changes timezone
  // doesn't read another tz's bucketing.
  //
  // v1.15.9 — `scheduled` is now the SCHEDULE-ANCHORED expected-dose count
  // per day (the canonical recurrence engine), NOT the count of logged
  // intake rows. The old rollup-backed path set `scheduled = COUNT(*)` of
  // intake rows, so the dashboard tile's rate (`taken / scheduled`) was ~100%
  // across every window regardless of real adherence — every logged row was
  // both numerator and denominator. Anchoring `scheduled` to the schedule
  // makes the rate genuinely reflect taken-of-expected and lets the 7/30/90
  // windows diverge with partial adherence.
  const result = await cached(
    caches.medicationsIntake as ServerCache<ScheduleAnchoredComplianceBucket[]>,
    `${user.id}|compliance|${days}|${userTz}`,
    () => buildScheduleAnchoredComplianceBuckets(user.id, days, userTz),
    annotate,
  );

  annotate({
    action: { name: "medications.intake.compliance" },
    meta: { days, count: result.length },
  });

  return apiSuccess(result);
});

export const POST = apiHandler(async (request: NextRequest) => {
  // v1.36.x — a delegated write, the canonical slot form. Everything the
  // handler does downstream addresses the RECORD and stays correct: the
  // cross-device intake sync wakes the OWNER's iOS devices, the web-clear
  // closes the OWNER's pending dose reminder and rewrites the OWNER's badge,
  // and the compliance rollup recomputes the OWNER's day. None of them can
  // address the delegate, and none of them should — the delegate's feedback is
  // the response they are already awaiting. What the owner gets instead is the
  // notification at the end of this handler.
  const { user, actor } = await requireRecordAuth("write", "medications");

  // Shared per-account write ceiling — see `checkRecordWriteRateLimit`. The
  // batch siblings have always been capped; the per-record creates a looping
  // client hits were not.
  const writeRl = await checkRecordWriteRateLimit(actor.id);
  if (!writeRl.allowed) {
    return apiError("Too many writes, try again later", 429);
  }

  const { data: body, error } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (error) return error;

  const parsed = intakeStatusUpdateSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — intake-event update hot path; multi-issue 422 +
    // audit breadcrumb keyed `medications.intake.update.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.update.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.36.x — through `auditLog()`, the only writer that stamps the actor.
    void auditLog("medications.intake.update.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const {
    intakeId,
    status,
    takenAt,
    snoozedUntil,
    injectionSite,
    forceSlotInstant,
  } = parsed.data;

  // v1.7.0 sync — a tombstoned intake 404s on a status toggle; the
  // `deletedAt: null` filter refuses to mutate a soft-deleted row.
  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: { id: intakeId, deletedAt: null },
    include: {
      medication: {
        select: {
          deliveryForm: true,
          trackInjectionSites: true,
          allowedInjectionSites: true,
        },
      },
    },
  });
  if (!existing || existing.userId !== user.id) {
    return apiError("Intake event not found", 404);
  }

  // v1.36.1 — this route is admitted for delegates because marking a dose is
  // the thing a person standing next to the patient needs to do. It is an
  // UPDATE, though, and two of the transitions it can express are not that.
  //
  // Snoozing writes `snoozedUntil` on the OWNER's medication row, and the
  // reminder cron skips a medication for as long as that stamp is in the
  // future. The field is unbounded, the owner is deliberately not notified of
  // a delegated snooze (there is nothing useful to say about a thirty-minute
  // deferral), and the activity feed renders the whole family as "marked a
  // dose". So a delegate could switch the owner's medication reminders off for
  // years, and every surface that exists to make delegation visible would
  // describe it as marking a dose. In an adherence product that is the worst
  // thing on this route.
  //
  // Flipping an already-resolved event is the other one: taken to skipped and
  // back rewrites the owner's compliance history and refunds inventory. The
  // shipped promise, on the consent screen and in the release notes, is that
  // editing what is already there stays with the owner. Marking a dose that is
  // still open is a contribution; changing a decision the owner already
  // recorded is an edit.
  //
  // Both refuse for a delegate and stay open to the owner, who is the only
  // person the snooze and the correction were ever for.
  if (actor.id !== user.id) {
    const alreadyResolved = existing.takenAt !== null || existing.skipped;
    const refusal =
      status === "snoozed"
        ? "snooze"
        : alreadyResolved
          ? "resolved_event"
          : null;
    if (refusal) {
      annotate({
        action: { name: "medications.intake.update.refused" },
        meta: { reason: refusal },
      });
      // Filed under the OWNER. `auditLog` stamps the actor itself from the
      // request's acting context, which is what puts this on the trail the
      // owner's activity panel reads — a refused attempt to change their
      // record is worth as much to them as a successful one.
      await auditLog("medications.intake.update.refused", {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: { intakeId, status, reason: refusal },
      });
      return apiError(
        refusal === "snooze"
          ? "Snoozing a reminder is not part of shared access"
          : "Changing a dose that is already recorded is not part of shared access",
        403,
        { errorCode: "sharing.not_permitted" },
      );
    }
  }

  // v1.8.5 — resolve + server-validate the optional injection site for a
  // "taken" toggle. A site outside the medication's effective allowed
  // set is a hard 422; non-injection / tracking-off / non-taken drops it.
  let resolvedInjectionSite: InjectionSiteValue | null = null;
  if (injectionSite !== undefined) {
    const userRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { globalExcludedInjectionSites: true },
    });
    const resolution = resolveInjectionSiteForWrite({
      submitted: injectionSite,
      taken: status === "taken",
      deliveryForm: existing.medication.deliveryForm,
      trackInjectionSites: existing.medication.trackInjectionSites,
      allowedInjectionSites: existing.medication
        .allowedInjectionSites as InjectionSiteValue[],
      globalExcludedInjectionSites: (userRow?.globalExcludedInjectionSites ??
        []) as InjectionSiteValue[],
    });
    if (resolution.kind === "disallowed") {
      annotate({
        action: { name: "medication.intake.injection_site.disallowed" },
        meta: { medication_id: existing.medicationId, site: resolution.site },
      });
      return apiError(
        "Injection site is not allowed for this medication",
        422,
        {
          errorCode: "medications.intake.injection_site.disallowed",
        },
      );
    }
    resolvedInjectionSite = resolution.site;
  }

  const userTzForHook = user.timezone ?? DEFAULT_TIMEZONE;

  let updated;
  if (status === "taken") {
    const resolvedTakenAt = takenAt ?? new Date();

    // v1.15.18 — re-run window-band attribution on a taken toggle so an
    // edited / off-window take re-binds to the right slot instead of leaving
    // `scheduledFor` stale (audit HIGH-4). `forceSlotInstant` pins onto a
    // named real slot (422 if it is not one); otherwise band membership picks
    // the slot (the take's own time on a miss → ad-hoc). Mirrors the
    // per-event PUT route.
    let targetScheduledFor: Date;
    if (forceSlotInstant !== undefined) {
      const forced = await resolveForcedSlotForWrite({
        userId: user.id,
        medicationId: existing.medicationId,
        userTz: userTzForHook,
        slotInstant: forceSlotInstant,
      });
      if (forced === null) {
        annotate({
          action: { name: "medication.intake.force_slot.invalid" },
          meta: { medication_id: existing.medicationId, intake_id: intakeId },
        });
        return apiError(
          "forceSlotInstant is not a scheduled slot of this medication",
          422,
          { errorCode: "medications.intake.force_slot.invalid" },
        );
      }
      targetScheduledFor = forced;
    } else {
      const attribution = await resolveSlotForWriteByBand({
        userId: user.id,
        medicationId: existing.medicationId,
        userTz: userTzForHook,
        takenAt: resolvedTakenAt,
      });
      targetScheduledFor = attribution.slotInstant ?? resolvedTakenAt;
    }

    const slotMoved =
      targetScheduledFor.getTime() !== existing.scheduledFor.getTime();

    // v1.16.10 — transition gate for the inventory consume below. Only
    // a row moving INTO taken may consume; a re-take of an already-
    // taken row (e.g. a time correction) leaves its stamp frozen, and a
    // pre-v1.16.10 taken row (NULL stamp, stock already moved by the
    // legacy hook at take time) must never retro-consume.
    const wasTaken = existing.takenAt !== null && !existing.skipped;
    if (!slotMoved) {
      [updated] = await prisma.$transaction([
        prisma.medicationIntakeEvent.update({
          where: { id: intakeId },
          // v1.7.0 sync — bump the reconciliation counter on every
          // server-side mutation so the delta feed echoes a monotonic value.
          data: {
            takenAt: resolvedTakenAt,
            skipped: false,
            syncVersion: { increment: 1 },
            // v1.8.5 — persist the resolved site on the taken branch.
            ...(resolvedInjectionSite !== null && {
              injectionSite: resolvedInjectionSite,
            }),
          },
        }),
        prisma.medication.update({
          where: { id: existing.medicationId },
          data: { snoozedUntil: null },
        }),
      ]);
      // v1.16.10 — the toggle recorded a take; consume inventory units
      // on the genuine pending→taken (or skipped→taken) transition. The
      // stamp additionally keeps a racing replay exactly-once.
      if (!wasTaken) {
        await consumeForIntake({
          client: prisma,
          userId: user.id,
          medicationId: existing.medicationId,
          eventId: intakeId,
          intakeAt: resolvedTakenAt,
        });
      }
    } else {
      // The take re-attributed to a different slot. Tombstone the source row
      // and route the dose through the shared canonical-slot upsert, which
      // converges onto any row already at the target slot rather than
      // bare-updating into an occupied slot (P2002-safe).
      //
      // v1.16.10 — refund the source row's consumption stamp BEFORE the
      // tombstone, then consume on the converged row below: a slot move
      // is a re-binding of one real dose, so the stock nets exactly one
      // consumption.
      await restoreForIntake({
        client: prisma,
        userId: user.id,
        eventId: intakeId,
      });
      await prisma.medicationIntakeEvent.update({
        where: { id: intakeId },
        data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
      });
      const applied = await applyCanonicalSlotWrite({
        client: prisma,
        userId: user.id,
        medicationId: existing.medicationId,
        canonicalSlot: targetScheduledFor,
        takenAt: resolvedTakenAt,
        skipped: false,
        isExplicitTaken: true,
        isExplicitSkip: false,
        idempotencyKey: null,
        createSource: "WEB",
        // v1.16.9 — carry the recorded site / dose override across the
        // tombstone + re-insert: a slot move is a re-binding, not a new
        // dose, so the original row's documentation must survive when the
        // toggle write itself carries none.
        injectionSite:
          resolvedInjectionSite ??
          (existing.injectionSite as InjectionSiteValue | null),
        doseTaken: existing.doseTaken,
      });
      updated = applied.row;
      await prisma.medication.update({
        where: { id: existing.medicationId },
        data: { snoozedUntil: null },
      });
      // v1.16.10 — consume on the converged row (the old row's stamp
      // was refunded above, so the move nets one consumption). A taken
      // source WITHOUT a stamp is a pre-v1.16.10 row whose stock moved
      // through the legacy hook: the refund above was a no-op, so
      // consuming on the target would double-charge — skip it.
      if (!wasTaken || existing.inventoryConsumption !== null) {
        await consumeForIntake({
          client: prisma,
          userId: user.id,
          medicationId: existing.medicationId,
          eventId: applied.row.id,
          intakeAt: resolvedTakenAt,
        });
      }
    }
  } else if (status === "skipped") {
    updated = await prisma.medicationIntakeEvent.update({
      where: { id: intakeId },
      // v1.7.0 sync — bump the reconciliation counter on the skip toggle.
      data: { takenAt: null, skipped: true, syncVersion: { increment: 1 } },
    });
    // v1.16.10 — the row stopped being taken; refund whatever its
    // consumption stamp recorded (no-op for a never-consumed row).
    await restoreForIntake({
      client: prisma,
      userId: user.id,
      eventId: intakeId,
    });
  } else {
    // snoozed: snoozedUntil lives on the Medication row.
    const until = snoozedUntil ?? new Date(Date.now() + 30 * 60_000); // default +30min
    await prisma.medication.update({
      where: { id: existing.medicationId },
      data: { snoozedUntil: until },
    });
    updated = await prisma.medicationIntakeEvent.findUnique({
      where: { id: intakeId },
    });
  }

  await auditLog("medications.intake.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { intakeId, status },
  });

  annotate({
    action: { name: "medications.intake.update" },
    meta: { intakeId, status },
  });

  // v1.4.34 IW-G — bust the medications + compliance + achievement
  // caches for this user so the next read reflects the dose change.
  invalidateUserMedications(user.id, { evict: true });

  // v1.4.39 W-MED — refresh the persistent compliance rollup row for
  // the affected day so the next read after the cache miss returns
  // the up-to-date `(scheduled, taken, skipped)` tuple. Best-effort:
  // a populator failure annotates ops without blocking the response.
  await recomputeMedicationComplianceForEvent({
    userId: user.id,
    medicationId: existing.medicationId,
    scheduledFor: existing.scheduledFor,
    tz: userTzForHook,
  });
  // v1.16.9 — a slot move re-binds the dose onto a DIFFERENT instant,
  // possibly a different local day. Recompute the target day too, or the
  // source day self-corrects while the destination keeps its stale tuple.
  const movedTo = updated?.scheduledFor;
  if (movedTo && movedTo.getTime() !== existing.scheduledFor.getTime()) {
    await recomputeMedicationComplianceForEvent({
      userId: user.id,
      medicationId: existing.medicationId,
      scheduledFor: movedTo,
      tz: userTzForHook,
    });
  }

  // v1.17.1 (#22) — silent cross-device intake sync. Wake the user's OTHER
  // iOS devices so a running Live Activity / Home-Screen widget reconciles
  // the dose state changed here. APNs-only, best-effort, coalesced per user:
  // the canonical row is already persisted, so a sync-push miss never
  // affects the response. The originating device (the one that POSTed) is
  // excluded via its `X-Device-Id` (= registered `Device.token`).
  queueMedicationIntakeSync({
    userId: user.id,
    originDeviceToken: request.headers.get("x-device-id"),
  });

  // v1.18.4 — PWA-only equivalent of the Live Activity end: when a dose is
  // resolved (taken / skipped), push a `type:"clear"` to the user's Web Push
  // subscriptions so the still-pending dose-due reminder for this slot is
  // closed by the service worker (matched on the stable slot tag) and the app
  // badge re-reflects the outstanding-dose count. A snooze leaves the dose
  // outstanding, so it neither clears the reminder nor changes the badge.
  if (status === "taken" || status === "skipped") {
    void (async () => {
      const badgeCount = await countOutstandingDosesToday(
        user.id,
        userTzForHook,
      );
      await dispatchMedicationIntakeWebClear({
        userId: user.id,
        medicationId: existing.medicationId,
        scheduledFor: (movedTo ?? existing.scheduledFor).toISOString(),
        badgeCount,
      });
    })();
  }

  // v1.36.x — "somebody else marked your dose". The helper refuses on self and
  // on a snooze, resolves both names itself, and never throws.
  //
  // Fire and forget, like every neighbour above. The dispatcher awaits each
  // channel in the cascade, so an unreachable one would have added its whole
  // timeout to the caregiver's request — the person standing next to the
  // patient waiting for a dose to register. The helper never throws, and the
  // owner learning a moment later is the right trade against the tick being
  // slow. The integration test already polls the ledger rather than relying on
  // the await, so nothing about the proof weakens.
  void notifyDelegatedIntake({
    ownerId: user.id,
    actorId: actor.id,
    medicationId: existing.medicationId,
    status,
  });

  return apiSuccess(updated);
});
