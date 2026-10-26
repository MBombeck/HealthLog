/**
 * Record one dose of one medication: `POST /api/medications/{id}/intake`.
 *
 * The route authenticates (WRITE over the `medications` section), runs the
 * intake guard, parses the body and answers the schema refusal and the
 * delegated outcome-change refusal; the injection-site check, the slot
 * attribution, the replay and dedup answers, the write and every tail after
 * it run here, in the order they always ran.
 */
import type { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import type { SessionUser } from "@/lib/auth/session-user";
import type { intakeSchema } from "@/lib/validations/medication";
import { resolveInjectionSiteForWrite } from "@/lib/medications/injection-site-write";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";
import {
  consumeForIntake,
  restoreForIntake,
} from "@/lib/medications/inventory/consumption";
import { reconcileOneShotState } from "@/lib/medications/lifecycle";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { dispatchMedicationIntakeWebClear } from "@/lib/notifications/web-push-clear";
import { countOutstandingDosesToday } from "@/lib/medications/outstanding-doses";
import { notifyDelegatedIntake } from "@/lib/notifications/delegated-intake";
import { refreshDoseSlot } from "@/lib/medications/dose-day-refresh";
import {
  resolveIntakeAttribution,
  type IntakeWriteRefusal,
} from "./attribution";
import {
  findReplayedIntake,
  writeIntake,
  type IntakeWriteResult,
} from "./write";

export type IntakeInput = z.output<typeof intakeSchema>;

type WrittenIntake = Extract<IntakeWriteResult, { kind: "written" }>;

export type RecordIntakeOutcome =
  | IntakeWriteRefusal
  | Exclude<IntakeWriteResult, WrittenIntake>
  | { kind: "recorded"; event: WrittenIntake["event"] };

interface RecordIntakeContext {
  user: Pick<SessionUser, "id" | "timezone">;
  actorId: string;
  medicationId: string;
  intakeSource: "API" | "WEB";
  isDelegated: boolean;
  ipAddress: string | null;
  originDeviceToken: string | null;
}

/**
 * Resolve + server-validate the optional injection site. Load the
 * medication's delivery form + tracking opt-in + per-medication allowed
 * sites, plus the user's global exclusion deny-list. A site outside the
 * effective allowed set is a hard 422; a site on a non-injection /
 * tracking-off med (or a skip) is silently dropped.
 */
async function resolveInjectionSite(
  ctx: RecordIntakeContext,
  data: IntakeInput,
): Promise<
  { kind: "site"; site: InjectionSiteKey | null } | IntakeWriteRefusal
> {
  const { user, medicationId: id } = ctx;
  const { injectionSite, skipped } = data;
  let resolvedInjectionSite: InjectionSiteKey | null = null;
  if (injectionSite !== undefined) {
    const [med, userRow] = await Promise.all([
      prisma.medication.findUnique({
        where: { id },
        select: {
          deliveryForm: true,
          trackInjectionSites: true,
          allowedInjectionSites: true,
        },
      }),
      prisma.user.findUnique({
        where: { id: user.id },
        select: { globalExcludedInjectionSites: true },
      }),
    ]);
    const resolution = resolveInjectionSiteForWrite({
      submitted: injectionSite,
      taken: !skipped,
      deliveryForm: med?.deliveryForm ?? "ORAL",
      trackInjectionSites: med?.trackInjectionSites ?? false,
      allowedInjectionSites: (med?.allowedInjectionSites ??
        []) as InjectionSiteKey[],
      globalExcludedInjectionSites: (userRow?.globalExcludedInjectionSites ??
        []) as InjectionSiteKey[],
    });
    if (resolution.kind === "disallowed") {
      annotate({
        action: { name: "medication.intake.injection_site.disallowed" },
        meta: { medication_id: id, site: resolution.site },
      });
      return {
        kind: "refused",
        message: "Injection site is not allowed for this medication",
        errorCode: "medications.intake.injection_site.disallowed",
      };
    }
    resolvedInjectionSite = resolution.site;
  }
  return { kind: "site", site: resolvedInjectionSite };
}

/**
 * Inventory consumption / restore. A taken write consumes `unitsPerDose`
 * units (the stamp on the event row makes replays and re-posts exactly-once;
 * `consumedTransition` skips the read for the no-op echo cases the slot
 * upsert already classified). An explicit skip can downgrade a
 * previously-taken row (last-write-wins), so it refunds whatever that row's
 * stamp recorded. Both hooks are best-effort and never block the intake
 * write.
 */
async function settleInventory(
  ctx: RecordIntakeContext,
  skipped: boolean,
  written: WrittenIntake,
): Promise<void> {
  const { user, medicationId: id } = ctx;
  const { event, consumedTransition } = written;
  if (!skipped && consumedTransition) {
    await consumeForIntake({
      client: prisma,
      userId: user.id,
      medicationId: id,
      eventId: event.id,
      intakeAt: event.takenAt ?? event.scheduledFor,
    });
  } else if (skipped) {
    await restoreForIntake({
      client: prisma,
      userId: user.id,
      eventId: event.id,
    });
  }
}

/** The audit row, the event, the caches, the rollup and the lifecycle. */
async function recordAfterWrite(
  ctx: RecordIntakeContext,
  skipped: boolean,
  event: WrittenIntake["event"],
): Promise<void> {
  const { user, medicationId: id } = ctx;
  await auditLog("medication.intake", {
    userId: user.id,
    ipAddress: ctx.ipAddress,
    details: {
      medicationId: id,
      eventId: event.id,
      skipped,
    },
  });

  annotate({
    action: {
      name: "medication.intake",
      entity_type: "intake_event",
      entity_id: event.id,
    },
    meta: {
      medication_id: id,
      skipped,
    },
  });

  // Bust per-user medications + compliance + achievement
  // caches so the next read reflects the dose event.
  invalidateUserMedications(user.id, { evict: true });

  // Refresh the persistent compliance rollup for the
  // affected day. The hook is best-effort; failures annotate but never
  // block the user's POST response.
  await refreshDoseSlot({
    userId: user.id,
    medicationId: id,
    scheduledFor: event.scheduledFor,
    tz: user.timezone,
  });

  // One-shot lifecycle reconciliation. A `oneShot` medication
  // has at most one live intake; the helper re-reads the most recent
  // non-skipped intake and flips `active` to match. Idempotent on
  // non-one-shot medications (the underlying updateMany is gated by
  // `oneShot:true`). The flip runs AFTER the intake row is committed
  // so a flaky write never deactivates a medication that didn't
  // actually receive its dose.
  const reconcileAction = await reconcileOneShotState(prisma, id, user.id);
  if (reconcileAction !== "noop") {
    invalidateUserMedications(user.id, { evict: true });
  }
}

/** The tails that never affect the response. */
function startTails(
  ctx: RecordIntakeContext,
  skipped: boolean,
  event: WrittenIntake["event"],
): void {
  const { user, medicationId: id } = ctx;
  // (#22) — silent cross-device intake sync: wake the user's OTHER iOS
  // devices so a running Live Activity / widget reconciles this dose.
  // Coalesced per user, best-effort — never affects the response.
  queueMedicationIntakeSync({
    userId: user.id,
    originDeviceToken: ctx.originDeviceToken,
  });

  // PWA counterpart of the sync wake above: a dose resolved here (taken or
  // skipped) closes the still-pending dose-due Web Push reminder for the
  // slot and refreshes the app badge. The other intake routes have carried
  // this since v1.18.4; this route is the replay target of the iOS offline
  // queue, so a drained dose must clear the web reminder the same way.
  // Best-effort, fire-and-forget — the canonical row is already persisted.
  void (async () => {
    const badgeCount = await countOutstandingDosesToday(user.id, user.timezone);
    await dispatchMedicationIntakeWebClear({
      userId: user.id,
      medicationId: id,
      scheduledFor: event.scheduledFor.toISOString(),
      badgeCount,
    });
  })();

  // "Somebody else marked your dose". This route has no snooze arm,
  // so the state is whichever of the two markings the payload carried. The
  // helper refuses on self, so a person marking their own dose is unaffected.
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
    medicationId: id,
    status: skipped ? "skipped" : "taken",
  });
}

/** Record the dose the route parsed. */
export async function recordIntake(
  ctx: RecordIntakeContext,
  data: IntakeInput,
): Promise<RecordIntakeOutcome> {
  const { user, medicationId: id } = ctx;
  const { scheduledFor, takenAt, skipped, idempotencyKey, doseTaken } = data;

  // The dose override documents a consumed dose, so it only
  // applies to a taken (non-skipped) write; on a skip it is silently
  // dropped (the slot consumed nothing).
  const resolvedDoseTaken = !skipped && doseTaken ? doseTaken : null;

  const site = await resolveInjectionSite(ctx, data);
  if (site.kind === "refused") return site;

  const resolvedTakenAt = skipped ? null : (takenAt ?? new Date());
  const incomingScheduledFor = scheduledFor ?? takenAt ?? new Date();

  const attribution = await resolveIntakeAttribution({
    user,
    medicationId: id,
    skipped,
    scheduledFor,
    forceSlotInstant: data.forceSlotInstant,
    resolvedTakenAt,
    incomingScheduledFor,
  });
  if (attribution.kind === "refused") return attribution;

  const write = {
    userId: user.id,
    medicationId: id,
    canonicalSlot: attribution.canonicalSlot,
    attributionSource: attribution.attributionSource,
    scheduledFor,
    skipped,
    idempotencyKey,
    resolvedTakenAt,
    incomingScheduledFor,
    intakeSource: ctx.intakeSource,
    isDelegated: ctx.isDelegated,
    resolvedInjectionSite: site.site,
    resolvedDoseTaken,
  };
  const replayed = await findReplayedIntake(write);
  if (replayed) return { kind: "existing", row: replayed };

  const written = await writeIntake(write);
  if (written.kind !== "written") return written;

  await settleInventory(ctx, skipped, written);
  await recordAfterWrite(ctx, skipped, written.event);
  startTails(ctx, skipped, written.event);

  return { kind: "recorded", event: written.event };
}
