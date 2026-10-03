/**
 * v1.40 (#1041) — the person's own medication categories.
 *
 *   GET  /api/medications/categories — every custom category of the record,
 *        hidden ones included, in picker order, labels decrypted, each with
 *        the number of medications filed under it.
 *   POST /api/medications/categories — create one (`{ label }`). Mints a
 *        `custom:<uuid>` key and encrypts the label at rest. Capped per
 *        account (hidden ones count).
 *
 * The label is the person's free text, so it never reaches a wide event or an
 * audit row; only the key does.
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
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { withIdempotency } from "@/lib/idempotency";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  encryptCategoryLabel,
  listMedicationCategoryLabels,
  mintCustomMedicationCategoryKey,
} from "@/lib/medication-category";
import {
  MAX_CUSTOM_MEDICATION_CATEGORIES,
  createMedicationCategoryLabelSchema,
} from "@/lib/validations/medication";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "medications");
  const categories = await listMedicationCategoryLabels(user.id);
  annotate({
    action: { name: "medication.category.custom.list" },
    meta: { count: categories.length },
  });
  return apiSuccess({ categories });
});

/**
 * Wrapped in `withIdempotency`: the key is minted fresh per request and the
 * label is ciphertext with a per-write IV, so nothing else would catch a
 * replayed create and the person's list would gain a silent duplicate.
 */
export const POST = apiHandler(
  withIdempotency<[NextRequest]>(postMedicationCategory),
);

async function postMedicationCategory(request: NextRequest): Promise<Response> {
  const { user, actor } = await requireRecordAuth("manage", "medications");

  // Keyed on the actor, the sharing precedent: a manager spends their own
  // allowance and cannot lock the owner out of their own record.
  const rl = await checkRateLimit(
    `medications:category:custom:${actor.id}`,
    30,
    60_000,
  );
  if (!rl.allowed) {
    return apiError("Too many requests, try again later", 429);
  }

  const { data: raw, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;
  const parsed = createMedicationCategoryLabelSchema.safeParse(raw);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "medications.category.invalid",
    });
  }

  const count = await prisma.medicationCategoryLabel.count({
    where: { userId: user.id },
  });
  if (count >= MAX_CUSTOM_MEDICATION_CATEGORIES) {
    return apiError(
      `Custom category limit reached (${MAX_CUSTOM_MEDICATION_CATEGORIES})`,
      422,
      { errorCode: "medications.category.limitReached" },
    );
  }

  const created = await prisma.medicationCategoryLabel.create({
    data: {
      userId: user.id,
      key: mintCustomMedicationCategoryKey(),
      labelEncrypted: encryptCategoryLabel(parsed.data.label),
      sortOrder: count,
    },
    select: { key: true, sortOrder: true, isActive: true },
  });

  await auditLog("medication.category.custom.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { key: created.key },
  });
  annotate({
    action: { name: "medication.category.custom.create" },
    meta: { key: created.key },
  });

  return apiSuccess(
    {
      key: created.key,
      label: parsed.data.label,
      sortOrder: created.sortOrder,
      isActive: created.isActive,
      medicationCount: 0,
    },
    201,
  );
}
