/**
 * `GET    /api/illness/episodes/{id}` — one owned, live episode.
 * `PATCH  /api/illness/episodes/{id}` — edit it (partial; field-by-field).
 * `DELETE /api/illness/episodes/{id}` — soft-delete it (idempotent;
 *          returns `{ deleted: true }`).
 *
 * Born-gated + owner-scoped. `userId` is narrowed from auth and fed to the
 * Prisma `where`; the body never carries it. `note` is encrypted at rest.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { illnessEpisodeUpdateSchema } from "@/lib/validations/illness";
import { toIllnessEpisodeDTO } from "@/lib/illness/dto";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "illness");

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const row = await prisma.illnessEpisode.findUnique({ where: { id } });
    if (!row || row.userId !== user.id || row.deletedAt !== null) {
      return apiError("Episode not found", 404);
    }

    annotate({
      action: {
        name: "illness.episode.read",
        entity_type: "illness_episode",
        entity_id: id,
      },
    });

    return apiSuccess(toIllnessEpisodeDTO(row));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. The module gate below resolves against the RECORD, so
    // a manager cannot edit an episode in a record whose owner switched the
    // module off.
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
        onsetAt: true,
        resolvedAt: true,
        // v1.37.0 — the pre-image the audit row carries (C4).
        label: true,
        type: true,
        lifecycle: true,
        parentConditionId: true,
        laterality: true,
      },
    });
    if (
      !existing ||
      existing.userId !== user.id ||
      existing.deletedAt !== null
    ) {
      return apiError("Episode not found", 404);
    }

    const { data: rawBody, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = illnessEpisodeUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "illness.episode.invalid",
      });
    }
    const entry = parsed.data;

    // Window invariant against the MERGED state: a partial edit touching only
    // one instant is validated against the stored value (the schema already
    // catches a both-in-body inversion).
    const mergedOnset =
      entry.onsetAt !== undefined ? new Date(entry.onsetAt) : existing.onsetAt;
    const mergedResolved =
      entry.resolvedAt !== undefined
        ? entry.resolvedAt
          ? new Date(entry.resolvedAt)
          : null
        : existing.resolvedAt;
    if (mergedResolved && mergedResolved < mergedOnset) {
      return apiError("resolvedAt must be on or after onsetAt", 422, {
        errorCode: "illness.episode.invalid-window",
      });
    }

    // A re-parent must point at an owned, live episode.
    if (entry.parentConditionId) {
      const parent = await prisma.illnessEpisode.findUnique({
        where: { id: entry.parentConditionId },
        select: { userId: true, deletedAt: true },
      });
      if (
        entry.parentConditionId === id ||
        !parent ||
        parent.userId !== user.id ||
        parent.deletedAt !== null
      ) {
        return apiError("Parent condition not found", 404, {
          errorCode: "illness.episode.parent-not-found",
        });
      }
    }

    // Field-by-field — only fields actually present in the body are written.
    const data: Prisma.IllnessEpisodeUpdateInput = {};
    if (entry.label !== undefined) data.label = entry.label;
    if (entry.type !== undefined) data.type = entry.type;
    if (entry.lifecycle !== undefined) data.lifecycle = entry.lifecycle;
    if (entry.onsetAt !== undefined) data.onsetAt = new Date(entry.onsetAt);
    if (entry.resolvedAt !== undefined) {
      data.resolvedAt = entry.resolvedAt ? new Date(entry.resolvedAt) : null;
    }
    if (entry.parentConditionId !== undefined) {
      data.parent = entry.parentConditionId
        ? { connect: { id: entry.parentConditionId } }
        : { disconnect: true };
    }
    if (entry.note !== undefined) {
      data.noteEncrypted = entry.note ? encryptToBytes(entry.note) : null;
    }
    // v1.39.2 — the body site and side. Written only when the key is in the
    // body: the shipped iPhone app edits conditions and has never heard of
    // either field, so an absent key must keep what the web client stored.
    if (entry.bodySite !== undefined) {
      data.bodySiteEncrypted = entry.bodySite?.trim()
        ? encryptToBytes(entry.bodySite.trim())
        : null;
    }
    if (entry.laterality !== undefined) data.laterality = entry.laterality;

    const updated = await prisma.illnessEpisode.update({ where: { id }, data });

    await auditLog("illness.episode.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C4 — the replaced fields; the note is named and never quoted.
      details: {
        episodeId: id,
        ...overwriteDetails({
          before: {
            label: existing.label,
            type: existing.type,
            lifecycle: existing.lifecycle,
            onsetAt: existing.onsetAt,
            resolvedAt: existing.resolvedAt,
            parentConditionId: existing.parentConditionId,
            laterality: existing.laterality,
          },
          after: {
            label: updated.label,
            type: updated.type,
            lifecycle: updated.lifecycle,
            onsetAt: updated.onsetAt,
            resolvedAt: updated.resolvedAt,
            parentConditionId: updated.parentConditionId,
            laterality: updated.laterality,
          },
          // The site is the person's own words, like the note: named when it
          // changed, never quoted.
          redacted: [
            ...(entry.note !== undefined ? ["note"] : []),
            ...(entry.bodySite !== undefined ? ["bodySite"] : []),
          ],
        }),
      },
    });

    // An onset / lifecycle / resolvedAt edit can flip Rest Mode — evict the
    // cached analytics / snapshot / digest cells so the context is true on
    // the next read.
    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "illness.episode.update",
        entity_type: "illness_episode",
        entity_id: id,
      },
    });

    return apiSuccess(toIllnessEpisodeDTO(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Soft delete with a restore route beside it; the day
    // logs under the episode come back with it.
    const { user } = await requireRecordAuth("manage", "illness");

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const existing = await prisma.illnessEpisode.findUnique({
      where: { id },
      select: { id: true, userId: true, deletedAt: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Episode not found", 404);
    }

    if (existing.deletedAt === null) {
      await prisma.illnessEpisode.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await auditLog("illness.episode.delete", {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: { episodeId: id },
      });
      // Deleting an active episode can flip Rest Mode off — evict the cached
      // analytics / snapshot / digest cells.
      invalidateUserHealthContext(user.id);
    }

    annotate({
      action: {
        name: "illness.episode.delete",
        entity_type: "illness_episode",
        entity_id: id,
      },
    });

    // Standard `{ deleted: true }` envelope (the cross-module DELETE shape) so
    // the client never has to special-case a bodyless 204 here.
    return apiSuccess({ deleted: true });
  },
);
