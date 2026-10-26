import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess, apiError } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { hideCatalogueTagSchema, isCustomTagKey } from "@/lib/mood/custom-tags";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ key: string }> };

/**
 * v1.13.0 — hide / show a CATALOGUE tag for the calling user.
 *
 * `PUT /api/mood/tags/:key/hidden` — body `{ hidden: boolean }`. Inserts /
 * removes a `mood_tag_hidden` row so the effective `GET /api/mood/tags` omits
 * the tag for this user without touching the global catalogue. Custom tags
 * are not hidden this way — flip their own `isActive` via the custom PATCH.
 */
export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { key } = await params;
    if (isCustomTagKey(key)) {
      return apiError(
        "Custom tags are hidden via their isActive flag, not this route",
        400,
      );
    }

    const parsed = await parseJsonBody(request, hideCatalogueTagSchema, {
      maxBytes: 64 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    // Resolve against the catalogue (user_id NULL) only.
    const tag = await prisma.moodTag.findFirst({
      where: { key, userId: null },
      select: { id: true },
    });
    if (!tag) return apiError("Catalogue tag not found", 404);

    if (parsed.data.hidden) {
      await prisma.moodTagHidden.upsert({
        where: {
          userId_moodTagId: { userId: user.id, moodTagId: tag.id },
        },
        create: { userId: user.id, moodTagId: tag.id },
        update: {},
      });
    } else {
      await prisma.moodTagHidden.deleteMany({
        where: { userId: user.id, moodTagId: tag.id },
      });
    }

    // No audit row by design: hiding or showing a catalogue tag is a per-user
    // display preference, not a health-data write. It destroys nothing (the
    // catalogue tag and every entry that used it are untouched), so a ledger
    // row here would be noise rather than forensics. The wide-event annotate
    // still carries it for observability.
    annotate({
      action: { name: "mood.tag.hidden.set" },
      meta: { hidden: parsed.data.hidden },
    });

    return apiSuccess({ key, hidden: parsed.data.hidden });
  },
);
