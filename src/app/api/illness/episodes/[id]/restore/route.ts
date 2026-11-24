/**
 * `POST /api/illness/episodes/{id}/restore` — un-tombstone a soft-deleted
 * episode (the delete-Undo affordance, v1.18.3).
 *
 * Clears `deletedAt`, so the episode — and its preserved day-logs + encrypted
 * note — re-surface in every read. A soft-delete keeps the row and its
 * children intact, so restore is a pure flag flip; nothing is re-created.
 *
 * Born-gated + owner-scoped + idempotent: restoring a live episode is a
 * no-op, and a foreign / unknown id seals existence as 404. This answers the
 * iOS restore-vs-re-create question (healthlog-iOS#30) — restore wins.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import { toIllnessEpisodeDTO } from "@/lib/illness/dto";
import { enqueueWalletRefresh } from "@/lib/emergency-card/wallet-pass/queues";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(async (request, { params }) => {
    // v1.37.0 — MANAGE. Reopening a deleted episode with its day logs
    // intact; the undo beside a delete the level admits.
    const { user } = await requireRecordAuth("manage", "illness");

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const existing = await prisma.illnessEpisode.findUnique({
      where: { id },
      select: { id: true, userId: true, deletedAt: true },
    });
    // Note: no `deletedAt` filter on the existence check — the row we are
    // restoring is precisely a tombstoned one. Owner-scoped 404 either way.
    if (!existing || existing.userId !== user.id) {
      return apiError("Episode not found", 404);
    }

    // Idempotent: only flip a currently-tombstoned row. Restoring a live
    // episode is a no-op (no audit, no write).
    if (existing.deletedAt !== null) {
      await prisma.illnessEpisode.update({
        where: { id },
        data: { deletedAt: null },
      });
      await auditLog("illness.episode.restore", {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: { episodeId: id },
      });
      // Restoring an unresolved episode can flip Rest Mode back on — evict
      // the cached analytics / snapshot / digest cells.
      invalidateUserHealthContext(user.id);
    }

    const restored = await prisma.illnessEpisode.findUniqueOrThrow({
      where: { id },
    });

    annotate({
      action: {
        name: "illness.episode.restore",
        entity_type: "illness_episode",
        entity_id: id,
      },
    });

    await enqueueWalletRefresh(user.id);
    return apiSuccess(toIllnessEpisodeDTO(restored));
  }),
);
