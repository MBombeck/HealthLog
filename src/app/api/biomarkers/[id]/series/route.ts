/**
 * `GET /api/biomarkers/{id}/series?zoom=&from=&to=` — one lab marker's line
 * (#1342).
 *
 * The same line `labSeries` on `/api/timeline` draws for the marker, by the
 * same zoom and window rules, for a client that shows it on the Labs screen:
 * a lab line belongs to Labs, so it is gated on the `labs` module rather
 * than on the opt-in `timeline`. Admission is the labs read every other
 * biomarker read declares; a delegate's grant must cover labs, and the
 * report behind a point is named only when it also covers documents.
 * Cross-user ids answer 404, and a merged marker names where it went, as
 * `GET /api/biomarkers/{id}` does.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { labSeriesQuerySchema } from "@/lib/day/wire-schemas";
import { prisma } from "@/lib/db";
import { loadBiomarkerSeries } from "@/lib/labs/biomarker-series";
import { mergedInto } from "@/lib/labs/biomarker-merge";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled, resolveModuleMap } from "@/lib/modules/gate";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { resolveUserTimezone } from "@/lib/tz/resolver";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, grantId } = await requireRecordAuth("read", "labs");
    const gate = await requireModuleEnabled(user.id, "labs");
    if (!gate.enabled) return gate.response;
    const { id } = await params;

    const query = new URL(request.url).searchParams;
    const parsed = labSeriesQuerySchema.safeParse({
      zoom: query.get("zoom") ?? undefined,
      from: query.get("from") ?? undefined,
      to: query.get("to") ?? undefined,
    });
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "labs.series.invalid",
      });
    }
    if (
      parsed.data.from &&
      parsed.data.to &&
      parsed.data.from > parsed.data.to
    ) {
      return apiError("`from` must not be after `to`", 422, {
        errorCode: "labs.series.invalid",
      });
    }

    const marker = await prisma.biomarker.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!marker) {
      const into = await mergedInto(user.id, id);
      return apiError("Biomarker not found", 404, {
        errorCode: "labs.biomarker.notFound",
        ...(into ? { mergedInto: into } : {}),
      });
    }

    const [modules, domainVisible, tz] = await Promise.all([
      resolveModuleMap(user.id),
      actingDomainVisibility(prisma, grantId),
      resolveUserTimezone(user.id),
    ]);
    const result = await loadBiomarkerSeries({
      recordId: user.id,
      biomarkerId: id,
      query: parsed.data,
      access: { modules, domainVisible, owner: grantId === null },
      tz,
    });
    if (!result) {
      return apiError("Biomarker not found", 404, {
        errorCode: "labs.biomarker.notFound",
      });
    }

    annotate({
      action: { name: "labs.biomarker.series" },
      meta: {
        biomarkerId: id,
        zoom: result.zoom,
        points: result.series.points.length,
        excluded: result.series.excluded,
      },
    });
    return apiSuccess(result);
  },
);
