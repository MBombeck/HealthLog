/**
 * `GET  /api/vaccinations` — the account's immunization log, series resolved.
 * `POST /api/vaccinations` — log one dose, optionally pre-linked to the page
 *                            it was transcribed from.
 *
 * Classified `profile`: an immunization history is health background in the
 * same sense as the allergy list and the visit record already under that
 * domain. No credential, no integration, no outbound channel.
 *
 * The module gate governs the SURFACES, not this route. A disabled
 * `vaccinations` module hides the nav entry, the dashboard and report leaves
 * and the picker; the data routes stay reachable so a restore or an import
 * keeps working and re-enabling the module finds every row intact. That is the
 * `medications` posture, and the route-gate inventory records it.
 *
 * `userId` is narrowed from auth and fed to the Prisma `where`; it is never a
 * body field. The `data` object is built field-by-field.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { checkRecordWriteRateLimit } from "@/lib/rate-limit";
import { withIdempotency } from "@/lib/idempotency";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  vaccinationCreateSchema,
  vaccinationListQuerySchema,
} from "@/lib/validations/vaccinations";
import {
  toVaccinationDTO,
  type VaccinationListDTO,
} from "@/lib/vaccinations/dto";
import {
  VACCINATION_INCLUDE,
  applyVaccinationLinks,
  resolveOwnedEncounter,
  resolveOwnedPractitioner,
  resolveOwnerTimezone,
  resolveSeriesFor,
} from "@/lib/vaccinations/service";
import { satisfyBoostersForDose } from "@/lib/vaccinations/satisfy-matching";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = vaccinationListQuerySchema.safeParse({
    antigenSlug: params.get("antigenSlug") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "vaccination.invalid",
    });
  }

  const query = parsed.data;
  // Full and bounded rather than paged: an Impfpass is a lifetime document but
  // a small one, and the default already covers a long life.
  const take = query.limit ?? 300;

  const [rows, series] = await Promise.all([
    prisma.vaccinationRecord.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        ...(query.antigenSlug ? { antigenSlug: query.antigenSlug } : {}),
        ...(query.from || query.to
          ? {
              occurredAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { occurredAt: "desc" },
      take,
      include: VACCINATION_INCLUDE,
    }),
    // Over the WHOLE live set, never over the filtered page: a position is a
    // count of what came before it, so deriving it from a window would report
    // the oldest dose in that window as the first one ever given.
    resolveSeriesFor(prisma, user.id),
  ]);

  annotate({
    action: { name: "vaccination.record.list", entity_type: "vaccination" },
    meta: { count: rows.length, filtered: Boolean(query.antigenSlug) },
  });

  const body: VaccinationListDTO = {
    vaccinations: rows.map((row) =>
      toVaccinationDTO(row, series.get(row.id) ?? []),
    ),
  };
  return apiSuccess(body);
});

// A double-tap on "save" must not log the same dose twice.
export const POST = apiHandler(withIdempotency<[NextRequest]>(postVaccination));

async function postVaccination(request: NextRequest): Promise<Response> {
  const { user, actor } = await requireRecordAuth("write", "profile");

  // Shared per-account write ceiling — see `checkRecordWriteRateLimit`. The
  // batch siblings have always been capped; the per-record creates a looping
  // client hits were not.
  const writeRl = await checkRecordWriteRateLimit(actor.id);
  if (!writeRl.allowed) {
    return apiError("Too many writes, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 32 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = vaccinationCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "vaccination.record.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "vaccination.invalid",
    });
  }

  const entry = parsed.data;
  const occurredAt = new Date(entry.occurredAt);
  const timezone = await resolveOwnerTimezone(user.id);

  // Filled inside the transaction, read after it for the wide event: an
  // annotation is not worth holding a transaction open for.
  let satisfiedReminderIds: string[] = [];

  const created = await prisma.$transaction(async (tx) => {
    // Every id the body carries is re-narrowed to the resolved account before
    // anything is written. A practice or a visit the caller does not own is a
    // refusal rather than a silently dropped field: the person named one and
    // would otherwise watch the dose save without it.
    if (entry.practitionerId) {
      const owned = await resolveOwnedPractitioner(
        tx,
        user.id,
        entry.practitionerId,
      );
      if (!owned) return "unknown-practitioner" as const;
    }
    if (entry.encounterId) {
      const owned = await resolveOwnedEncounter(tx, user.id, entry.encounterId);
      if (!owned) return "unknown-encounter" as const;
    }

    // Field-by-field — never spread the parsed object whole.
    const row = await tx.vaccinationRecord.create({
      data: {
        userId: user.id,
        occurredAt,
        antigenSlug: entry.antigenSlug ?? null,
        vaccineName: entry.vaccineName ?? null,
        doseNumber: entry.doseNumber ?? null,
        seriesDoses: entry.seriesDoses ?? null,
        lotNumber: entry.lotNumber ?? null,
        site: entry.site ?? null,
        practitionerId: entry.practitionerId ?? null,
        encounterId: entry.encounterId ?? null,
        noteEncrypted: entry.note ? encryptToBytes(entry.note) : null,
      },
      select: { id: true },
    });

    await applyVaccinationLinks(tx, user.id, row.id, entry.documentIds);

    // The booster arm, inside the same transaction so a dose that failed to
    // save cannot leave a reminder looking settled. It runs on the OWNER's
    // reminders, which is correct even when a delegate is transcribing: it is
    // the owner's booster plan, and filing their Impfpass is exactly the work
    // that should settle it.
    const boosters = await satisfyBoostersForDose(
      tx,
      user.id,
      entry.antigenSlug ?? null,
      occurredAt,
      timezone,
    );
    satisfiedReminderIds = boosters.satisfiedReminderIds;
    if (boosters.primaryReminderId) {
      await tx.vaccinationRecord.update({
        where: { id: row.id },
        data: { reminderId: boosters.primaryReminderId },
      });
    }

    return tx.vaccinationRecord.findUniqueOrThrow({
      where: { id: row.id },
      include: VACCINATION_INCLUDE,
    });
  });

  if (created === "unknown-practitioner") {
    return apiError("Practitioner not found", 404, {
      errorCode: "vaccination.practitioner-not-found",
    });
  }
  if (created === "unknown-encounter") {
    return apiError("Visit not found", 404, {
      errorCode: "vaccination.encounter-not-found",
    });
  }

  const series = await resolveSeriesFor(prisma, user.id);

  await auditLog("vaccination.record.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      vaccinationId: created.id,
      occurredAt: created.occurredAt.toISOString(),
      antigenSlug: created.antigenSlug,
      // The note is deliberately absent: it is encrypted PHI and the audit
      // table is not a second copy of the record.
    },
  });

  annotate({
    action: {
      name: "vaccination.record.create",
      entity_type: "vaccination",
      entity_id: created.id,
    },
    meta: {
      antigen_slug: created.antigenSlug ?? "free-text",
      linked_documents: entry.documentIds?.length ?? 0,
      satisfied_boosters: satisfiedReminderIds.length,
    },
  });
  for (const reminderId of satisfiedReminderIds) {
    annotate({
      action: {
        name: "vaccination.booster.satisfied",
        entity_type: "measurement-reminder",
        entity_id: reminderId,
      },
      meta: { antigen_slug: created.antigenSlug ?? "free-text" },
    });
  }

  return apiSuccess(
    toVaccinationDTO(created, series.get(created.id) ?? []),
    201,
  );
}
