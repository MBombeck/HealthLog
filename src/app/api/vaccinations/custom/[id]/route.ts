/**
 * `PATCH  /api/vaccinations/custom/{id}` — edit one of the record's own
 *                                         vaccine definitions.
 * `DELETE /api/vaccinations/custom/{id}` — remove it (v1.42, #1005).
 *
 * MANAGE, classified `profile`, the same split as the dose edit and delete.
 *
 * An edit is a correction of the definition and applies to every dose logged
 * against it: the series those doses sit in is derived on read, so changing
 * the antigens or the series length re-reads them, exactly as a corrected
 * catalogue entry would. It deliberately does not re-run the booster satisfy
 * matcher — that belongs to the act of logging a dose, which happened once.
 *
 * The removal soft-deletes the definition and lets go of every dose that
 * named it; each dose keeps a name (`removeCustomVaccine`). Owner-scoped by
 * fetch-then-guard; `userId` is narrowed from auth and never a body field.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { customVaccineUpdateSchema } from "@/lib/validations/vaccinations";
import { toCustomVaccineDTO } from "@/lib/vaccinations/dto";
import {
  CUSTOM_VACCINE_SELECT,
  findLiveNameClash,
  removeCustomVaccine,
} from "@/lib/vaccinations/custom-vaccines";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.customVaccine.findUnique({ where: { id } });
    if (
      !existing ||
      existing.userId !== user.id ||
      existing.deletedAt !== null
    ) {
      return apiError("Vaccine not found", 404, {
        errorCode: "vaccination.custom.not-found",
      });
    }

    const { data: rawBody, error: jsonError } = await safeJson(request, {
      maxBytes: 8 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = customVaccineUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "vaccination.custom.invalid",
      });
    }
    const entry = parsed.data;

    const outcome = await prisma.$transaction(async (tx) => {
      if (
        entry.name !== undefined &&
        entry.name !== existing.name &&
        (await findLiveNameClash(tx, user.id, entry.name, id))
      ) {
        return "name-taken" as const;
      }
      // A removed definition may still hold the new name on the unique
      // index. It is gone from the person's view, so it gives the name up
      // rather than blocking the rename.
      if (entry.name !== undefined && entry.name !== existing.name) {
        await tx.customVaccine.deleteMany({
          where: {
            userId: user.id,
            name: entry.name,
            deletedAt: { not: null },
          },
        });
      }
      // Field-by-field — never spread the parsed object whole.
      const data: Prisma.CustomVaccineUpdateInput = {};
      if (entry.name !== undefined) data.name = entry.name;
      if (entry.components !== undefined) data.components = entry.components;
      if (entry.typicalSeriesDoses !== undefined) {
        data.typicalSeriesDoses = entry.typicalSeriesDoses;
      }
      if (entry.boosterIntervalMonths !== undefined) {
        data.boosterIntervalMonths = entry.boosterIntervalMonths;
      }
      return tx.customVaccine.update({
        where: { id },
        data,
        select: CUSTOM_VACCINE_SELECT,
      });
    });

    if (outcome === "name-taken") {
      return apiError("A vaccine with this name already exists", 409, {
        errorCode: "vaccination.custom.name-taken",
      });
    }

    await auditLog("vaccination.custom.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        customVaccineId: id,
        // The name is the person's own wording: a rename is named in
        // `fields`, never quoted.
        ...overwriteDetails({
          before: {
            components: existing.components.join(","),
            typicalSeriesDoses: existing.typicalSeriesDoses,
            boosterIntervalMonths: existing.boosterIntervalMonths,
          },
          after: {
            components: outcome.components.join(","),
            typicalSeriesDoses: outcome.typicalSeriesDoses,
            boosterIntervalMonths: outcome.boosterIntervalMonths,
          },
          redacted: outcome.name !== existing.name ? ["name"] : [],
        }),
      },
    });

    annotate({
      action: {
        name: "vaccination.custom.update",
        entity_type: "custom-vaccine",
        entity_id: id,
      },
    });

    return apiSuccess(toCustomVaccineDTO(outcome));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.customVaccine.findUnique({
      where: { id },
      select: { id: true, userId: true, name: true, deletedAt: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Vaccine not found", 404, {
        errorCode: "vaccination.custom.not-found",
      });
    }

    // Already removed: removing twice is a no-op that still succeeds.
    let dosesUnlinked = 0;
    if (existing.deletedAt === null) {
      dosesUnlinked = await prisma.$transaction((tx) =>
        removeCustomVaccine(tx, user.id, existing),
      );
    }

    await auditLog("vaccination.custom.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { customVaccineId: id, dosesUnlinked },
    });

    annotate({
      action: {
        name: "vaccination.custom.delete",
        entity_type: "custom-vaccine",
        entity_id: id,
      },
      meta: { doses_unlinked: dosesUnlinked },
    });

    return apiSuccess({ deleted: true });
  },
);
