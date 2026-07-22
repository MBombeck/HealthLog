import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  type ResolvedBiomarker,
  serialiseLabResult,
  serialiseLabResultDetail,
} from "@/lib/labs/serialise";
import { decryptNoteFromBytes, encryptNoteToBytes } from "@/lib/labs/store";
import { annotate } from "@/lib/logging/context";
import {
  effectiveBound,
  isInvertedRange,
  updateLabResultSchema,
} from "@/lib/validations/labs";

/**
 * v1.17.1 — single lab-result resource (`/api/labs/{id}`).
 *
 * GET returns the row including its decrypted note (the detail view is the
 * one place the plaintext note surfaces). PUT applies a partial edit
 * (`data` built field-by-field; an explicit `null` clears `panel` / `note` /
 * a reference bound, an omitted key leaves it untouched). DELETE soft-deletes
 * by stamping `deletedAt`. Cross-user rows surface as 404 (existence sealed).
 *
 * v1.18.1 — when the row links a `Biomarker`, the response resolves the
 * canonical name / unit / range from the catalog (server-authoritative). The
 * legacy per-row free-text fields stay editable for an unlinked row.
 */

type RouteParams = { params: Promise<{ id: string }> };

const biomarkerSelect = {
  id: true,
  name: true,
  unit: true,
  lowerBound: true,
  upperBound: true,
  panel: true,
} as const;

function toResolved(
  bm: {
    id: string;
    name: string;
    unit: string;
    lowerBound: number | null;
    upperBound: number | null;
    panel: string | null;
  } | null,
): ResolvedBiomarker | null {
  return bm ?? null;
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const row = await prisma.labResult.findFirst({
      where: { id, deletedAt: null },
      include: { biomarker: { select: biomarkerSelect } },
    });
    if (!row || row.userId !== user.id) {
      return apiError("Lab result not found", 404);
    }

    annotate({ action: { name: "labs.get" }, meta: { labResultId: id } });

    return apiSuccess(
      serialiseLabResultDetail(
        row,
        toResolved(row.biomarker),
        row.noteEncrypted ? decryptNoteFromBytes(row.noteEncrypted) : null,
      ),
    );
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const existing = await prisma.labResult.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Lab result not found", 404, {
        errorCode: "labs.result.notFound",
      });
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = updateLabResultSchema.safeParse(body);
    if (!parsed.success) {
      annotate({
        action: { name: "labs.update.validation-failed" },
        meta: { issue_count: parsed.error.issues.length, labResultId: id },
      });
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "labs.update.validation-failed",
            details: JSON.stringify({ issues: auditIssues, labResultId: id }),
          },
        })
        .catch(() => {
          /* swallow — the 422 response is the contract */
        });
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "labs.update.invalid",
      });
    }

    const d = parsed.data;

    // A reading linked to a catalog marker resolves its name / unit / range
    // FROM the biomarker (server-authoritative). Editing those catalog-owned
    // fields on a linked row is meaningless — they would persist as stale
    // historical columns the serialiser ignores. Reject the attempt with a
    // 422 rather than silently no-op, so the client never believes an edit
    // landed. Edit such fields on the Biomarker itself instead.
    const isLinked = existing.biomarkerId !== null;
    if (
      isLinked &&
      (d.analyte !== undefined ||
        d.unit !== undefined ||
        d.panel !== undefined ||
        d.referenceLow !== undefined ||
        d.referenceHigh !== undefined)
    ) {
      return apiError(
        "analyte / unit / panel / reference range are resolved from the linked biomarker and cannot be edited on a linked reading",
        422,
        { errorCode: "labs.update.linkedFieldsImmutable" },
      );
    }

    // v1.18.9 — a row keeps its type. Editing `value` on a qualitative row or
    // `valueText` on a numeric row would either leave both columns populated or
    // strand the row in an ambiguous state. Reject the cross-type edit with a
    // 422 — switch types by deleting and re-adding.
    const rowIsQualitative = existing.valueText !== null;
    if (rowIsQualitative && d.value !== undefined) {
      return apiError(
        "This is a qualitative reading — edit its result text, not a numeric value",
        422,
        { errorCode: "labs.update.qualitativeExpected" },
      );
    }
    if (!rowIsQualitative && d.valueText !== undefined) {
      return apiError(
        "This is a numeric reading — edit its value, not a qualitative result",
        422,
        { errorCode: "labs.update.numericExpected" },
      );
    }

    // Build `data` field-by-field. `undefined` → leave the column untouched;
    // an explicit `null` on `panel` / `note` / a reference bound clears it.
    // A reading linked to a catalog marker is edited via VALUE / takenAt /
    // note here; its name / unit / range stay resolved from the biomarker.
    const data: Record<string, unknown> = {};
    if (d.panel !== undefined) data.panel = d.panel;
    if (d.analyte !== undefined) data.analyte = d.analyte;
    if (d.value !== undefined) data.value = d.value;
    // v1.18.9 — qualitative edit. A row stays single-typed: editing `value` on a
    // qualitative row (or `valueText` on a numeric row) crosses the row's type
    // and is rejected below. An edit of the matching field updates in place.
    if (d.valueText !== undefined) data.valueText = d.valueText;
    if (d.unit !== undefined) data.unit = d.unit;
    if (d.referenceLow !== undefined) data.referenceLow = d.referenceLow;
    if (d.referenceHigh !== undefined) data.referenceHigh = d.referenceHigh;
    if (d.takenAt !== undefined) data.takenAt = d.takenAt;

    // Inverted-range guard for a PARTIAL bound update. The schema-level
    // refine only fires when both bounds arrive in one request; a request
    // that moves a single bound below/above the row's existing other bound
    // would otherwise persist an inverted range. Merge the effective bounds
    // (parsed value when present, else the stored value) and 422 when both
    // resolve to concrete numbers with low > high.
    if (
      isInvertedRange(
        effectiveBound(d.referenceLow, existing.referenceLow),
        effectiveBound(d.referenceHigh, existing.referenceHigh),
      )
    ) {
      return apiError("referenceLow must not exceed referenceHigh", 422, {
        errorCode: "labs.update.referenceRangeInvalid",
      });
    }
    if (d.note !== undefined) {
      data.noteEncrypted = d.note ? encryptNoteToBytes(d.note) : null;
    }

    const updated = await prisma.labResult.update({
      where: { id },
      data,
      include: { biomarker: { select: biomarkerSelect } },
    });

    await auditLog("labResult.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { labResultId: id },
    });

    annotate({ action: { name: "labs.update" }, meta: { labResultId: id } });

    return apiSuccess(
      serialiseLabResult(updated, toResolved(updated.biomarker)),
    );
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const existing = await prisma.labResult.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Lab result not found", 404);
    }

    // Soft-delete: stamp `deletedAt`. Every read filters `deletedAt: null`,
    // so the row is invisible from here on. A re-delete is idempotent.
    await prisma.labResult.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await auditLog("labResult.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { labResultId: id },
    });

    annotate({ action: { name: "labs.delete" }, meta: { labResultId: id } });

    return apiSuccess({ deleted: true });
  },
);
