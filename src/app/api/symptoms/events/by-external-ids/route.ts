/**
 * `DELETE /api/symptoms/events/by-external-ids` — the iPhone app's deletion
 * reconciliation for the symptom samples it imported from Apple Health.
 *
 * Body `{ externalIds }` (at most 500), answer `{ deletedCount }`. Only the
 * record's own occurrences posted with `source = APPLE_HEALTH` are matched;
 * one logged in HealthLog is never touched. Each is tombstoned, the way the
 * single delete takes an imported occurrence, so a late re-post of the sample
 * answers `duplicate`; an id already deleted is not counted again. The envelope is shared with the other by-external-ids routes
 * (`src/lib/sync/external-id-delete.ts`).
 *
 * Module-gated on the record (403 `illness.disabled`), MANAGE on a shared
 * record like the single delete.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { prisma } from "@/lib/db";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import {
  answerExternalIdDelete,
  APP_MINTED_SOURCE,
  parseExternalIdDelete,
} from "@/lib/sync/external-id-delete";

export const dynamic = "force-dynamic";

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("manage", "illness");

  const gate = await requireIllnessEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const body = await parseExternalIdDelete(request, "symptoms");
  if (!body.ok) return body.error;

  const { count: deleted } =
    body.externalIds.length === 0
      ? { count: 0 }
      : await prisma.symptomEvent.updateMany({
          where: {
            userId: user.id,
            source: APP_MINTED_SOURCE,
            externalId: { in: body.externalIds },
            deletedAt: null,
          },
          data: { deletedAt: new Date() },
        });
  if (deleted > 0) invalidateUserHealthContext(user.id);

  return answerExternalIdDelete({
    request,
    userId: user.id,
    domain: "symptoms",
    processed: body.externalIds.length,
    deleted,
  });
});
