/**
 * `GET    /api/practitioners/{id}` — one owned, live practitioner.
 * `PATCH  /api/practitioners/{id}` — edit it (partial; field-by-field).
 * `DELETE /api/practitioners/{id}` — soft-delete it (idempotent).
 *
 * Owner-scoped by fetch-then-guard, the episode-detail pattern: the row is
 * read by id and then checked against the resolved user, so a foreign id and a
 * missing id give the same 404 and probing learns nothing.
 *
 * Deleting a practitioner takes it out of the address book and the pickers,
 * not out of the history: every live visit and dose that named it keeps
 * showing it, and the nightly purge keeps the tombstone for as long as one
 * does (`soft-delete-retention.ts`).
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
import { practitionerUpdateSchema } from "@/lib/validations/practitioners";
import { encryptNote } from "@/lib/crypto/note-cipher";
import {
  readPractitionerContact,
  toPractitionerDTO,
} from "@/lib/practitioners/dto";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "profile");

    const { id } = await params;
    const row = await prisma.practitioner.findUnique({ where: { id } });
    if (!row || row.userId !== user.id || row.deletedAt !== null) {
      return apiError("Practitioner not found", 404);
    }

    annotate({
      action: {
        name: "practitioner.contact.read",
        entity_type: "practitioner",
        entity_id: id,
      },
    });

    return apiSuccess(toPractitionerDTO(row));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.practitioner.findUnique({ where: { id } });
    if (
      !existing ||
      existing.userId !== user.id ||
      existing.deletedAt !== null
    ) {
      return apiError("Practitioner not found", 404);
    }

    const parsed = await parseJsonBody(request, practitionerUpdateSchema, {
      maxBytes: 16 * 1024,
      errorCode: "practitioner.invalid",
    });
    if (!parsed.ok) return parsed.error;

    const entry = parsed.data;

    // Field-by-field, and only the keys the body actually named: an absent key
    // leaves the column alone, an explicit null clears it.
    const data: Prisma.PractitionerUpdateInput = {};
    if (entry.name !== undefined) data.name = entry.name;
    if (entry.specialty !== undefined) data.specialty = entry.specialty;
    if (entry.practice !== undefined) data.practice = entry.practice;
    // v1.39.4 — the phone number and the address are written as ciphertext
    // only. Writing one also clears its legacy readable column, so an edit of
    // a row the backfill has not reached never leaves the old value behind.
    if (entry.location !== undefined) {
      data.locationEncrypted = encryptNote(entry.location);
      data.location = null;
    }
    if (entry.phone !== undefined) {
      data.phoneEncrypted = encryptNote(entry.phone);
      data.phone = null;
    }
    if (entry.note !== undefined) {
      data.noteEncrypted = entry.note ? encryptToBytes(entry.note) : null;
    }

    const updated = await prisma.practitioner.update({ where: { id }, data });

    // The phone number and the address are encrypted at rest, so the audit
    // row names them when they changed and never carries their values.
    const contactChanged = (
      [
        ["location", existing.locationEncrypted, existing.location],
        ["phone", existing.phoneEncrypted, existing.phone],
      ] as const
    )
      .filter(
        ([field, ciphertext, legacy]) =>
          entry[field] !== undefined &&
          (readPractitionerContact(ciphertext, legacy, field) ?? null) !==
            (entry[field] || null),
      )
      .map(([field]) => field);

    await auditLog("practitioner.contact.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        practitionerId: id,
        // A manager may edit somebody else's address book, so the owner's
        // activity feed has to say what changed rather than only that
        // something did. The note is deliberately absent, and the phone
        // number and address appear by name only: they are encrypted at rest
        // and the audit table is not a second copy of the record.
        ...overwriteDetails({
          before: {
            name: existing.name,
            specialty: existing.specialty,
            practice: existing.practice,
          },
          after: {
            name: updated.name,
            specialty: updated.specialty,
            practice: updated.practice,
          },
          redacted: contactChanged,
        }),
      },
    });

    annotate({
      action: {
        name: "practitioner.contact.update",
        entity_type: "practitioner",
        entity_id: id,
      },
    });

    return apiSuccess(toPractitionerDTO(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.practitioner.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return apiError("Practitioner not found", 404);
    }
    // Already tombstoned: deleting twice is a no-op that still succeeds.
    if (existing.deletedAt === null) {
      await prisma.practitioner.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    }

    await auditLog("practitioner.contact.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // Soft delete: the row and its name survive, so the id is enough to
      // reconstruct what went missing from the list.
      details: { practitionerId: id, name: existing.name },
    });

    annotate({
      action: {
        name: "practitioner.contact.delete",
        entity_type: "practitioner",
        entity_id: id,
      },
    });

    return apiSuccess({ deleted: true });
  },
);
