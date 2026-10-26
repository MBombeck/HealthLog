/**
 * Whether a status update to `POST /api/medications/intake` may touch the
 * event it names: the live event under the record, the record-only rule, the
 * delegated refusals, and the injection site it carries.
 */
import type { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { resolveInjectionSiteForWrite } from "@/lib/medications/injection-site-write";
import {
  type InjectionSiteValue,
  type intakeStatusUpdateSchema,
} from "@/lib/validations/medication";
import { isRecordOnly } from "@/lib/medications/intake-tracking";

export type IntakeStatusUpdate = z.output<typeof intakeStatusUpdateSchema>;

/** A refusal the route answers with `apiError(message, status, meta)`. */
export interface IntakeStatusRefusal {
  kind: "refused";
  message: string;
  status: number;
  errorCode: string;
}

/**
 * The live event a status update may change, with what the site check needs
 * of its medication, or null for the route's 404. A tombstoned intake 404s on
 * a status toggle; the `deletedAt: null` filter refuses to mutate a
 * soft-deleted row.
 */
export async function findIntakeForStatusUpdate(input: {
  userId: string;
  intakeId: string;
}) {
  const existing = await prisma.medicationIntakeEvent.findFirst({
    where: { id: input.intakeId, deletedAt: null },
    include: {
      medication: {
        select: {
          deliveryForm: true,
          trackInjectionSites: true,
          allowedInjectionSites: true,
          trackIntake: true,
        },
      },
    },
  });
  if (!existing || existing.userId !== input.userId) {
    return null;
  }
  return existing;
}

export type StatusUpdateEvent = NonNullable<
  Awaited<ReturnType<typeof findIntakeForStatusUpdate>>
>;

/**
 * A record-only medication keeps the doses it already has, and an owner may
 * still correct one of those (that is an edit of history). What it no longer
 * takes is a NEW dose: resolving or snoozing an event that is still open
 * would record one, and it would then be counted nowhere (iOS #116, item
 * 15). Refused by name, the same code the per-medication route answers with.
 */
export function refusesUntrackedIntake(existing: StatusUpdateEvent): boolean {
  const stillOpen = existing.takenAt === null && !existing.skipped;
  return stillOpen && isRecordOnly(existing.medication);
}

/**
 * This route is admitted for delegates because marking a dose is the thing a
 * person standing next to the patient needs to do. It is an UPDATE, though,
 * and two of the transitions it can express are not that.
 *
 * Snoozing writes `snoozedUntil` on the OWNER's medication row, and the
 * reminder cron skips a medication for as long as that stamp is in the
 * future. The field is unbounded, the owner is deliberately not notified of
 * a delegated snooze (there is nothing useful to say about a thirty-minute
 * deferral), and the activity feed renders the whole family as "marked a
 * dose". So a delegate could switch the owner's medication reminders off for
 * years, and every surface that exists to make delegation visible would
 * describe it as marking a dose. In an adherence product that is the worst
 * thing on this route.
 *
 * Flipping an already-resolved event is the other one: taken to skipped and
 * back rewrites the owner's compliance history and refunds inventory. The
 * shipped promise, on the consent screen and in the release notes, is that
 * editing what is already there stays with the owner. Marking a dose that is
 * still open is a contribution; changing a decision the owner already
 * recorded is an edit.
 *
 * Both refuse for a delegate and stay open to the owner, who is the only
 * person the snooze and the correction were ever for.
 */
export async function refuseDelegatedChange(input: {
  userId: string;
  actorId: string;
  existing: StatusUpdateEvent;
  intakeId: string;
  status: IntakeStatusUpdate["status"];
  ipAddress: string | null;
}): Promise<IntakeStatusRefusal | null> {
  const { userId, existing, intakeId, status } = input;
  if (input.actorId !== userId) {
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
        userId,
        ipAddress: input.ipAddress,
        details: { intakeId, status, reason: refusal },
      });
      return {
        kind: "refused",
        message:
          refusal === "snooze"
            ? "Snoozing a reminder is not part of shared access"
            : "Changing a dose that is already recorded is not part of shared access",
        status: 403,
        errorCode: "sharing.not_permitted",
      };
    }
  }
  return null;
}

/**
 * Resolve + server-validate the optional injection site for a "taken"
 * toggle. A site outside the medication's effective allowed set is a hard
 * 422; non-injection / tracking-off / non-taken drops it.
 */
export async function resolveStatusInjectionSite(input: {
  userId: string;
  existing: StatusUpdateEvent;
  injectionSite: IntakeStatusUpdate["injectionSite"];
  status: IntakeStatusUpdate["status"];
}): Promise<
  { kind: "site"; site: InjectionSiteValue | null } | IntakeStatusRefusal
> {
  const { existing, injectionSite, status } = input;
  let resolvedInjectionSite: InjectionSiteValue | null = null;
  if (injectionSite !== undefined) {
    const userRow = await prisma.user.findUnique({
      where: { id: input.userId },
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
      return {
        kind: "refused",
        message: "Injection site is not allowed for this medication",
        status: 422,
        errorCode: "medications.intake.injection_site.disallowed",
      };
    }
    resolvedInjectionSite = resolution.site;
  }
  return { kind: "site", site: resolvedInjectionSite };
}
