/**
 * `POST   /api/encounters/{id}/links` — file things against a visit.
 * `DELETE /api/encounters/{id}/links` — unfile them.
 *
 * Deliberately bare `requireAuth()` rather than a delegable declaration, and
 * the reason is consistency rather than oversight: document link and unlink are
 * not delegable today — only the vault reads are — and an encounter link is the
 * same verb one layer up. Making one delegable and not the other would mean two
 * answers to the same question. The pair is revisited as one decision when the
 * polymorphic-linking work lands.
 *
 * Both verbs are idempotent, both are capped, and neither ever blocks a save:
 * an id that names nothing this account owns comes back in `unknown` rather
 * than failing the request, because a visit must never be un-saveable because
 * one document it pointed at has since been deleted.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiSuccess,
  apiError,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { encounterLinkSchema } from "@/lib/validations/encounters";
import { linkTargets, unlinkTargets } from "@/lib/links";
import { loadEncounterLinks } from "@/lib/encounters/service";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";

type RouteParams = { params: Promise<{ id: string }> };

async function handle(
  request: NextRequest,
  { params }: RouteParams,
  verb: "link" | "unlink",
): Promise<Response> {
  const { user } = await requireAuth();

  const { id } = await params;

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = encounterLinkSchema.safeParse(rawBody);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "encounter.link.invalid",
    });
  }

  const apply = verb === "link" ? linkTargets : unlinkTargets;
  const result = await apply(prisma, {
    userId: user.id,
    sourceKind: "encounter",
    sourceId: id,
    targetKind: parsed.data.targetKind,
    targetIds: parsed.data.targetIds,
  });

  if (result.unknownSource) {
    return apiError("Visit not found", 404);
  }

  annotate({
    action: {
      name: `encounter.link.${verb}`,
      entity_type: "encounter",
      entity_id: id,
    },
    meta: {
      target_kind: parsed.data.targetKind,
      changed: result.changed,
      unknown: result.unknownTargetIds.length,
    },
  });

  // Bare `requireAuth()` resolves the caller's OWN record — this route is
  // not delegable — so there is no narrowed grant to honour and every
  // domain is the caller's own.
  const visible = await actingDomainVisibility(prisma, null);
  const links = await loadEncounterLinks(prisma, user.id, id, visible);
  return apiSuccess({ links, unknown: result.unknownTargetIds });
}

export const POST = apiHandler(
  async (request: NextRequest, context: RouteParams) =>
    handle(request, context, "link"),
);

export const DELETE = apiHandler(
  async (request: NextRequest, context: RouteParams) =>
    handle(request, context, "unlink"),
);
