/**
 * The seizure diary's rescue-dose writes (#1368): the dose itself and the
 * intake it records on the as-needed medication, and undoing that intake when
 * the dose or its seizure is removed. Kept apart from `./server.ts` so the
 * read paths (the diary, the report, the export) do not pull in the
 * medication write and notification modules.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import type { SessionUser } from "@/lib/auth/session-user";
import { recordIntake } from "@/lib/medications/record-intake/record-intake";
import {
  deleteIntakeEvent,
  findDeletableIntakeEvent,
} from "@/lib/medications/delete-intake-event";
import type { SeizureRescueDose } from "@/generated/prisma/client";

import { formatRescueDose } from "./server";

export interface RescueDoseInput {
  medicationId?: string | null;
  medicationName?: string | null;
  doseAmount?: number | null;
  doseUnit?: string | null;
  route?: SeizureRescueDose["route"];
  givenAt: Date;
  givenBy?: SeizureRescueDose["givenBy"];
  effect?: SeizureRescueDose["effect"];
  seizureEndedAt?: Date | null;
}

export interface RescueWriteContext {
  user: Pick<SessionUser, "id" | "timezone">;
  actorId: string;
  intakeSource: "API" | "WEB";
  ipAddress: string | null;
  originDeviceToken: string | null;
}

/**
 * Write one rescue dose and, when it names a medication, the intake on that
 * medication through the medication's own intake path (inventory, the dose
 * slot refresh, the owner's notification when a delegate gave it). The intake
 * is keyed on the dose's id, so a retried write cannot record it twice.
 *
 * The medication must already have passed `checkRescueMedication`.
 */
export async function writeRescueDose(
  ctx: RescueWriteContext,
  eventId: string,
  input: RescueDoseInput,
  medication: { id: string; name: string } | null,
): Promise<SeizureRescueDose> {
  const created = await prisma.seizureRescueDose.create({
    data: {
      userId: ctx.user.id,
      eventId,
      medicationId: medication?.id ?? null,
      medicationName: medication?.name ?? input.medicationName ?? "",
      doseAmount: input.doseAmount ?? null,
      doseUnit: input.doseUnit ?? null,
      route: input.route ?? null,
      givenAt: input.givenAt,
      givenBy: input.givenBy ?? null,
      effect: input.effect ?? "UNKNOWN",
      seizureEndedAt: input.seizureEndedAt ?? null,
    },
  });
  if (!medication) return created;

  const outcome = await recordIntake(
    {
      user: ctx.user,
      actorId: ctx.actorId,
      medicationId: medication.id,
      intakeSource: ctx.intakeSource,
      isDelegated: ctx.actorId !== ctx.user.id,
      ipAddress: ctx.ipAddress,
      originDeviceToken: ctx.originDeviceToken,
    },
    {
      medicationId: medication.id,
      takenAt: input.givenAt,
      skipped: false,
      idempotencyKey: `seizure-rescue:${created.id}`,
      doseTaken:
        formatRescueDose(input.doseAmount, input.doseUnit) ?? undefined,
    } as Parameters<typeof recordIntake>[1],
  );
  const intakeId =
    outcome.kind === "recorded"
      ? outcome.event.id
      : outcome.kind === "existing"
        ? outcome.row.id
        : null;
  if (intakeId === null) {
    getEvent()?.addWarning(
      `seizure rescue intake not written: ${outcome.kind}`,
    );
    return created;
  }
  return prisma.seizureRescueDose.update({
    where: { id: created.id },
    data: { intakeEventId: intakeId },
  });
}

/**
 * Undo the intakes written for rescue doses that are being removed, through
 * the medication's own delete path (the tombstone, the inventory refund, the
 * dose slot refresh). A dose recorded by mistake in the diary must not stay
 * recorded on the medication. An intake already gone is skipped.
 */
export async function undoRescueIntakes(
  user: Pick<SessionUser, "id" | "timezone">,
  doses: ReadonlyArray<
    Pick<SeizureRescueDose, "medicationId" | "intakeEventId">
  >,
  ipAddress: string | null,
  originDeviceToken: string | null,
): Promise<number> {
  let undone = 0;
  for (const dose of doses) {
    if (!dose.medicationId || !dose.intakeEventId) continue;
    const event = await findDeletableIntakeEvent({
      userId: user.id,
      medicationId: dose.medicationId,
      eventId: dose.intakeEventId,
    });
    if (!event || event.deletedAt) continue;
    await deleteIntakeEvent({
      user,
      medicationId: dose.medicationId,
      eventId: dose.intakeEventId,
      event,
      ipAddress: ipAddress ?? "unknown",
      originDeviceToken,
    });
    undone += 1;
  }
  return undone;
}
