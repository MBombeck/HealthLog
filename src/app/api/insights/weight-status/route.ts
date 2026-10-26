import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/api-response";
import { generateWeightStatusForUser } from "@/lib/insights/weight-status";
import { normalizeLocale } from "@/lib/insights/status-shared";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import { unavailableStatusBody } from "@/lib/insights/status-unavailable";

export const dynamic = "force-dynamic";

/**
 * A mixed read: the card's frame is data, the note inside it is model text.
 * The note is served, and warmed on a miss, only while the `statusText` AI
 * capability is available. Otherwise the route answers 200 with no note
 * (`text: null`, `preparing: false`, `hasProvider` as provider presence) and
 * an `ai` state saying why, without reading the cache or queueing anything.
 * The `insights` module is the AI analysis opt-out and is folded into the
 * capability, so it no longer refuses the route.
 */

export const GET = apiHandler(async (request: NextRequest) => {
  // v1.37.0 — MANAGE-level read: a generated assessment over the whole
  // record, which is not a section a scoped grant can name. The miss behind it
  // enqueues nothing while a delegate is holding the request.
  const { user } = await requireRecordAuth("manage", "record");
  const ai = await aiCapabilityToServe(user.id, "statusText");
  if (!ai.available) {
    annotate({
      action: { name: "insights.weight-status.unavailable" },
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

  // v1.8.3 — read-only: serve the cache, enqueue generation out of band on
  // a miss. The GET never awaits the provider, so opening /insights/<metric>
  // can no longer pin the main thread behind a cold LLM round-trip.
  const result = await generateWeightStatusForUser(user.id, {
    locale,
    force: false,
    readOnly: true,
  });

  annotate({ action: { name: "insights.weight-status" } });

  return apiSuccess({ ...result, ai });
});
