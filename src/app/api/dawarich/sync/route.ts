/**
 * `POST /api/dawarich/sync` — fetch the daily values again from `fromDate`
 * (at most 365 days back, ending yesterday; default: the nightly window).
 * 202 `{ enqueued }`: false when a run for this account is already queued or
 * no worker is bound. 409 `dawarich.not_connected`; 422 `dawarich.invalid`.
 * Part of the `environment` module; own account only.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
  isJsonContentType,
} from "@/lib/api-response";
import { loadDawarichConnection } from "@/lib/dawarich/connection";
import { yesterdayKey } from "@/lib/dawarich/sync";
import { enqueueDawarichSync } from "@/lib/jobs/dawarich-sync";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { daysBetweenDateKeys } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  DAWARICH_SYNC_MAX_DAYS,
  dawarichSyncSchema,
} from "@/lib/validations/dawarich";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "dawarich.sync.request" } });
  const gate = await requireModuleEnabled(user.id, "environment");
  if (!gate.enabled) return gate.response;

  // The body is optional: no body is the nightly window.
  let body: unknown = {};
  if (isJsonContentType(request.headers.get("content-type"))) {
    const read = await safeJson(request, { maxBytes: 1024 });
    if (read.error) return read.error;
    body = read.data;
  }
  const parsed = dawarichSyncSchema.safeParse(body);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "dawarich.invalid",
    });
  }

  if (!(await loadDawarichConnection(user.id))) {
    return apiError("Dawarich is not connected", 409, {
      errorCode: "dawarich.not_connected",
    });
  }

  const { fromDate } = parsed.data;
  if (fromDate !== undefined) {
    const yesterday = yesterdayKey(await resolveUserTimezone(user.id));
    const span = daysBetweenDateKeys(fromDate, yesterday) + 1;
    if (!Number.isFinite(span) || span < 1 || span > DAWARICH_SYNC_MAX_DAYS) {
      return apiError(
        `fromDate must lie within the ${DAWARICH_SYNC_MAX_DAYS} days ending yesterday`,
        422,
        { errorCode: "dawarich.invalid" },
      );
    }
  }

  const outcome = await enqueueDawarichSync({ userId: user.id, fromDate });
  annotate({ meta: { dawarich_sync: outcome } });
  return apiSuccess({ enqueued: outcome === "enqueued" }, 202);
});
