/**
 * v1.40 (#1041) — rename, reorder, hide or delete one of the person's own
 * medication categories.
 *
 * Owner-only, like the cycle symptom vocabulary's edit and delete: a
 * delegate may add a category from the wizard (the POST beside this file is
 * admitted at MANAGE), but renaming or removing the owner's vocabulary stays
 * with the owner. Both handlers resolve the key against the caller's own rows
 * only; another account's key, or a built-in value, is a 404. DELETE moves every medication
 * filed under the category to OTHER in the same transaction and answers how
 * many moved, so the app never leaves a medication pointing at a key that no
 * longer exists. The label is never logged.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  decryptCategoryLabel,
  deleteMedicationCategoryLabel,
  encryptCategoryLabel,
} from "@/lib/medication-category";
import {
  isCustomMedicationCategoryKey,
  updateMedicationCategoryLabelSchema,
} from "@/lib/validations/medication";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ key: string }> };

async function rateLimited(userId: string): Promise<boolean> {
  const rl = await checkRateLimit(
    `medications:category:custom:${userId}`,
    30,
    60_000,
  );
  return !rl.allowed;
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    if (await rateLimited(user.id)) {
      return apiError("Too many requests, try again later", 429);
    }

    const { key } = await params;
    if (!isCustomMedicationCategoryKey(key)) {
      return apiError("Category not found", 404);
    }

    const { data: raw, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;
    const parsed = updateMedicationCategoryLabelSchema.safeParse(raw);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "medications.category.invalid",
      });
    }

    const owned = await prisma.medicationCategoryLabel.findFirst({
      where: { key, userId: user.id },
      select: { id: true },
    });
    if (!owned) return apiError("Category not found", 404);

    const updated = await prisma.medicationCategoryLabel.update({
      where: { id: owned.id },
      data: {
        ...(parsed.data.label !== undefined
          ? { labelEncrypted: encryptCategoryLabel(parsed.data.label) }
          : {}),
        ...(parsed.data.sortOrder !== undefined
          ? { sortOrder: parsed.data.sortOrder }
          : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
      },
      select: {
        key: true,
        labelEncrypted: true,
        sortOrder: true,
        isActive: true,
      },
    });
    const medicationCount = await prisma.medicationCategoryAssignment.count({
      where: { category: key, medication: { userId: user.id } },
    });

    await auditLog("medication.category.custom.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { key, fields: Object.keys(parsed.data) },
    });
    annotate({
      action: { name: "medication.category.custom.update" },
      meta: { key },
    });

    return apiSuccess({
      key: updated.key,
      label: decryptCategoryLabel(updated.labelEncrypted),
      sortOrder: updated.sortOrder,
      isActive: updated.isActive,
      medicationCount,
    });
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    if (await rateLimited(user.id)) {
      return apiError("Too many requests, try again later", 429);
    }

    const { key } = await params;
    if (!isCustomMedicationCategoryKey(key)) {
      return apiError("Category not found", 404);
    }

    const result = await deleteMedicationCategoryLabel(user.id, key);
    if (!result) return apiError("Category not found", 404);

    await auditLog("medication.category.custom.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { key, movedCount: result.movedCount },
    });
    annotate({
      action: { name: "medication.category.custom.delete" },
      meta: { key, movedCount: result.movedCount },
    });

    return apiSuccess({ key, movedCount: result.movedCount });
  },
);
