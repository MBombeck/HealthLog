import { NextRequest } from "next/server";

import { prisma, toJson } from "@/lib/db";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  updateCustomGroupSchema,
  encryptCustomLabel,
  decryptCustomLabel,
  isCustomCategoryKey,
  CUSTOM_CATEGORY_ID,
} from "@/lib/mood/custom-tags";
import {
  parseStoredMoodTagLayout,
  stripGroupFromLayout,
} from "@/lib/mood/tag-layout";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ key: string }> };

/**
 * v1.17.0 — update / delete a per-user custom mood-tag group.
 *
 * Both handlers resolve the `customcat:`-prefixed key against the CALLER's
 * own rows only — another user's key (or a seeded category key) is a 404,
 * so a group can never be edited or removed across the ownership boundary.
 */

/** `PATCH /api/mood/tags/groups/:key` — rename / re-icon / (de)activate. */
export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { key } = await params;
    if (!isCustomCategoryKey(key)) return apiError("Not a custom group", 404);

    const parsed = await parseJsonBody(request, updateCustomGroupSchema, {
      maxBytes: 64 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    const owned = await prisma.moodTagCategory.findFirst({
      where: { key, userId: user.id },
      select: { id: true },
    });
    if (!owned) return apiError("Custom group not found", 404);

    const updated = await prisma.moodTagCategory.update({
      where: { id: owned.id },
      data: {
        ...(parsed.data.label !== undefined
          ? { labelEncrypted: encryptCustomLabel(parsed.data.label) }
          : {}),
        ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon } : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
      },
      select: {
        key: true,
        icon: true,
        isActive: true,
        labelEncrypted: true,
      },
    });

    // The group label is encrypted at rest and never logged; the ledger row
    // records only which fields changed and the resulting active state.
    await auditLog("mood.tag.group.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        fields: Object.keys(parsed.data),
        isActive: updated.isActive,
      },
    });

    annotate({ action: { name: "mood.tag.group.update" } });

    return apiSuccess({
      key: updated.key,
      labelKey: null,
      label: decryptCustomLabel(updated.labelEncrypted),
      icon: updated.icon,
      isActive: updated.isActive,
      custom: true,
    });
  },
);

/**
 * `DELETE /api/mood/tags/groups/:key` — non-destructive by construction:
 * the group's own custom tags re-home to the seeded `custom` category
 * (catalogue-tag placements simply evaporate back to their seeded category
 * when the layout entry is stripped), the layout blob drops the group, and
 * the row soft-deactivates. `?purge=true` hard-deletes the (now empty)
 * group row instead. No tag and no entry link is ever deleted here.
 */
export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { key } = await params;
    if (!isCustomCategoryKey(key)) return apiError("Not a custom group", 404);

    const owned = await prisma.moodTagCategory.findFirst({
      where: { key, userId: user.id },
      select: { id: true },
    });
    if (!owned) return apiError("Custom group not found", 404);

    const purge = request.nextUrl.searchParams.get("purge") === "true";

    const rehomedCount = await prisma.$transaction(async (tx) => {
      // 1. Re-home the caller's custom tags living in this group. Only own
      //    tags can reference an own group (the categoryKey resolvers
      //    enforce it), so this empties the group.
      const rehomed = await tx.moodTag.updateMany({
        where: { categoryId: owned.id, userId: user.id },
        data: { categoryId: CUSTOM_CATEGORY_ID },
      });

      // 2. Strip the group from the layout blob (groupOrder + placements).
      const userRow = await tx.user.findUnique({
        where: { id: user.id },
        select: { moodTagLayoutJson: true },
      });
      const layout = parseStoredMoodTagLayout(userRow?.moodTagLayoutJson);
      if (layout.groupOrder !== undefined || layout.placements !== undefined) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            moodTagLayoutJson: toJson(stripGroupFromLayout(layout, key)),
          },
        });
      }

      // 3. Retire (default) or hard-delete (purge) the empty group row.
      if (purge) {
        await tx.moodTagCategory.delete({ where: { id: owned.id } });
      } else {
        await tx.moodTagCategory.update({
          where: { id: owned.id },
          data: { isActive: false },
        });
      }

      return rehomed.count;
    });

    // Non-destructive to tags and links (they re-home), but the group row is
    // retired or purged; the ledger records which, and how many tags re-homed.
    await auditLog("mood.tag.group.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { purge, rehomedCount },
    });

    annotate({
      action: { name: "mood.tag.group.delete" },
      meta: { purge, rehomed_count: rehomedCount },
    });

    return apiSuccess({ key, purged: purge, rehomedCount });
  },
);
