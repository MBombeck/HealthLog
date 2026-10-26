import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  createCustomGroupSchema,
  mintCustomCategoryKey,
  encryptCustomLabel,
  MAX_CUSTOM_GROUPS_PER_USER,
} from "@/lib/mood/custom-tags";

export const dynamic = "force-dynamic";

/**
 * v1.17.0 — create a per-user custom mood-tag group.
 *
 * `POST /api/mood/tags/groups` — body `{ label, icon? }`. Mints a
 * `customcat:<uuid>` key, encrypts the label at rest, and stores a
 * category owned by the caller. Capped per user. The group is
 * presentation-plus-home only: entry writes are key-based and never see
 * categories, so no group change can break `tagKeys` / `ratedFactors`
 * ingestion.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const parsed = await parseJsonBody(request, createCustomGroupSchema, {
    maxBytes: 64 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  const activeCount = await prisma.moodTagCategory.count({
    where: { userId: user.id, isActive: true },
  });
  if (activeCount >= MAX_CUSTOM_GROUPS_PER_USER) {
    return apiError(
      `Custom group limit reached (${MAX_CUSTOM_GROUPS_PER_USER})`,
      422,
    );
  }

  const key = mintCustomCategoryKey();
  const created = await prisma.moodTagCategory.create({
    data: {
      key,
      // Seeded rows resolve `labelKey` against the locale; a custom group
      // renders its decrypted `label` instead, so labelKey just mirrors the
      // key for a stable, non-empty value.
      labelKey: key,
      labelEncrypted: encryptCustomLabel(parsed.data.label),
      icon: parsed.data.icon ?? null,
      // After the seeded set (the `custom` category sits at 100) so a fresh
      // group appends rather than jumping the seeded categories; the
      // per-user layout blob owns the real display order.
      sortOrder: 101 + activeCount,
      userId: user.id,
    },
    select: { key: true, icon: true },
  });

  // The group label is encrypted at rest and never logged; the ledger row
  // records the mint (icon only) so a created group leaves a trace.
  await auditLog("mood.tag.group.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { icon: created.icon },
  });

  annotate({
    action: { name: "mood.tag.group.create" },
    meta: { icon: created.icon },
  });

  return apiSuccess(
    {
      key: created.key,
      labelKey: null,
      label: parsed.data.label,
      icon: created.icon,
      custom: true,
    },
    201,
  );
});
