/**
 * `GET  /api/encounters` — the account's visits, split into upcoming and past.
 * `POST /api/encounters` — file one, optionally pre-linked and optionally
 *                          booked as a future appointment.
 *
 * No module gate: a visit is core. The reasoning is written at the `Encounter`
 * model in `prisma/schema.prisma`, and the gate is relocated to the link
 * pickers, which follow the modules that own what they point at.
 *
 * `userId` is narrowed from auth and fed to the Prisma `where`; it is never a
 * body field. The `data` object is built field-by-field. Nothing is mandatory
 * except the date: a visit saves with an instant and nothing else.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
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
  encounterCreateSchema,
  encounterListQuerySchema,
} from "@/lib/validations/encounters";
import { encounterKindLabel } from "@/lib/encounters/kind-label";
import { toEncounterDTO, type EncounterListDTO } from "@/lib/encounters/dto";
import {
  ENCOUNTER_INCLUDE,
  applyEncounterLinks,
  loadEncounterLinksForMany,
  closeCheckupForVisit,
  resolveClosableReminder,
  resolveOwnedPractitioner,
  resolveOwnerNotificationContext,
  shouldHaveReminder,
  syncAppointmentReminder,
} from "@/lib/encounters/service";
import {
  recordUnknownKeys,
  summarizeRestoreSkips,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user, grantId } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = encounterListQuerySchema.safeParse({
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    status: params.get("status") ?? undefined,
    practitionerId: params.get("practitionerId") ?? undefined,
    episodeId: params.get("episodeId") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "encounter.invalid",
    });
  }

  const query = parsed.data;
  const take = query.limit ?? 100;
  const now = new Date();

  const where = {
    userId: user.id,
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
    ...(query.practitionerId ? { practitionerId: query.practitionerId } : {}),
    // Filtered in SQL rather than in Node: the two arms are separately
    // `take`-bounded, so narrowing after the read would page wrongly.
    ...(query.episodeId
      ? { conditionLinks: { some: { episodeId: query.episodeId } } }
      : {}),
    ...(query.from || query.to
      ? {
          occurredAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
  };

  // The past arm's own upper bound is `now`, and the caller may have asked for
  // an earlier one. Both have to hold, so they COMBINE to the tighter of the
  // two rather than one overwriting the other — spreading the caller's
  // `occurredAt` and then restating `lte` silently widened every window that
  // ended before today back out to "everything up to now".
  const requestedTo = query.to ? new Date(query.to) : null;
  const pastCeiling =
    requestedTo && requestedTo.getTime() < now.getTime() ? requestedTo : now;

  // Two queries rather than one sorted list. Upcoming reads soonest-first and
  // past reads newest-first, which is the opposite direction; resolving both
  // here means the client renders two lists instead of splitting and
  // re-sorting one, and the ordering lives in one place.
  const [upcoming, past] = await Promise.all([
    prisma.encounter.findMany({
      // `gt` and `gte` are different keys, so the caller's lower bound and this
      // arm's floor both survive the spread; only the `lte` pair collided.
      where: { ...where, occurredAt: { ...where.occurredAt, gt: now } },
      orderBy: { occurredAt: "asc" },
      take,
      include: ENCOUNTER_INCLUDE,
    }),
    prisma.encounter.findMany({
      where: {
        ...where,
        occurredAt: { ...where.occurredAt, lte: pastCeiling },
      },
      orderBy: { occurredAt: "desc" },
      take,
      include: ENCOUNTER_INCLUDE,
    }),
  ]);

  // The links ride the list. The card counts what a visit produced, and the
  // edit sheet seeds its pickers from the row it was handed — a list without
  // them makes the first read zero and the second unfile everything on save.
  // Three grouped queries for the page, not three per row.
  const visible = await actingDomainVisibility(prisma, grantId);
  const links = await loadEncounterLinksForMany(
    prisma,
    user.id,
    [...upcoming, ...past].map((row) => row.id),
    visible,
  );

  annotate({
    action: { name: "encounter.visit.list", entity_type: "encounter" },
    meta: { upcoming: upcoming.length, past: past.length },
  });

  const body: EncounterListDTO = {
    upcoming: upcoming.map((row) => toEncounterDTO(row, links.get(row.id))),
    past: past.map((row) => toEncounterDTO(row, links.get(row.id))),
  };
  return apiSuccess(body);
});

// A double-tap on "save" must not file the same visit twice.
export const POST = apiHandler(withIdempotency<[NextRequest]>(postEncounter));

async function postEncounter(request: NextRequest): Promise<Response> {
  const { user, actor, grantId } = await requireRecordAuth("write", "profile");

  // Shared per-account write ceiling — see `checkRecordWriteRateLimit`. The
  // batch siblings have always been capped; the per-record creates a looping
  // client hits were not.
  const writeRl = await checkRecordWriteRateLimit(actor.id);
  if (!writeRl.allowed) {
    return apiError("Too many writes, try again later", 429, {
      errorCode: "record_write.rate_limited",
    });
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 32 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = encounterCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "encounter.visit.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "encounter.invalid",
    });
  }

  const entry = parsed.data;
  const occurredAt = new Date(entry.occurredAt);
  const { timezone, locale } = await resolveOwnerNotificationContext(user.id);
  const now = new Date();

  const skips: RestoreSkipLog = [];

  const created = await prisma.$transaction(async (tx) => {
    const visible = await actingDomainVisibility(tx, grantId);
    // A practitioner the caller does not own is a refusal rather than a
    // silently dropped field: the person named a practice and would otherwise
    // see the visit save without it.
    let practitioner:
      { id: string; name: string; location: string | null } | undefined;
    if (entry.practitionerId) {
      practitioner = await resolveOwnedPractitioner(
        tx,
        user.id,
        entry.practitionerId,
      );
      if (!practitioner) return null;
    }

    // Field-by-field — never spread the parsed object whole.
    const row = await tx.encounter.create({
      data: {
        userId: user.id,
        occurredAt,
        status: entry.status,
        kind: entry.kind,
        practitionerId: practitioner?.id ?? null,
        reasonEncrypted: entry.reason ? encryptToBytes(entry.reason) : null,
        outcomeEncrypted: entry.outcome ? encryptToBytes(entry.outcome) : null,
      },
      select: { id: true },
    });

    await applyEncounterLinks(tx, user.id, row.id, entry);

    // `Encounter.reminderId` carries one of two things, never both, and which
    // one follows from the visit's own state. A booked appointment owns a
    // reminder this code mints; a completed visit may instead close a checkup
    // the person already had. A body claiming both is contradictory — a visit
    // that has not happened cannot have closed anything — and is refused.
    let reminderId: string | null = null;

    if (shouldHaveReminder(entry.status, occurredAt, now)) {
      if (entry.reminderId) return "contradictory-reminder" as const;
      reminderId = await syncAppointmentReminder(
        tx,
        {
          userId: user.id,
          occurredAt,
          practitionerName: practitioner?.name ?? null,
          practitionerLocation: practitioner?.location ?? null,
          kindLabel: encounterKindLabel(entry.kind, locale),
          status: entry.status,
          existingReminderId: null,
        },
        timezone,
        now,
      );
    } else if (entry.reminderId) {
      const checkup = await resolveClosableReminder(
        tx,
        user.id,
        entry.reminderId,
      );
      if (!checkup) return "unknown-reminder" as const;
      reminderId = checkup.id;
      // Filing a visit as done against a due checkup closes it — but closing
      // one re-anchors a preventive-care cadence, which is a write in the
      // measurements domain. A delegate holding only the health background may
      // file the visit and may not perform that side effect, so the visit
      // saves and the closure is reported as skipped rather than done in
      // silence: somebody who believes a checkup was closed will not look at
      // it again.
      if (entry.status === "DONE") {
        if (visible("measurements")) {
          await closeCheckupForVisit(tx, checkup, timezone, occurredAt, now);
        } else {
          recordUnknownKeys(
            skips,
            "checkupClosure",
            [checkup.id],
            [checkup.id],
          );
        }
      }
    }

    if (reminderId) {
      await tx.encounter.update({
        where: { id: row.id },
        data: { reminderId },
      });
    }

    return tx.encounter.findUniqueOrThrow({
      where: { id: row.id },
      include: ENCOUNTER_INCLUDE,
    });
  });

  if (created === null) {
    return apiError("Practitioner not found", 404, {
      errorCode: "encounter.practitioner-not-found",
    });
  }
  if (created === "unknown-reminder") {
    return apiError("Checkup not found", 404, {
      errorCode: "encounter.reminder-not-found",
    });
  }
  if (created === "contradictory-reminder") {
    return apiError(
      "A planned visit cannot also close a checkup — it has not happened yet",
      422,
      { errorCode: "encounter.reminder-conflict" },
    );
  }

  await auditLog("encounter.visit.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { encounterId: created.id, status: created.status },
  });

  // A booked visit must reach the cached daily-digest / snapshot cells
  // (Today rail) on the next read — evict the analytics bucket.
  invalidateUserHealthContext(user.id);

  annotate({
    action: {
      name: "encounter.visit.create",
      entity_type: "encounter",
      entity_id: created.id,
    },
    meta: { status: created.status, kind: created.kind },
  });

  return apiSuccess(
    toEncounterDTO(created, undefined, summarizeRestoreSkips(skips)),
    201,
  );
}
