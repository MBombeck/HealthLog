/**
 * `POST /api/measurements/batch` — Apple Health batch ingest.
 *
 * The iOS HealthLog app drains its HealthKit observer queue into this
 * endpoint. Each entry is a HealthKit sample dressed in a thin
 * envelope (identifier, value, unit, start/end dates, optional sleep
 * stage codepoint, opaque external id). The server maps each entry
 * through `mapAppleHealthEntry()`, inserts it as a `Measurement` row
 * with `source = APPLE_HEALTH`, and returns a per-entry status so the
 * client can advance its sync cursor accurately.
 *
 * Idempotency contract:
 *   - A single batch is dedupable end-to-end via `Idempotency-Key` —
 *     an HTTP-level retry replays the cached response.
 *   - Individual entries are dedupable via the
 *     `(user_id, type, source, external_id)` composite unique index —
 *     a partial-success retry, or two devices uploading the same
 *     HealthKit sample, surface as `duplicate` per entry instead of
 *     hard-failing the batch.
 *   - v1.5.0 issue #213 — entries whose `externalId` starts with
 *     `stats:` are aggregate rows the iOS HealthKit observer re-posts as
 *     the underlying window fills. Two granularities ride the same
 *     overwrite mechanism:
 *       · per-day cumulative totals — `stats:<HK>:<YYYY-MM-DD>` (Steps,
 *         Active Energy, Sleep Duration, Walking/Running Distance,
 *         Flights Climbed);
 *       · v1.19.0 (iOS #34) heart-rate buckets, 10 minutes wide since
 *         v1.30.7 — `stats:HKQuantityTypeIdentifierHeartRate:<bucket-start>`
 *         where `<bucket-start>` is the ISO-8601 UTC 10-minute boundary
 *         (minutes 00/10/20/30/40/50), carrying the bucket's AVERAGE bpm
 *         as one PULSE row, so iOS stops uploading one row per raw HR
 *         sample.
 *     Both surface as `updated` (the row's value is overwritten) rather
 *     than `duplicate` (the new value dropped). Sample-class externalIds
 *     (every other prefix) keep the strict immutable `duplicate`
 *     contract.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, isScopedCredential, requireAuth } from "@/lib/api-handler";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  getClientIp,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import type { BatchIngestEntry } from "@/lib/measurements/batch-ingest/entries";
import { ingestMeasurementBatch } from "@/lib/measurements/batch-ingest/ingest";
import { HEALTHKIT_REQUEST_SYNC_TRIGGERS } from "@/lib/integrations/healthkit-type-sync";
import { deviceTypeEnum } from "@/lib/validations/source-priority";
import { checkRateLimit } from "@/lib/rate-limit";
import { isoDateTime } from "@/lib/validations/datetime";

const MAX_BATCH_ENTRIES = 500;

// Body-size ceiling backstopping the per-entry cap. A worst-case entry
// (max-length hkIdentifier + unit + externalId + two ISO dates + the
// numeric fields) serialises to well under 1 KB, so a legitimate
// 500-entry batch tops out a few hundred KB. 4 MB leaves an order of
// magnitude of headroom above any real batch while still rejecting a
// multi-megabyte payload before it reaches `JSON.parse` and the heap.
// The cap is a DoS ceiling, not a tight bound.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// v1.4.25 (security H-2): cap batch ingest at 60
// batches per user per minute. Healthy iOS sync drains its
// HealthKit observer queue in well under one batch per minute (the
// observer pattern coalesces), so 60/min × 500 entries/batch =
// 30 000 rows/min headroom — generous for legitimate use, and a
// hard stop for a leaked wildcard token trying to saturate the
// write pipeline.
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

// v1.8.6 — the set of `source` values this client-facing ingest
// route accepts. Deliberately narrower than the full `MeasurementSource`
// enum: `WITHINGS` and `IMPORT` are server-owned (the Withings webhook
// and the CSV importer mint those rows respectively), so letting an iOS
// client forge rows attributed to them would let an authenticated client
// pollute the per-source canonical picker with rows the server never saw
// from those integrations. The standalone iOS client only needs to tag
// its own adopt-on-pair backfill as `MANUAL` vs the default
// `APPLE_HEALTH` passthrough, so we accept exactly that pair.
const batchSourceEnum = z.enum(["APPLE_HEALTH", "MANUAL"]);

const batchEntrySchema = z.object({
  hkIdentifier: z.string().min(1).max(120),
  value: z.number().finite(),
  unit: z.string().min(1).max(60),
  startDate: isoDateTime(),
  endDate: isoDateTime(),
  sleepStage: z.number().int().min(0).max(20).optional(),
  // v1.10.0 — categorical events (WX-B). The integer `HKCategoryValue`
  // codepoint for an EVENT-class category sample (irregular-rhythm,
  // high/low-HR, walking-steadiness, breathing-disturbance). Carries the
  // device's own verdict / severity; resolved to a `rhythmClassification`
  // by `mapAppleHealthEntry`. Ignored for every non-event identifier.
  categoryValue: z.number().int().min(0).max(20).optional(),
  // v1.19.2 (iOS #34 extension) — per-bucket spread for the 10-minute
  // heart-rate bucket. `value` carries the bucket's AVERAGE bpm; these carry
  // its MIN / MAX so a client renders the band inside the bucket without
  // re-uploading raw samples. Persisted ONLY on a well-formed
  // `stats:HKQuantityTypeIdentifierHeartRate:<bucket-start>` row; ignored (stored
  // NULL) for every other entry. Optional + backward-compatible: a pre-W192
  // iOS build omits them and the bucket keeps the avg-only contract.
  valueMin: z.number().finite().optional(),
  valueMax: z.number().finite().optional(),
  // Stability is enforced per entry in the loop below, not at the field:
  // a schema-level refusal would fail the whole batch on one bad row.
  // @external-id-checked-per-entry: src/lib/measurements/batch-ingest/prepare.ts
  externalId: z.string().min(1).max(120),
  externalSourceVersion: z.string().min(1).max(120).optional(),
  // v1.8.6 — optional per-entry source tag. Defaults to
  // `APPLE_HEALTH` so every pre-W6 caller (web + current iOS) stays
  // byte-for-byte unchanged. The iOS standalone adopt-on-pair backfill
  // sends `MANUAL` for rows the user entered by hand on-device so they
  // are not mis-attributed to HealthKit. `source` is part of the
  // `(userId, type, source, externalId)` dedup key, so a `MANUAL` row
  // and an `APPLE_HEALTH` row sharing an externalId are distinct rows.
  source: batchSourceEnum.optional(),
  // v1.4.25 — optional device-type tag. The iOS client maps the
  // `HKDevice.model` of each sample to one of the canonical device
  // classes (watch | band | ring | phone | scale | other | unknown).
  // Backward-compatible: every pre-W8c iOS build skips the field and
  // the row is stored with `deviceType = null`; the canonical picker
  // treats null as `unknown` and only uses it as a tiebreaker when a
  // ranked device-type coexists in the same daily bucket.
  deviceType: deviceTypeEnum.nullable().optional(),
});

// v1.32.8 (iOS #66) — optional per-REQUEST diagnostic tag naming what woke the
// client for this sync. Purely diagnostic: it flows into the
// `measurement.batch.ingest` wide event and onto the account's HealthKit
// diagnostic columns, which the Apple Health card reads. It is never part of
// the dedup key and never an input to attribution or how a sample is stored —
// sending it or omitting it produces byte-identical row outcomes. Only the
// client knows its own wake reason, so it is client-asserted by necessity;
// being diagnostic-only, that carries no trust surface. Optional so every
// pre-#66 caller stays byte-for-byte unchanged.
// v1.42 (#1173) — `manual` names a user-initiated "Sync all" run, as opposed to
// the app simply being open (`foreground`).
// v1.43 (ios #77) — `backfill` names a history catch-up. It moves only the
// per-type `lastBackfillAt`, never the live sync stamps (see below).
const syncTriggerEnum = z.enum(HEALTHKIT_REQUEST_SYNC_TRIGGERS);

const batchPayloadSchema = z.object({
  entries: z.array(batchEntrySchema).min(1),
  syncTrigger: syncTriggerEnum.optional(),
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBatch));

async function postBatch(request: NextRequest): Promise<Response> {
  // Declares the third-party ingest scope, so a narrow `measurements:write`
  // token reaches this route alongside cookie sessions and the wildcard tokens
  // a native login mints. `requireAuth` refuses any acting-account carrier for
  // every credential shape, so the scoped token is confined to its owner's own
  // record here without this route adding an arm of its own.
  // Metered by this route's own bulk bucket below, not the shared per-account
  // write bucket: the native client syncs through here in bursts (see
  // `meterAccountWrite`).
  const auth = await requireAuth(MEASUREMENTS_WRITE_SCOPE, {
    writeBucket: "own",
  });
  const { user } = auth;

  // A scoped credential is a bridge — a scale, a home-automation rule — and not
  // the native client. Two things below turn on that distinction: what `source`
  // its rows may carry, and whether it may move the phone's sync checkpoint.
  const scoped = isScopedCredential(auth);

  // v1.4.25 (security H-2): per-user rate limit. Without
  // it, a leaked wildcard iOS token can sustain unbounded writes
  // (500 rows/batch × N batches/sec) and degrade the database for
  // every other user on the host. 60 batches/min/user is generous
  // for healthy iOS sync and tight enough that a misbehaving client
  // bottoms out within a minute.
  const rl = await checkRateLimit(
    `measurements:batch:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "measurement.batch.ingest" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many batch submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson<unknown>(request, {
    maxBytes: MAX_BODY_BYTES,
  });
  if (jsonError) return jsonError;

  // Distinguish "too many entries" from "validation failed" so the
  // client surfaces a useful diagnostic. The cap stops a buggy client
  // from saturating the request pipeline; the iOS app paginates above
  // this threshold.
  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length > MAX_BATCH_ENTRIES
  ) {
    return apiError(`Batch exceeds the ${MAX_BATCH_ENTRIES}-entry limit`, 422, {
      errorCode: "measurement.batch.too_large",
    });
  }

  const parsed = batchPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    // The code is what lets a client tell this refusal from a transient one:
    // the batch as sent will never be accepted, so resending it is pointless.
    return apiValidationError(
      parsed.error.issues[0]?.message ?? "Invalid batch",
      sanitiseZodIssues(parsed.error.issues),
      422,
      { errorCode: "measurement.batch.invalid" },
    );
  }

  // A scoped credential may attribute nothing at all — the source of its rows
  // is `EXTERNAL`, resolved from the credential below. Refused loudly rather
  // than rewritten quietly: silently relabelling a client's explicit assertion
  // hands it rows it did not ask for and no way to notice, while a 422 is
  // fixable on the first call.
  //
  // `APPLE_HEALTH` is still the label that matters most, and forging it is not
  // merely mislabelling. It is half the `(userId, type, source, externalId)`
  // dedup key, so a bridge's rows would land in the phone's namespace; it is a
  // mergeable source, so a forged row joins the cross-source merge and can
  // suppress a genuine one; and it is what `healthKitSyncSucceeded` reads to
  // decide the Apple Health card may claim the phone synced.
  //
  // v1.38.x — `MANUAL` joins it in being refused. It was permitted only
  // because it was the value the route forced anyway, so nothing was ever
  // overridden; now that bridge rows carry their own provenance, honouring it
  // would defeat the point and overriding it would be the quiet relabelling
  // the paragraph above rules out. Status and `errorCode` are unchanged.
  if (scoped && parsed.data.entries.some((e) => e.source !== undefined)) {
    annotate({
      action: { name: "measurement.batch.ingest" },
      meta: { outcome: "source_not_permitted" },
    });
    return apiError(
      "This credential resolves the source itself; omit the field",
      422,
      { errorCode: "measurement.batch.source_not_permitted" },
    );
  }

  const entries: BatchIngestEntry[] = parsed.data.entries;
  const result = await ingestMeasurementBatch({
    user: { id: user.id, timezone: user.timezone },
    scoped,
    // On the Bearer path the token's id rides `session.id`.
    ingestTokenId: scoped ? auth.session.id : null,
    entries,
    syncTrigger: parsed.data.syncTrigger,
    ipAddress: getClientIp(request),
  });

  const response = apiSuccess(result);
  if (result.failed > 0) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}
