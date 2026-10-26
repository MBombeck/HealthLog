/**
 * `GET    /api/allergies/{id}` — one owned, live allergy record.
 * `PATCH  /api/allergies/{id}` — edit it (partial; field-by-field).
 * `DELETE /api/allergies/{id}` — delete it outright (`{ deleted: true }`; 404
 *   once it is gone). The confirmation dialog promises it cannot be undone, and
 *   nothing here needs a tombstone to keep that promise honest.
 *
 * Owner-scoped. `userId` is narrowed from auth and fed to the Prisma `where`;
 * the body never carries it. The free-text `reaction` + `note` are encrypted
 * at rest.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  destroyedDetails,
  overwriteDetails,
} from "@/lib/sharing/audit-details";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { allergyUpdateSchema } from "@/lib/validations/allergy";
import { toAllergyDTO } from "@/lib/records/dto";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "profile");

    const { id } = await params;
    const row = await prisma.allergy.findUnique({ where: { id } });
    if (!row || row.userId !== user.id || row.deletedAt !== null) {
      return apiError("Allergy not found", 404);
    }

    annotate({
      action: { name: "allergy.read", entity_type: "allergy", entity_id: id },
    });

    return apiSuccess(toAllergyDTO(row));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Correcting an allergy entry, with the replaced fields
    // on the audit row.
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    // The pre-image the audit row needs (C4). Encrypted columns stay out of
    // the select: the feed names them and never quotes them.
    const existing = await prisma.allergy.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        substance: true,
        category: true,
        type: true,
        severity: true,
        status: true,
        onsetAt: true,
      },
    });
    if (
      !existing ||
      existing.userId !== user.id ||
      existing.deletedAt !== null
    ) {
      return apiError("Allergy not found", 404);
    }

    const parsed = await parseJsonBody(request, allergyUpdateSchema, {
      maxBytes: 16 * 1024,
      errorCode: "allergy.invalid",
    });
    if (!parsed.ok) return parsed.error;
    const entry = parsed.data;

    // Field-by-field — only fields actually present in the body are written.
    const data: Prisma.AllergyUpdateInput = {};
    if (entry.substance !== undefined) data.substance = entry.substance;
    if (entry.category !== undefined) data.category = entry.category;
    if (entry.type !== undefined) data.type = entry.type;
    if (entry.severity !== undefined) data.severity = entry.severity;
    if (entry.status !== undefined) data.status = entry.status;
    if (entry.onsetAt !== undefined) {
      data.onsetAt = entry.onsetAt ? new Date(entry.onsetAt) : null;
    }
    if (entry.reaction !== undefined) {
      data.reactionEncrypted = entry.reaction
        ? encryptToBytes(entry.reaction)
        : null;
    }
    if (entry.note !== undefined) {
      data.notesEncrypted = entry.note ? encryptToBytes(entry.note) : null;
    }

    const updated = await prisma.allergy.update({ where: { id }, data });

    await auditLog("allergy.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // The replaced fields. The reaction and the note are named and
      // never quoted; both are encrypted at rest and the audit table is not a
      // second store for them.
      details: {
        allergyId: id,
        ...overwriteDetails({
          before: {
            substance: existing.substance,
            category: existing.category,
            type: existing.type,
            severity: existing.severity,
            status: existing.status,
            onsetAt: existing.onsetAt,
          },
          after: {
            substance: updated.substance,
            category: updated.category,
            type: updated.type,
            severity: updated.severity,
            status: updated.status,
            onsetAt: updated.onsetAt,
          },
          redacted: [
            ...(entry.reaction !== undefined ? ["reaction"] : []),
            ...(entry.note !== undefined ? ["note"] : []),
          ],
        }),
      },
    });

    annotate({
      action: { name: "allergy.update", entity_type: "allergy", entity_id: id },
    });

    return apiSuccess(toAllergyDTO(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE, and a hard delete: the row goes and the audit row is
    // what is left. C3 below is the condition this admission rests on.
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    // Widened for the audit row (C3): what was destroyed, in plaintext columns
    // only. `reactionEncrypted` and `notesEncrypted` are deliberately absent —
    // lifting a decrypted reaction into the audit table would give it a second
    // retention story and no rotation.
    const existing = await prisma.allergy.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        substance: true,
        category: true,
        type: true,
        severity: true,
        status: true,
        onsetAt: true,
      },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Allergy not found", 404);
    }

    // Hard delete. The confirmation says it can't be undone, and nothing here
    // needs a tombstone: no restore route reaches an allergy, no other table
    // references one, it is absent from the `/api/sync/changes` delta feed,
    // and every read already filters `deletedAt: null`. A row already carrying
    // a tombstone from before this changed is removed too, so the record
    // converges on what the dialog promised.
    await prisma.allergy.delete({ where: { id } });

    await auditLog("allergy.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // The allergen, its severity and its recorded date, and never the
      // encrypted reaction text.
      details: {
        allergyId: id,
        ...destroyedDetails({
          model: "Allergy",
          id,
          label: existing.substance,
          effectiveAt: existing.onsetAt,
          extra: {
            category: existing.category,
            type: existing.type,
            severity: existing.severity,
            status: existing.status,
          },
        }),
      },
    });

    annotate({
      action: { name: "allergy.delete", entity_type: "allergy", entity_id: id },
    });

    return apiSuccess({ deleted: true });
  },
);
