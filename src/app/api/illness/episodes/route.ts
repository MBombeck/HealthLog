/**
 * `GET  /api/illness/episodes` — newest-first list of the account's
 *                                illness/condition episodes.
 * `POST /api/illness/episodes` — create one episode.
 *
 * The illness journal is a CONDITION journal, retrospective-only — NEVER a
 * predictor/diagnoser. Born-gated: a non-opted-in account (or an
 * operator-disabled instance) 403s with `errorCode:"illness.disabled"`
 * even with a valid Bearer token. `userId` is narrowed from auth and fed
 * to the Prisma `where`; it is never a body field. The `data` object is
 * built field-by-field (no mass assignment); `note` is encrypted at rest.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import { withIdempotency } from "@/lib/idempotency";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  illnessEpisodeCreateSchema,
  illnessEpisodeListQuerySchema,
} from "@/lib/validations/illness";
import { toIllnessEpisodeDTO } from "@/lib/illness/dto";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "illness");

  const gate = await requireIllnessEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const params = new URL(request.url).searchParams;
  const parsed = illnessEpisodeListQuerySchema.safeParse({
    limit: params.get("limit") ?? undefined,
    includeResolved: params.get("includeResolved") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "illness.episode.invalid",
    });
  }

  const limit = parsed.data.limit ?? 50;
  const rows = await prisma.illnessEpisode.findMany({
    where: {
      userId: user.id,
      deletedAt: null,
      ...(parsed.data.includeResolved === "false" ? { resolvedAt: null } : {}),
    },
    orderBy: { onsetAt: "desc" },
    take: limit,
  });

  annotate({
    action: { name: "illness.episode.list", entity_type: "illness_episode" },
    meta: { count: rows.length },
  });

  return apiSuccess(rows.map(toIllnessEpisodeDTO));
});

// `withIdempotency` lets an iOS retry / double-tap re-send the same
// `Idempotency-Key` without minting a duplicate episode (siblings — labs,
// measurements — wrap their creates the same way).
export const POST = apiHandler(withIdempotency<[NextRequest]>(postEpisode));

async function postEpisode(request: NextRequest): Promise<Response> {
  // v1.36.x — a delegated write. The module gate below follows the RECORD, not
  // the caller: whether illness tracking exists is a property of the record, so
  // a delegate who runs the module on their own account does not thereby gain
  // an episode surface inside somebody else's.
  const { user } = await requireRecordAuth("write", "illness");

  const gate = await requireIllnessEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = illnessEpisodeCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "illness.episode.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "illness.episode.invalid",
    });
  }

  const entry = parsed.data;

  // A FLARE/RECURRING bout may hang off a parent condition — verify the
  // parent is owned + live before threading.
  if (entry.parentConditionId) {
    const parent = await prisma.illnessEpisode.findUnique({
      where: { id: entry.parentConditionId },
      select: { userId: true, deletedAt: true },
    });
    if (!parent || parent.userId !== user.id || parent.deletedAt !== null) {
      return apiError("Parent condition not found", 404, {
        errorCode: "illness.episode.parent-not-found",
      });
    }
  }

  // Field-by-field — never spread the parsed object whole.
  const created = await prisma.illnessEpisode.create({
    data: {
      userId: user.id,
      label: entry.label,
      type: entry.type,
      lifecycle: entry.lifecycle,
      onsetAt: entry.onsetAt ? new Date(entry.onsetAt) : new Date(),
      resolvedAt: entry.resolvedAt ? new Date(entry.resolvedAt) : null,
      parentConditionId: entry.parentConditionId ?? null,
      noteEncrypted: entry.note ? encryptToBytes(entry.note) : null,
      bodySiteEncrypted: entry.bodySite?.trim()
        ? encryptToBytes(entry.bodySite.trim())
        : null,
      laterality: entry.laterality ?? null,
    },
  });

  await auditLog("illness.episode.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { episodeId: created.id, type: created.type },
  });

  // A new episode can flip Rest Mode on — evict the cached analytics /
  // snapshot / digest cells so the context is true on the next read.
  invalidateUserHealthContext(user.id);

  annotate({
    action: {
      name: "illness.episode.create",
      entity_type: "illness_episode",
      entity_id: created.id,
    },
    meta: { type: created.type, lifecycle: created.lifecycle },
  });

  return apiSuccess(toIllnessEpisodeDTO(created), 201);
}
