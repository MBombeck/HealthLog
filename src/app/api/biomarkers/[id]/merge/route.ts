/**
 * `POST /api/biomarkers/{id}/merge` — fold other markers into this one (D1223).
 *
 * `{id}` is the marker that stays. `{ sourceIds, dryRun }`: the readings of
 * every source move onto the target in one transaction, converted where the
 * analyte's conversion table knows the unit, the source names become aliases
 * (`MERGE`), one `biomarker_merges` row is written per source and the sources
 * are deleted. A pair of units without a known conversion refuses the whole
 * merge (422 `labs.biomarker.merge.unitMismatch`); nothing moves. `dryRun`
 * answers the same result and writes nothing, refusals included, so the
 * preview can show them. There is no undo. See `src/lib/labs/biomarker-merge.ts`.
 *
 * Authority: `requireRecordAuth("manage", "labs")`, the same as the edit and
 * the delete beside it, because a merge rewrites and deletes markers. The
 * shared record-write ceiling is charged to the ACTOR (C1). Each deleted
 * source files what was destroyed (C3): its id and how many readings it took
 * along, never its name; the name stays in the merge ledger.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { withIdempotency } from "@/lib/idempotency";
import { mergeBiomarkers as runMerge } from "@/lib/labs/biomarker-merge";
import { annotate } from "@/lib/logging/context";
import { destroyedDetails } from "@/lib/sharing/audit-details";
import { biomarkerMergeSchema } from "@/lib/validations/biomarker-merge";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(mergeBiomarkers),
);

async function mergeBiomarkers(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  const { user } = await requireRecordAuth("manage", "labs");
  const { id } = await params;

  const parsed = await parseJsonBody(request, biomarkerMergeSchema, {
    maxBytes: 4 * 1024,
    errorCode: "labs.biomarker.merge.invalid",
  });
  if (!parsed.ok) return parsed.error;
  if (parsed.data.sourceIds.includes(id)) {
    return apiError("The target cannot be one of the sources", 422, {
      errorCode: "labs.biomarker.merge.invalid",
    });
  }

  const outcome = await runMerge({
    userId: user.id,
    targetId: id,
    sourceIds: parsed.data.sourceIds,
    dryRun: parsed.data.dryRun,
  });

  if (outcome.kind === "notFound") {
    return apiError("Biomarker not found", 404, {
      errorCode: "labs.biomarker.notFound",
      ids: outcome.ids,
    });
  }
  if (outcome.kind === "unitMismatch") {
    annotate({
      action: { name: "labs.biomarker.merge.unit-mismatch" },
      meta: { biomarkerId: id, refused: outcome.sources.length },
    });
    return apiError(
      "Some readings are in a unit that cannot be converted to the target's unit",
      422,
      {
        errorCode: "labs.biomarker.merge.unitMismatch",
        sources: outcome.sources,
      },
    );
  }

  const { result } = outcome;
  annotate({
    action: {
      name: result.dryRun
        ? "labs.biomarker.merge.preview"
        : "labs.biomarker.merge",
    },
    meta: {
      biomarkerId: id,
      sources: result.sources.length,
      movedReadings: result.movedReadings,
      convertedReadings: result.convertedReadings,
    },
  });
  if (result.dryRun) return apiSuccess(result);

  invalidateUserHealthScore(user.id);
  const ipAddress = getClientIp(request);
  for (const source of result.sources) {
    await auditLog("labs.biomarker.merge", {
      userId: user.id,
      ipAddress,
      // IDs and numbers only. The source's name is not filed here; the merge
      // ledger keeps it with the row this audit points at.
      details: {
        biomarkerId: id,
        mergeId: result.mergeId,
        ...destroyedDetails({
          model: "Biomarker",
          id: source.id,
          label: null,
          effectiveAt: new Date(),
          extra: {
            readingCount: source.readingCount,
            converted: source.conversion === "converted",
          },
        }),
      },
    });
  }

  return apiSuccess(result);
}
