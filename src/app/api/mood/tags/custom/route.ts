import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  createCustomTagSchema,
  mintCustomTagKey,
  encryptCustomLabel,
  CUSTOM_CATEGORY_ID,
  MAX_CUSTOM_TAGS_PER_USER,
} from "@/lib/mood/custom-tags";
import { resolveCategoryKeyForUser } from "@/lib/mood/tag-groups";

export const dynamic = "force-dynamic";

/**
 * v1.13.0 / v1.17.0 — create a per-user custom mood tag.
 *
 * `POST /api/mood/tags/custom` — body `{ label, icon?, categoryKey? }`. Mints
 * a `custom:<uuid>` key, encrypts the label at rest, and stores a BINARY tag
 * owned by the caller. `categoryKey` (v1.17.0) picks the home group — any
 * seeded category key or one of the caller's own `customcat:` groups; an
 * unknown or foreign key is a 422. Omitted → the seeded `custom` category
 * (the v1.13.0 behaviour, byte-identical for existing clients). Capped per
 * user.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const parsed = await parseJsonBody(request, createCustomTagSchema, {
    maxBytes: 64 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  const activeCount = await prisma.moodTag.count({
    where: { userId: user.id, isActive: true },
  });
  if (activeCount >= MAX_CUSTOM_TAGS_PER_USER) {
    return apiError(
      `Custom tag limit reached (${MAX_CUSTOM_TAGS_PER_USER})`,
      422,
    );
  }

  let categoryId = CUSTOM_CATEGORY_ID;
  if (parsed.data.categoryKey !== undefined) {
    const resolved = await resolveCategoryKeyForUser(
      parsed.data.categoryKey,
      user.id,
    );
    if (!resolved) return apiError("Unknown category", 422);
    categoryId = resolved;
  }

  const key = mintCustomTagKey();
  const created = await prisma.moodTag.create({
    data: {
      categoryId,
      key,
      // Catalogue rows resolve `labelKey` against the locale; a custom tag
      // renders its decrypted `label` instead, so labelKey just mirrors the
      // key for a stable, non-empty value.
      labelKey: key,
      labelEncrypted: encryptCustomLabel(parsed.data.label),
      icon: parsed.data.icon ?? null,
      kind: "BINARY",
      sortOrder: activeCount,
      userId: user.id,
    },
    select: {
      key: true,
      icon: true,
      kind: true,
      scaleMin: true,
      scaleMax: true,
      inverse: true,
    },
  });

  // The custom label is encrypted at rest and never logged; the ledger row
  // records the mint (icon only) so a created tag leaves a trace.
  await auditLog("mood.tag.custom.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { icon: created.icon },
  });

  annotate({
    action: { name: "mood.tag.custom.create" },
    meta: { icon: created.icon },
  });

  return apiSuccess(
    {
      key: created.key,
      labelKey: null,
      label: parsed.data.label,
      icon: created.icon,
      kind: created.kind,
      scaleMin: created.scaleMin,
      scaleMax: created.scaleMax,
      inverse: created.inverse,
      custom: true,
    },
    201,
  );
});
