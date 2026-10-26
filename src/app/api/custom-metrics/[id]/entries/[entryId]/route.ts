import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserCorrelationPatterns } from "@/lib/cache/invalidate";
import { serialiseCustomMetricEntry } from "@/lib/custom-metrics/custom-metric-store";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { updateCustomMetricEntrySchema } from "@/lib/validations/custom-metrics";

/**
 * v1.25.5 — single logged value
 * (`/api/custom-metrics/{id}/entries/{entryId}`).
 *
 * PATCH applies a partial edit (`data` built field-by-field; an explicit `null`
 * on `note` clears it, an omitted key leaves the column untouched). DELETE
 * tombstones the value (v1.37.20, A3-11 — undo parity with every peer entry
 * surface; the sibling `restore` route clears the tombstone for the toast's
 * Undo). Every read/write is narrowed by both `userId` and the parent
 * `customMetricId`; a cross-user, tombstoned or mismatched-parent id surfaces
 * as 404.
 */

type RouteParams = { params: Promise<{ id: string; entryId: string }> };

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id, entryId } = await params;

    const existing = await prisma.customMetricEntry.findFirst({
      where: {
        id: entryId,
        userId: user.id,
        customMetricId: id,
        deletedAt: null,
      },
    });
    if (!existing) {
      return apiError("Custom metric entry not found", 404);
    }

    const parsed = await parseJsonBody(request, updateCustomMetricEntrySchema, {
      maxBytes: 16 * 1024,
      action: "custom-metric.entry.update.validation-failed",
      countIssues: true,
      meta: { entryId },
      onInvalid: (error) => {
        const auditIssues = sanitiseZodIssues(error.issues, {
          stripValuesFromMessage: true,
        });
        auditLog("custom-metric.entry.update.validation-failed", {
          userId: user.id,
          details: { issues: auditIssues, entryId },
        }).catch(() => {
          /* swallow — the 422 response is the contract */
        });
      },
    });
    if (!parsed.ok) return parsed.error;

    const d = parsed.data;

    // Build `data` field-by-field. `undefined` → leave the column untouched;
    // an explicit `null` on `note` clears it.
    const data: Record<string, unknown> = {};
    if (d.value !== undefined) data.value = d.value;
    if (d.measuredAt !== undefined) data.measuredAt = d.measuredAt;
    // v1.39.3 — the note is stored encrypted. Any note write (a new value or
    // an explicit clear) also nulls the legacy readable column, so an edited
    // row never keeps its old text beside the new ciphertext.
    if (d.note !== undefined) {
      data.noteEncrypted = encryptNote(d.note);
      data.note = null;
    }

    const updated = await prisma.customMetricEntry.update({
      where: { id: entryId },
      data,
    });

    await auditLog("customMetricEntry.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { customMetricId: id, entryId },
    });

    annotate({
      action: { name: "custom-metric.entry.update" },
      meta: { customMetricId: id, entryId },
    });
    invalidateUserCorrelationPatterns(user.id);

    return apiSuccess(serialiseCustomMetricEntry(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id, entryId } = await params;

    const existing = await prisma.customMetricEntry.findFirst({
      where: {
        id: entryId,
        userId: user.id,
        customMetricId: id,
        deletedAt: null,
      },
    });
    if (!existing) {
      return apiError("Custom metric entry not found", 404);
    }

    // Tombstone, not a hard delete: the Undo toast's restore clears it.
    await prisma.customMetricEntry.update({
      where: { id: entryId },
      data: { deletedAt: new Date() },
    });

    await auditLog("customMetricEntry.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { customMetricId: id, entryId },
    });

    annotate({
      action: { name: "custom-metric.entry.delete" },
      meta: { customMetricId: id, entryId },
    });
    invalidateUserCorrelationPatterns(user.id);

    return apiSuccess({ deleted: true });
  },
);
