/**
 * Record a seizure (#1368).
 *
 *   POST /api/seizures/events — one seizure, or a tally of brief ones
 *        (`count` > 1). `typeProfileId` must name one of the record's own
 *        types. `rescueDoses` carries the doses given during it (the quick
 *        log's "rescue given"); each one that names a medication also writes
 *        an intake on that as-needed medication.
 *
 * Free text is encrypted at rest and never logged. The account that logged it
 * is the ACTOR (a guardian logging for a child), kept beside the record's
 * owner. WRITE on a shared record, like logging a symptom; editing or removing
 * one is MANAGE. Module-gated (`seizures.disabled`).
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { withIdempotency } from "@/lib/idempotency";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { requireSeizuresEnabled } from "@/lib/seizures/gate";
import {
  checkRescueMedication,
  listSeizureTypes,
  sealOptional,
  seizureEventCreateSchema,
  toSeizureEventDTO,
  typeLookupOf,
  writeRescueDose,
} from "@/lib/seizures/server";

export const dynamic = "force-dynamic";

// A retry from a flaky connection, on a phone in a hurry, re-sends the same
// `Idempotency-Key` and gets the first answer back instead of a second seizure.
export const POST = apiHandler(withIdempotency<[NextRequest]>(postEvent));

async function postEvent(request: NextRequest): Promise<Response> {
  const { user, actor, authMethod } = await requireRecordAuth(
    "write",
    "illness",
  );

  const gate = await requireSeizuresEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const parsed = await parseJsonBody(request, seizureEventCreateSchema, {
    maxBytes: 64 * 1024,
    errorCode: "seizures.invalid",
  });
  if (!parsed.ok) return parsed.error;
  const entry = parsed.data;

  const types = await listSeizureTypes(user.id);
  if (entry.typeProfileId && !types.some((t) => t.id === entry.typeProfileId)) {
    return apiError("Seizure type not found", 404, {
      errorCode: "seizures.type.notFound",
    });
  }

  // Every rescue medication is checked before anything is written, so a
  // refused dose never leaves a seizure behind without it.
  const medications = new Map<string, { id: string; name: string }>();
  for (const dose of entry.rescueDoses ?? []) {
    if (!dose.medicationId) {
      if (!dose.medicationName) {
        return apiError("A rescue dose needs a medication", 422, {
          errorCode: "seizures.rescue.medicationRequired",
        });
      }
      continue;
    }
    if (medications.has(dose.medicationId)) continue;
    const check = await checkRescueMedication(user.id, dose.medicationId);
    if (!check.ok) {
      return apiError(check.message, check.status, {
        errorCode: check.errorCode,
      });
    }
    medications.set(dose.medicationId, check.medication);
  }

  const created = await prisma.seizureEvent.create({
    data: {
      userId: user.id,
      typeProfileId: entry.typeProfileId ?? null,
      ilaeType: entry.ilaeType ?? null,
      onsetAt: entry.onsetAt,
      onsetPrecision: entry.onsetPrecision ?? "EXACT",
      durationSec: entry.durationSec ?? null,
      durationSource:
        entry.durationSource ??
        (entry.durationSec == null ? "UNKNOWN" : "ESTIMATED"),
      count: entry.count ?? 1,
      certainty: entry.certainty ?? "CONFIRMED",
      sleepState: entry.sleepState ?? "UNKNOWN",
      observableManifestations: entry.observableManifestations ?? null,
      responsiveness: entry.responsiveness ?? null,
      recall: entry.recall ?? null,
      semiology: entry.semiology ?? [],
      semiologyNoteEncrypted: sealOptional(entry.semiologyNote) ?? null,
      auraEncrypted: sealOptional(entry.aura) ?? null,
      triggers: entry.triggers ?? [],
      postictalMinutes: entry.postictalMinutes ?? null,
      postictal: entry.postictal ?? [],
      injuries: entry.injuries ?? [],
      incontinence: entry.incontinence ?? null,
      emergency: entry.emergency ?? "NONE",
      witnessed: entry.witnessed ?? null,
      witnessRole: entry.witnessRole ?? null,
      witnessNoteEncrypted: sealOptional(entry.witnessNote) ?? null,
      loggedByUserId: actor.id,
      source: entry.source ?? "MANUAL",
      noteEncrypted: sealOptional(entry.note) ?? null,
    },
  });

  const rescueDoses = [];
  for (const dose of entry.rescueDoses ?? []) {
    rescueDoses.push(
      await writeRescueDose(
        {
          user,
          actorId: actor.id,
          intakeSource: authMethod === "bearer" ? "API" : "WEB",
          ipAddress: getClientIp(request),
          originDeviceToken: request.headers.get("x-device-id"),
        },
        created.id,
        dose,
        dose.medicationId ? (medications.get(dose.medicationId) ?? null) : null,
      ),
    );
  }

  await auditLog("seizures.event.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      eventId: created.id,
      typeProfileId: created.typeProfileId,
      count: created.count,
      rescueDoses: rescueDoses.length,
    },
  });

  invalidateUserHealthContext(user.id);

  annotate({
    action: {
      name: "seizures.event.create",
      entity_type: "seizure_event",
      entity_id: created.id,
    },
    meta: {
      timed: created.durationSource === "TIMED",
      rescue_doses: rescueDoses.length,
      delegated: actor.id !== user.id,
    },
  });

  return apiSuccess(
    toSeizureEventDTO(
      { ...created, rescueDoses },
      typeLookupOf(types),
      actor.id,
    ),
    201,
  );
}
