/**
 * `PATCH /api/illness/episodes/{id}/resolve` — mark an episode recovered.
 *
 * Sets `resolvedAt` (defaults to "now" when the body omits it). A
 * dedicated verb so the history surface's one-tap "mark recovered" never
 * has to send the full edit body. Born-gated + owner-scoped. A
 * CHRONIC_ONGOING episode has no "recovered" date by design — resolving
 * one is refused.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import { illnessEpisodeResolveSchema } from "@/lib/validations/illness";
import { toIllnessEpisodeDTO } from "@/lib/illness/dto";

type RouteParams = { params: Promise<{ id: string }> };

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Closing an episode; the window it writes is the
    // record's own and the reopen is one route over.
    const { user } = await requireRecordAuth("manage", "illness");

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const existing = await prisma.illnessEpisode.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        lifecycle: true,
        onsetAt: true,
      },
    });
    if (
      !existing ||
      existing.userId !== user.id ||
      existing.deletedAt !== null
    ) {
      return apiError("Episode not found", 404);
    }
    if (existing.lifecycle === "CHRONIC_ONGOING") {
      return apiError("A chronic-ongoing condition has no recovery date", 422, {
        errorCode: "illness.episode.chronic-no-resolve",
      });
    }

    const parsed = await parseJsonBody(request, illnessEpisodeResolveSchema, {
      maxBytes: 4 * 1024,
      input: (rawBody) => rawBody ?? {},
      errorCode: "illness.episode.invalid",
    });
    if (!parsed.ok) return parsed.error;

    const resolvedAt = parsed.data.resolvedAt
      ? new Date(parsed.data.resolvedAt)
      : new Date();

    // An episode can never resolve before it began (the inverted-window guard,
    // checked against the stored onset since the body only carries resolvedAt).
    if (resolvedAt < existing.onsetAt) {
      return apiError("resolvedAt must be on or after onsetAt", 422, {
        errorCode: "illness.episode.invalid-window",
      });
    }

    const updated = await prisma.illnessEpisode.update({
      where: { id },
      data: { resolvedAt },
    });

    await auditLog("illness.episode.resolve", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { episodeId: id },
    });

    // Resolving flips Rest Mode off — evict the cached analytics / snapshot /
    // digest cells so the context is true on the next read.
    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "illness.episode.resolve",
        entity_type: "illness_episode",
        entity_id: id,
      },
    });

    return apiSuccess(toIllnessEpisodeDTO(updated));
  },
);
