/**
 * `GET  /api/vaccinations/custom` — the record's own vaccine definitions.
 * `POST /api/vaccinations/custom` — add one (v1.42, #1005).
 *
 * A definition is a product the shipped catalogue does not list, described in
 * the shape a catalogue entry resolves to: a name, the antigens it protects
 * against (from the catalogue's closed antigen list), a typical series length
 * and a booster interval. A dose logged against it counts into a series,
 * clears a booster and offers one exactly the way a catalogue pick does
 * (`src/lib/vaccinations/resolve-vaccine-entry.ts`).
 *
 * Record-scoped like the dose log and classified `profile` with it: a
 * definition is part of the immunization history a delegate granted `profile`
 * already sees, names no credential, no integration and no notification
 * channel. The list is READ, the create WRITE, the same split as the doses.
 *
 * `userId` is narrowed from auth and fed to every `where`; it is never a body
 * field. The `data` object is built field-by-field.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { checkRecordWriteRateLimit } from "@/lib/rate-limit";
import { customVaccineCreateSchema } from "@/lib/validations/vaccinations";
import { toCustomVaccineDTO } from "@/lib/vaccinations/dto";
import {
  CUSTOM_VACCINE_SELECT,
  findLiveNameClash,
} from "@/lib/vaccinations/custom-vaccines";

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "profile");

  const rows = await prisma.customVaccine.findMany({
    where: { userId: user.id, deletedAt: null },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: CUSTOM_VACCINE_SELECT,
  });

  annotate({
    action: { name: "vaccination.custom.list", entity_type: "custom-vaccine" },
    meta: { count: rows.length },
  });

  return apiSuccess(rows.map(toCustomVaccineDTO));
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user, actor } = await requireRecordAuth("write", "profile");

  // The shared per-account write ceiling, keyed on the ACTOR so a delegate
  // spends their own allowance (`checkRecordWriteRateLimit`).
  const writeRl = await checkRecordWriteRateLimit(actor.id);
  if (!writeRl.allowed) {
    return apiError("Too many writes, try again later", 429, {
      errorCode: "record_write.rate_limited",
    });
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 8 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = customVaccineCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "vaccination.custom.invalid",
    });
  }
  const entry = parsed.data;

  const outcome = await prisma.$transaction(async (tx) => {
    if (await findLiveNameClash(tx, user.id, entry.name)) {
      return "name-taken" as const;
    }
    // Names are unique per record, removed definitions included, because the
    // index is. A name the person removed and now adds again brings that row
    // back with the new values rather than failing on the index: deleting
    // unlinked every dose, so nothing re-attaches on the way back.
    const removed = await tx.customVaccine.findFirst({
      where: { userId: user.id, name: entry.name, deletedAt: { not: null } },
      select: { id: true },
    });
    const data = {
      name: entry.name,
      components: entry.components,
      typicalSeriesDoses: entry.typicalSeriesDoses ?? null,
      boosterIntervalMonths: entry.boosterIntervalMonths ?? null,
    };
    if (removed) {
      return tx.customVaccine.update({
        where: { id: removed.id },
        data: { ...data, deletedAt: null },
        select: CUSTOM_VACCINE_SELECT,
      });
    }
    return tx.customVaccine.create({
      data: { userId: user.id, ...data },
      select: CUSTOM_VACCINE_SELECT,
    });
  });

  if (outcome === "name-taken") {
    return apiError("A vaccine with this name already exists", 409, {
      errorCode: "vaccination.custom.name-taken",
    });
  }

  await auditLog("vaccination.custom.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      customVaccineId: outcome.id,
      components: outcome.components,
      boosterIntervalMonths: outcome.boosterIntervalMonths,
    },
  });

  annotate({
    action: {
      name: "vaccination.custom.create",
      entity_type: "custom-vaccine",
      entity_id: outcome.id,
    },
    meta: { components: outcome.components.length },
  });

  return apiSuccess(toCustomVaccineDTO(outcome), 201);
});
