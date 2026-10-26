/**
 * Per-biomarker assessment route.
 *
 * `GET /api/insights/biomarker-assessment?biomarkerId=<id>` serves the
 * data-driven assessment for one user-scoped biomarker. The shape is
 * byte-identical to `/api/insights/metric-status` so `InsightStatusCard`
 * consumes it unchanged.
 *
 * Read-only by construction: a cache miss enqueues an out-of-band
 * generation (via `resolveReadOnlyStatusMiss` inside the generator) and
 * serves the last-good text (stale-while-revalidate), never blocking on the
 * provider. The generator regenerates ONLY when the latest reading
 * fingerprint changes, so an idle marker re-stamps cached text without an
 * LLM round-trip.
 *
 * A mixed read: the note is served, and warmed, only while the `statusText`
 * AI capability is available. Otherwise the route answers 200 with no note
 * and an `ai` state saying why, without reading the cache or queueing
 * anything. The `insights` module (the AI analysis opt-out) folds into the
 * capability.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import { unavailableStatusBody } from "@/lib/insights/status-unavailable";
import { generateBiomarkerStatus } from "@/lib/insights/biomarker-status";
import { normalizeLocale } from "@/lib/insights/status-shared";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  biomarkerId: z.string().min(1).max(64),
});

export const GET = apiHandler(async (request: NextRequest) => {
  // v1.37.0 — MANAGE-level read: a generated assessment over the whole
  // record, which is not a section a scoped grant can name. The miss behind it
  // enqueues nothing while a delegate is holding the request.
  const { user } = await requireRecordAuth("manage", "record");
  const parsed = querySchema.safeParse({
    biomarkerId: request.nextUrl.searchParams.get("biomarkerId"),
  });
  if (!parsed.success) {
    annotate({
      action: { name: "insights.biomarker-status.invalid" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const ai = await aiCapabilityToServe(user.id, "statusText");
  if (!ai.available) {
    annotate({
      action: { name: "insights.biomarker-status.unavailable" },
      meta: { reason: ai.reason },
    });
    return apiSuccess(await unavailableStatusBody(user.id, ai));
  }

  const localeParam = request.nextUrl.searchParams.get("locale");
  const resolved = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
    override: localeParam,
  });
  const locale = normalizeLocale(resolved);

  const result = await generateBiomarkerStatus({
    biomarkerId: parsed.data.biomarkerId,
    userId: user.id,
    locale,
    force: false,
    readOnly: true,
  });

  annotate({
    action: { name: "insights.biomarker-status" },
    meta: { biomarkerId: parsed.data.biomarkerId },
  });

  return apiSuccess({ ...result, ai });
});
