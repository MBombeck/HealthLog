/**
 * `POST   /api/labs/{id}/links` — file documents (the report it was read
 * from) or visits against a lab result.
 * `DELETE /api/labs/{id}/links` — unfile them.
 *
 * `{ targetKind, targetIds }` in, `{ changed, unknown }` out, through the
 * shared link service like the visit and vaccination link routes; an id that
 * names nothing this account owns comes back in `unknown`. Own account only,
 * as the other link routes.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { prisma } from "@/lib/db";
import { linkTargets, unlinkTargets } from "@/lib/links";
import { annotate } from "@/lib/logging/context";
import { labResultLinkSchema } from "@/lib/validations/relation-links";

type RouteParams = { params: Promise<{ id: string }> };

async function handle(
  request: NextRequest,
  { params }: RouteParams,
  verb: "link" | "unlink",
): Promise<Response> {
  const { user } = await requireAuth();
  const { id } = await params;

  const parsed = await parseJsonBody(request, labResultLinkSchema, {
    maxBytes: 16 * 1024,
    errorCode: "labs.link.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const apply = verb === "link" ? linkTargets : unlinkTargets;
  const result = await apply(prisma, {
    userId: user.id,
    sourceKind: "labResult",
    sourceId: id,
    targetKind: parsed.data.targetKind,
    targetIds: parsed.data.targetIds,
  });
  // Like the visit and vaccination link routes: a link to a source this
  // account does not own is a 404; an unlink is scoped to the account's own
  // link rows and so is an idempotent no-op instead.
  if (result.unknownSource) {
    return apiError("Lab result not found", 404);
  }

  annotate({
    action: {
      name: `labs.link.${verb}`,
      entity_type: "lab_result",
      entity_id: id,
    },
    meta: {
      target_kind: parsed.data.targetKind,
      changed: result.changed,
      unknown: result.unknownTargetIds.length,
    },
  });

  return apiSuccess({
    changed: result.changed,
    unknown: result.unknownTargetIds,
  });
}

export const POST = apiHandler(
  async (request: NextRequest, context: RouteParams) =>
    handle(request, context, "link"),
);

export const DELETE = apiHandler(
  async (request: NextRequest, context: RouteParams) =>
    handle(request, context, "unlink"),
);
