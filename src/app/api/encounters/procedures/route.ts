/**
 * `GET /api/encounters/procedures` — the procedure and surgery history.
 *
 * Every visit filed as PROCEDURE that happened, newest first, with the body
 * sites it holds as filter choices. `q` searches the body site, the side and
 * the reason; `laterality` filters the side exactly. Both run after the
 * decrypt, because the body site is ciphertext at rest; the reasoning is
 * written at `Encounter.bodySiteEncrypted` and in
 * `src/lib/encounters/procedures.ts`.
 *
 * Same section and level as the visit list (`("read", "profile")`): a
 * procedure is a visit, and a grant that reads the visits reads this.
 * `userId` is narrowed from auth and fed to the Prisma `where`.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { procedureListQuerySchema } from "@/lib/validations/encounters";
import { resolveOwnerNotificationContext } from "@/lib/encounters/service";
import { loadProcedureHistory } from "@/lib/encounters/procedures";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user, grantId } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = procedureListQuerySchema.safeParse({
    q: params.get("q") ?? undefined,
    laterality: params.get("laterality") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "encounter.invalid",
    });
  }

  // The side words are the record owner's, like every other label a visit
  // resolves: a delegate searching somebody's history types in that person's
  // record, and the English word is matched as well either way.
  const { locale } = await resolveOwnerNotificationContext(user.id);
  const visible = await actingDomainVisibility(prisma, grantId);
  const body = await loadProcedureHistory(prisma, user.id, parsed.data, {
    locale,
    visible,
  });

  annotate({
    action: { name: "encounter.procedure.list", entity_type: "encounter" },
    meta: {
      total: body.total,
      matched: body.procedures.length,
      filtered: Boolean(parsed.data.q?.trim() || parsed.data.laterality),
    },
  });

  return apiSuccess(body);
});
