/**
 * `GET /api/body-sites` — the body sites the record holds, across procedures
 * and conditions, and with `?site=` (optionally `&laterality=`) everything filed
 * at one of them (v1.39.2).
 *
 * Without `site` the answer is the list of sites, which serves two surfaces:
 * the body-site view's choices, and the suggestions a body-site field offers
 * while the person types, so "knee" is not written three ways. With `site` it
 * adds the procedures and conditions at that site, each with its linked
 * documents, lab results and visits.
 *
 * Same section and level as the visit list (`("read", "profile")`): the view
 * starts from visits. Conditions ride only when the caller's grant covers the
 * `illness` section AND the record has the illness module on; otherwise the
 * condition table is not read, so neither a condition row nor a condition's
 * site reaches the answer. Links into a section the grant does not cover come
 * back as placeholders without a label. The reasoning is in
 * `src/lib/body-sites/index.ts`. `userId` is narrowed from auth and fed to the
 * Prisma `where`.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { bodySiteQuerySchema } from "@/lib/validations/body-sites";
import { loadBodySites } from "@/lib/body-sites";
import { isIllnessEnabled } from "@/lib/illness/gate";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user, grantId } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = bodySiteQuerySchema.safeParse({
    site: params.get("site") ?? undefined,
    laterality: params.get("laterality") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "body-site.invalid",
    });
  }

  const visible = await actingDomainVisibility(prisma, grantId);
  // The module follows the RECORD, like every illness route: a delegate who
  // runs the module on their own account does not open it in somebody else's.
  const conditionsReadable =
    visible("illness") && (await isIllnessEnabled(user.id));

  const body = await loadBodySites(prisma, user.id, parsed.data, {
    visible,
    conditionsReadable,
  });

  annotate({
    action: { name: "body-site.list", entity_type: "body_site" },
    meta: {
      sites: body.sites.length,
      selected: Boolean(body.selection),
      visits: body.selection?.visits.length ?? 0,
      conditions: body.selection?.conditions?.length ?? 0,
      conditions_readable: conditionsReadable,
    },
  });

  return apiSuccess(body);
});
