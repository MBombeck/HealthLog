import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  updateCustomTagSchema,
  encryptCustomLabel,
  decryptCustomLabel,
  isCustomTagKey,
} from "@/lib/mood/custom-tags";
import { resolveCategoryKeyForUser } from "@/lib/mood/tag-groups";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ key: string }> };

/**
 * v1.13.0 / v1.17.0 — update / delete a per-user custom mood tag.
 *
 * Both handlers resolve the `custom:`-prefixed key against the CALLER's own
 * rows only — another user's key (or a catalogue key) is a 404, so a tag can
 * never be edited or removed across the ownership boundary.
 */

/**
 * `PATCH /api/mood/tags/custom/:key` — rename / re-icon / (de)activate /
 * move to another group (v1.17.0 `categoryKey`: any seeded category or an
 * own `customcat:` group; unknown / foreign → 422). The move is a real
 * `categoryId` update — custom tags belong relationally, only catalogue
 * tags "move" via the layout blob.
 */
export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { key } = await params;
    if (!isCustomTagKey(key)) return apiError("Not a custom tag", 404);

    const parsed = await parseJsonBody(request, updateCustomTagSchema, {
      maxBytes: 64 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    const owned = await prisma.moodTag.findFirst({
      where: { key, userId: user.id },
      select: { id: true },
    });
    if (!owned) return apiError("Custom tag not found", 404);

    let categoryId: string | undefined;
    if (parsed.data.categoryKey !== undefined) {
      const resolved = await resolveCategoryKeyForUser(
        parsed.data.categoryKey,
        user.id,
      );
      if (!resolved) return apiError("Unknown category", 422);
      categoryId = resolved;
    }

    const updated = await prisma.moodTag.update({
      where: { id: owned.id },
      data: {
        ...(parsed.data.label !== undefined
          ? { labelEncrypted: encryptCustomLabel(parsed.data.label) }
          : {}),
        ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon } : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
      },
      select: {
        key: true,
        icon: true,
        kind: true,
        scaleMin: true,
        scaleMax: true,
        inverse: true,
        isActive: true,
        labelEncrypted: true,
      },
    });

    // The custom label is encrypted at rest and never logged; the ledger row
    // records only which fields the edit touched and the resulting active state.
    await auditLog("mood.tag.custom.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        fields: Object.keys(parsed.data),
        isActive: updated.isActive,
      },
    });

    annotate({ action: { name: "mood.tag.custom.update" } });

    return apiSuccess({
      key: updated.key,
      labelKey: null,
      label: decryptCustomLabel(updated.labelEncrypted),
      icon: updated.icon,
      kind: updated.kind,
      scaleMin: updated.scaleMin,
      scaleMax: updated.scaleMax,
      inverse: updated.inverse,
      isActive: updated.isActive,
      custom: true,
    });
  },
);

/**
 * `DELETE /api/mood/tags/custom/:key` — soft-deactivate by default (history
 * intact); `?purge=true` hard-deletes the row and cascades its entry links.
 */
export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { key } = await params;
    if (!isCustomTagKey(key)) return apiError("Not a custom tag", 404);

    const owned = await prisma.moodTag.findFirst({
      where: { key, userId: user.id },
      select: { id: true },
    });
    if (!owned) return apiError("Custom tag not found", 404);

    const purge = request.nextUrl.searchParams.get("purge") === "true";
    if (purge) {
      // FK cascade removes the `mood_entry_tag_links` rows too.
      await prisma.moodTag.delete({ where: { id: owned.id } });
    } else {
      await prisma.moodTag.update({
        where: { id: owned.id },
        data: { isActive: false },
      });
    }

    // A purge hard-deletes the tag and cascades its `mood_entry_tag_links`,
    // unpicking historical entries — a destruction that must leave a ledger row.
    await auditLog("mood.tag.custom.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { purge },
    });

    annotate({ action: { name: "mood.tag.custom.delete" }, meta: { purge } });

    return apiSuccess({ key, purged: purge });
  },
);
