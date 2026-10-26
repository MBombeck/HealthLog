/**
 * Mark, skip or snooze one intake event: `POST /api/medications/intake`.
 *
 * The route authenticates (WRITE over the `medications` section), parses the
 * body and answers the schema refusal and the 404; the record-only rule, the
 * delegated refusals, the injection site, the status write and every tail
 * after it run here, in the order they always ran. Everything downstream
 * addresses the RECORD: the cross-device intake sync wakes the OWNER's iOS
 * devices, the web-clear closes the OWNER's pending dose reminder and
 * rewrites the OWNER's badge, and the compliance rollup recomputes the
 * OWNER's day. The owner is told who marked the dose at the end.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import type { SessionUser } from "@/lib/auth/session-user";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { refreshDoseSlot } from "@/lib/medications/dose-day-refresh";
import { restoreForIntake } from "@/lib/medications/inventory/consumption";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { dispatchMedicationIntakeWebClear } from "@/lib/notifications/web-push-clear";
import { notifyDelegatedIntake } from "@/lib/notifications/delegated-intake";
import { countOutstandingDosesToday } from "@/lib/medications/outstanding-doses";
import {
  refuseDelegatedChange,
  refusesUntrackedIntake,
  resolveStatusInjectionSite,
  type IntakeStatusRefusal,
  type IntakeStatusUpdate,
  type StatusUpdateEvent,
} from "./admission";
import { applyTakenStatus } from "./take";

interface StatusContext {
  user: Pick<SessionUser, "id" | "timezone">;
  actorId: string;
  existing: StatusUpdateEvent;
  ipAddress: string | null;
  originDeviceToken: string | null;
}

type UpdatedRow = Extract<
  Awaited<ReturnType<typeof applyTakenStatus>>,
  { kind: "updated" }
>["row"];

export type IntakeStatusOutcome =
  | IntakeStatusRefusal
  | { kind: "untracked" }
  | { kind: "updated"; row: UpdatedRow | null };

/** The skip and the snooze; the take has its own module. */
async function applySkipOrSnooze(ctx: StatusContext, data: IntakeStatusUpdate) {
  const { user, existing } = ctx;
  const { intakeId, status, snoozedUntil } = data;
  if (status === "skipped") {
    const updated = await prisma.medicationIntakeEvent.update({
      where: { id: intakeId },
      // Bump the reconciliation counter on the skip toggle.
      // A skip the person records clears the automatic marker.
      data: {
        takenAt: null,
        skipped: true,
        autoRecorded: false,
        syncVersion: { increment: 1 },
      },
    });
    // The row stopped being taken; refund whatever its
    // consumption stamp recorded (no-op for a never-consumed row).
    await restoreForIntake({
      client: prisma,
      userId: user.id,
      eventId: intakeId,
    });
    return updated;
  }
  // snoozed: snoozedUntil lives on the Medication row.
  const until = snoozedUntil ?? new Date(Date.now() + 30 * 60_000); // default +30min
  await prisma.medication.update({
    where: { id: existing.medicationId },
    data: { snoozedUntil: until },
  });
  return prisma.medicationIntakeEvent.findUnique({
    where: { id: intakeId },
  });
}

/**
 * The audit row, the event, the caches and the rollup rows of the day the
 * event sat on and, after a slot move, of the day it moved to.
 */
async function recordAfterUpdate(
  ctx: StatusContext,
  data: IntakeStatusUpdate,
  updated: UpdatedRow | null,
  userTzForHook: string,
): Promise<Date | undefined> {
  const { user, existing } = ctx;
  const { intakeId, status } = data;
  await auditLog("medications.intake.update", {
    userId: user.id,
    ipAddress: ctx.ipAddress,
    details: { intakeId, status },
  });

  annotate({
    action: { name: "medications.intake.update" },
    meta: { intakeId, status },
  });

  // Bust the medications + compliance + achievement
  // caches for this user so the next read reflects the dose change.
  invalidateUserMedications(user.id, { evict: true });

  // Refresh the persistent compliance rollup row for
  // the affected day so the next read after the cache miss returns
  // the up-to-date `(scheduled, taken, skipped)` tuple. Best-effort:
  // a populator failure annotates ops without blocking the response.
  await refreshDoseSlot({
    userId: user.id,
    medicationId: existing.medicationId,
    scheduledFor: existing.scheduledFor,
    tz: userTzForHook,
  });
  // A slot move re-binds the dose onto a DIFFERENT instant,
  // possibly a different local day. Recompute the target day too, or the
  // source day self-corrects while the destination keeps its stale tuple.
  const movedTo = updated?.scheduledFor;
  if (movedTo && movedTo.getTime() !== existing.scheduledFor.getTime()) {
    await refreshDoseSlot({
      userId: user.id,
      medicationId: existing.medicationId,
      scheduledFor: movedTo,
      tz: userTzForHook,
    });
  }
  return movedTo;
}

/** The tails that never affect the response. */
function startTails(
  ctx: StatusContext,
  status: IntakeStatusUpdate["status"],
  movedTo: Date | undefined,
  userTzForHook: string,
): void {
  const { user, existing } = ctx;
  // (#22) — silent cross-device intake sync. Wake the user's OTHER
  // iOS devices so a running Live Activity / Home-Screen widget reconciles
  // the dose state changed here. APNs-only, best-effort, coalesced per user:
  // the canonical row is already persisted, so a sync-push miss never
  // affects the response. The originating device (the one that POSTed) is
  // excluded via its `X-Device-Id` (= registered `Device.token`).
  queueMedicationIntakeSync({
    userId: user.id,
    originDeviceToken: ctx.originDeviceToken,
  });

  // PWA-only equivalent of the Live Activity end: when a dose is
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

  // "Somebody else marked your dose". The helper refuses on self and
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
    actorId: ctx.actorId,
    medicationId: existing.medicationId,
    status,
  });
}

/** Apply the status update to the event the route found. */
export async function updateIntakeStatus(
  ctx: StatusContext,
  data: IntakeStatusUpdate,
): Promise<IntakeStatusOutcome> {
  const { user, existing } = ctx;
  const { intakeId, status } = data;

  if (refusesUntrackedIntake(existing)) return { kind: "untracked" };

  const refused = await refuseDelegatedChange({
    userId: user.id,
    actorId: ctx.actorId,
    existing,
    intakeId,
    status,
    ipAddress: ctx.ipAddress,
  });
  if (refused) return refused;

  const site = await resolveStatusInjectionSite({
    userId: user.id,
    existing,
    injectionSite: data.injectionSite,
    status,
  });
  if (site.kind === "refused") return site;

  const userTzForHook = user.timezone ?? DEFAULT_TIMEZONE;

  let updated: UpdatedRow | null;
  if (status === "taken") {
    const taken = await applyTakenStatus({
      userId: user.id,
      intakeId,
      existing,
      takenAt: data.takenAt,
      forceSlotInstant: data.forceSlotInstant,
      resolvedInjectionSite: site.site,
      userTz: userTzForHook,
    });
    if (taken.kind === "refused") return taken;
    updated = taken.row;
  } else {
    updated = await applySkipOrSnooze(ctx, data);
  }

  const movedTo = await recordAfterUpdate(ctx, data, updated, userTzForHook);
  startTails(ctx, status, movedTo, userTzForHook);

  return { kind: "updated", row: updated };
}
