/**
 * `POST /api/health-connect/batch` — one batch of the Android Health Connect
 * sync: records, day totals and hourly heart rate, and deletes.
 *
 * A thin adapter: the mapping and the write path are the export import's own
 * (`@/lib/health-connect/batch`), so a record lands on the row an export of
 * it writes. Around it the measurement batch's posture: the ingest admission
 * (429 with `Retry-After` when the process or the caller is saturated), a
 * required `Idempotency-Key`, the account's own bucket, a body cap, and one
 * result per item.
 *
 * Bearer with `health-connect:write`, the paired device's own token only. An
 * accepted batch extends the token a year once less than a month is left,
 * and a `live` batch that carried data stamps the device for the stall rule.
 */
import { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { markNotReplayable, withIdempotency } from "@/lib/idempotency";
import { withIngestAdmission } from "@/lib/ingest/admission";
import { checkRateLimit } from "@/lib/rate-limit";
import { requirePairedDevice } from "@/lib/health-connect/device-auth";
import { extendTokenOnUse } from "@/lib/health-connect/pairing";
import { ingestHealthConnectBatch } from "@/lib/health-connect/batch";
import { HC_BATCHES_PER_MINUTE } from "@/lib/health-connect/state";
import {
  connectedDirectIntegrations,
  packagesToSkip,
} from "@/lib/import/health-connect/skip-packages";
import { recordPairedDeviceIngest } from "@/lib/sync-stall/device-ingest";
import {
  HC_SYNC_MAX_BYTES,
  HC_SYNC_MAX_ITEMS,
  HC_SYNC_MAX_SAMPLES,
  hcBatchEnvelopeSchema,
} from "@/lib/validations/health-connect-sync";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_\-:.]{8,128}$/;

export const POST = apiHandler(
  withIngestAdmission(withIdempotency<[NextRequest]>(postBatch)),
);

/** Heart-rate samples in the raw records, without trusting their shape. */
function countSamples(records: readonly unknown[]): number {
  let n = 0;
  for (const r of records) {
    if (typeof r !== "object" || r === null) continue;
    const samples = (r as { samples?: unknown }).samples;
    if (Array.isArray(samples)) n += samples.length;
  }
  return n;
}

async function postBatch(request: NextRequest): Promise<Response> {
  const auth = await requirePairedDevice();
  if (!auth.ok) return auth.response;
  const { user } = auth;

  // Required, unlike the routes where it is an accelerator: the phone moves
  // its change tokens on our answer, and a retry without the key could not
  // be told from a second batch.
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY.test(key)) {
    return apiError("Send an Idempotency-Key with every batch", 400, {
      errorCode: "health-connect.batch.idempotency_key_required",
    });
  }

  const rl = await checkRateLimit(
    `health-connect:batch:${user.id}`,
    HC_BATCHES_PER_MINUTE,
    60 * 1000,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "health_connect.batch" },
      meta: { outcome: "rate_limited" },
    });
    const response = apiError(
      "Too many batch submissions, try again later",
      429,
    );
    response.headers.set(
      "Retry-After",
      String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
    );
    return response;
  }

  const { data: rawBody, error: jsonError } = await safeJson<unknown>(request, {
    maxBytes: HC_SYNC_MAX_BYTES,
  });
  if (jsonError) return jsonError;

  const parsed = hcBatchEnvelopeSchema.safeParse(rawBody);
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some((i) => i.code === "too_big");
    return apiValidationError(
      tooMany
        ? `A batch holds at most ${HC_SYNC_MAX_ITEMS} items of each kind`
        : (parsed.error.issues[0]?.message ?? "Invalid batch"),
      sanitiseZodIssues(parsed.error.issues),
      422,
      {
        errorCode: tooMany
          ? "health-connect.batch.too_large"
          : "health-connect.batch.invalid",
      },
    );
  }
  const body = parsed.data;
  const items =
    body.records.length + body.aggregates.length + body.deletes.length;
  if (
    items > HC_SYNC_MAX_ITEMS ||
    countSamples(body.records) > HC_SYNC_MAX_SAMPLES
  ) {
    return apiError(
      `A batch holds at most ${HC_SYNC_MAX_ITEMS} items and ${HC_SYNC_MAX_SAMPLES} heart-rate samples`,
      422,
      { errorCode: "health-connect.batch.too_large" },
    );
  }

  const skipPackages = packagesToSkip(
    await connectedDirectIntegrations(prisma, user.id),
  );
  const outcome = await ingestHealthConnectBatch({
    userId: user.id,
    timezone: user.timezone,
    records: body.records,
    aggregates: body.aggregates,
    deletes: body.deletes,
    skipPackages,
  });

  const now = new Date();
  await extendTokenOnUse(prisma, auth.tokenId, now);
  // Only a live batch is evidence the background path works; the first
  // import keeps the stamps where they are, as the iPhone's backfill does.
  if (body.phase === "live" && outcome.delivered) {
    await recordPairedDeviceIngest(prisma, {
      deviceId: auth.deviceId,
      at: now,
    });
  } else {
    await prisma.device.updateMany({
      where: { id: auth.deviceId },
      data: { lastSeen: now },
    });
  }

  annotate({
    action: { name: "health_connect.batch" },
    meta: {
      phase: body.phase,
      records: body.records.length,
      aggregates: body.aggregates.length,
      deletes: body.deletes.length,
      accepted: outcome.accepted,
      rejected: outcome.rejected,
    },
  });

  const response = apiSuccess({
    accepted: outcome.accepted,
    results: outcome.results,
  });
  if (outcome.rejected > 0) markNotReplayable(response);
  return response;
}
