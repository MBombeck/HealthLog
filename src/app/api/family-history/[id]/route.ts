/**
 * `GET    /api/family-history/{id}` — one owned, live entry.
 * `PATCH  /api/family-history/{id}` — edit it (partial; field-by-field).
 * `DELETE /api/family-history/{id}` — soft-delete it (idempotent;
 *          returns `{ deleted: true }`).
 *
 * Owner-scoped. `userId` is narrowed from auth and fed to the Prisma `where`;
 * the body never carries it. The free-text `note` is encrypted at rest.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { familyHistoryUpdateSchema } from "@/lib/validations/family-history";
import { toFamilyHistoryEntryDTO } from "@/lib/records/dto";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "profile");

    const { id } = await params;
    const row = await prisma.familyHistoryEntry.findUnique({ where: { id } });
    if (!row || row.userId !== user.id || row.deletedAt !== null) {
      return apiError("Family history entry not found", 404);
    }

    annotate({
      action: {
        name: "family-history.read",
        entity_type: "family_history",
        entity_id: id,
      },
    });

    return apiSuccess(toFamilyHistoryEntryDTO(row));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Correcting one relative's entry.
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    // Widened for the audit row (C4); the encrypted note stays out.
    const existing = await prisma.familyHistoryEntry.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        relationship: true,
        condition: true,
        ageAtOnset: true,
      },
    });
    if (
      !existing ||
      existing.userId !== user.id ||
      existing.deletedAt !== null
    ) {
      return apiError("Family history entry not found", 404);
    }

    const parsed = await parseJsonBody(request, familyHistoryUpdateSchema, {
      maxBytes: 16 * 1024,
      errorCode: "familyHistory.invalid",
    });
    if (!parsed.ok) return parsed.error;
    const entry = parsed.data;

    // Field-by-field — only fields actually present in the body are written.
    const data: Prisma.FamilyHistoryEntryUpdateInput = {};
    if (entry.relationship !== undefined) {
      data.relationship = entry.relationship;
    }
    if (entry.condition !== undefined) data.condition = entry.condition;
    if (entry.ageAtOnset !== undefined) data.ageAtOnset = entry.ageAtOnset;
    if (entry.note !== undefined) {
      data.notesEncrypted = entry.note ? encryptToBytes(entry.note) : null;
    }

    const updated = await prisma.familyHistoryEntry.update({
      where: { id },
      data,
    });

    await auditLog("family-history.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // The replaced fields; the note is named and never quoted.
      details: {
        entryId: id,
        ...overwriteDetails({
          before: {
            relationship: existing.relationship,
            condition: existing.condition,
            ageAtOnset: existing.ageAtOnset,
          },
          after: {
            relationship: updated.relationship,
            condition: updated.condition,
            ageAtOnset: updated.ageAtOnset,
          },
          redacted: entry.note !== undefined ? ["note"] : [],
        }),
      },
    });

    annotate({
      action: {
        name: "family-history.update",
        entity_type: "family_history",
        entity_id: id,
      },
    });

    return apiSuccess(toFamilyHistoryEntryDTO(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Soft delete: the row stays and reconstructs itself.
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.familyHistoryEntry.findUnique({
      where: { id },
      select: { id: true, userId: true, deletedAt: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Family history entry not found", 404);
    }

    if (existing.deletedAt === null) {
      await prisma.familyHistoryEntry.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await auditLog("family-history.delete", {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: { entryId: id },
      });
    }

    annotate({
      action: {
        name: "family-history.delete",
        entity_type: "family_history",
        entity_id: id,
      },
    });

    return apiSuccess({ deleted: true });
  },
);
