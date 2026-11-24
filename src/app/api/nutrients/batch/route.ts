/**
 * `POST /api/nutrients/batch` — nutrient day-total ingest (v1.28).
 *
 * Two callers. The native client posts daily totals for the HealthKit codes
 * (vitamins, minerals, water, caffeine, energy, the macros) computed via
 * `HKStatisticsCollectionQuery` day-anchored cumulative sums, with a cookie
 * session or the wildcard token its login mints; those rows are stored as
 * APPLE_HEALTH. A bridge (a food tracker, a script) posts with a narrow
 * `measurements:write` token; its rows are stored as EXTERNAL, and it may post
 * `alcohol` too. The credential picks the source, never the body, so the two
 * never overwrite each other and the reads count the larger day total
 * (`foldNutrientDay`). `day` arrives as YYYY-MM-DD in the user's IANA timezone
 * (the `stats:` day-key contract — the server trusts the string after regex +
 * calendar sanity, no re-derivation); any past day is accepted, so a bridge
 * can backfill its history.
 *
 * Upsert key = the composite PK (userId, day, nutrient, source). Re-post
 * replaces amount / unit / externalSourceVersion — last-writer-wins, the
 * day-total contract; a bridge corrects a day by posting 0. Per-entry status
 * is `updated` then, never `duplicate`. Validation failures (`unit_mismatch` |
 * `value_out_of_range` | `day_invalid`) are always isolated per entry. The
 * write (`writeNutrientDayTotals`) runs as two batched groups; a write failure
 * marks its WHOLE group `skipped upsert_failed` — the request itself never
 * fails. That reason is transient, unlike the validation skips: the client
 * sends those entries again, and the response is marked `no-store` so an
 * idempotent retry is not answered from the cache.
 *
 * Module gate FIRST: the opt-in `nutrients` module (default off)
 * refuses ingest with the 403 `module.disabled` envelope, so a phone or a
 * bridge whose user never opted in cannot land rows server-side
 * (refuse-ingest posture, mirroring mental health — not surface-only).
 */
import { NextRequest } from "next/server";

import { apiHandler, isScopedCredential, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { withIngestAdmission } from "@/lib/ingest/admission";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";
import { NUTRIENT_CATALOG } from "@/lib/nutrients/catalog";
import { maxAcceptableNutrientDay } from "@/lib/nutrients/day-bounds";
import {
  writeNutrientDayTotals,
  type ValidNutrientEntry,
} from "@/lib/nutrients/day-total-write";
import { NUTRIENT_SOURCE, type NutrientSource } from "@/lib/nutrients/sources";
import {
  MAX_NUTRIENT_ENTRIES_PER_BATCH,
  nutrientBatchSchema,
} from "@/lib/validations/nutrients";
import { ownRecord } from "@/lib/own-key";

const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * Calendar sanity for an already regex-shaped YYYY-MM-DD key: reject
 * impossible dates (2026-02-31) via a UTC round-trip.
 */
function isRealCalendarDay(day: string): boolean {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

type EntryStatus = "inserted" | "updated" | "skipped";
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
}

export const POST = apiHandler(
  withIngestAdmission(withIdempotency<[NextRequest]>(postBatch)),
);

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

  // A scoped credential is a bridge — a food tracker, a script — and not the
  // native client. Its rows are stored as EXTERNAL, the phone's as
  // APPLE_HEALTH; the body has no say. Two sources, so a bridge and the phone
  // never overwrite each other's day total, and the reads count the larger.
  const scoped = isScopedCredential(auth);
  const source: NutrientSource = scoped
    ? NUTRIENT_SOURCE.EXTERNAL
    : NUTRIENT_SOURCE.APPLE_HEALTH;

  // Module gate first: a disabled module must refuse before any body
  // work, so iOS can branch on the 403 `module.disabled` errorCode and
  // stop syncing rather than retry.
  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  // A bridge counts in a bucket of its own, so a bridge stuck in a retry loop
  // cannot use up the allowance the phone needs to sync the same account. All
  // bridge tokens of one account share that bucket, so minting more tokens
  // does not multiply the allowance.
  const rl = await checkRateLimit(
    scoped ? `nutrients:batch:bridge:${user.id}` : `nutrients:batch:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many batch submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 1024 * 1024,
  });
  if (jsonError) return jsonError;

  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length >
      MAX_NUTRIENT_ENTRIES_PER_BATCH
  ) {
    return apiError(
      `Batch exceeds the ${MAX_NUTRIENT_ENTRIES_PER_BATCH}-entry limit`,
      422,
      { errorCode: "nutrient.batch.too_large" },
    );
  }

  const parsed = nutrientBatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "nutrient.batch.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "nutrient.batch.invalid",
    });
  }

  const { entries } = parsed.data;
  const dayCeiling = maxAcceptableNutrientDay(new Date());

  const results: EntryResult[] = new Array(entries.length);
  const skipped: Array<{ index: number; reason: string }> = [];
  let inserted = 0;
  let updated = 0;

  const validEntries: ValidNutrientEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const definition = NUTRIENT_CATALOG[entry.nutrient];

    // The wire carries the unit deliberately: a µg/mg confusion is a
    // silent 1000× corruption; anything but the catalog's canonical
    // unit skips the entry rather than converting.
    if (entry.unit !== definition.unit) {
      skipped.push({ index: i, reason: "unit_mismatch" });
      results[i] = { index: i, status: "skipped", reason: "unit_mismatch" };
      continue;
    }

    if (entry.amount > definition.plausibleDailyMax) {
      skipped.push({ index: i, reason: "value_out_of_range" });
      results[i] = {
        index: i,
        status: "skipped",
        reason: "value_out_of_range",
      };
      continue;
    }

    if (!isRealCalendarDay(entry.day) || entry.day > dayCeiling) {
      skipped.push({ index: i, reason: "day_invalid" });
      results[i] = { index: i, status: "skipped", reason: "day_invalid" };
      continue;
    }

    validEntries.push({
      index: i,
      day: entry.day,
      nutrient: entry.nutrient,
      amount: entry.amount,
      unit: definition.unit,
      externalSourceVersion: entry.externalSourceVersion ?? null,
    });
  }

  // `source` is part of the composite PK (migration 0249), so this write
  // touches only the caller's own source row: a manual water entry, the
  // supplement total and the other day-total source are never clobbered.
  const written = await writeNutrientDayTotals(user.id, source, validEntries);
  inserted += written.inserted;
  updated += written.updated;
  for (const { index, status } of written.statuses) {
    if (status === "failed") {
      skipped.push({ index, reason: "upsert_failed" });
      results[index] = { index, status: "skipped", reason: "upsert_failed" };
    } else {
      results[index] = { index, status };
    }
  }

  // v1.34.3 — per-reason skip breakdown, durable AND ephemeral. Computed
  // once from the closed `reason` set (never raw exception text — see the
  // upsert `catch` blocks above), so this carries only counts and reason
  // codes, never a per-entry health value or anything user-typed.
  const skippedByReason = ownRecord<number>();
  for (const s of skipped) {
    skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
  }

  // v1.34.3 — audit UNCONDITIONALLY. This used to fire only when
  // `inserted + updated > 0`, which made it the ONLY durable trace of the
  // call — so a batch where every entry was skipped (say, a systemic unit
  // mismatch) left the exact same empty AuditLog record as a phone that
  // never posted at all. An operator investigating an empty
  // `nutrient_intake_days` table could not tell "the client never called"
  // from "the client called and every entry was rejected" without that
  // record. Mirrors `measurement.batch.ingest` / `workout.batch.ingest`
  // (unconditional, counts-only, no per-entry health values) plus the
  // aggregate skip-reason breakdown so "did it post, and why did nothing
  // land" is answerable from the durable row alone, without a Wide-Event
  // trail that (unlike this table) isn't guaranteed to still exist.
  await auditLog("nutrient.batch.ingest", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      source,
      processed: entries.length,
      inserted,
      updated,
      skipped: skipped.length,
      skippedByReason,
    },
  });

  if (inserted + updated > 0) {
    // v1.30.3 — a landed row changes the dashboard's water/nutrient tile
    // and the correlation scan behind the metric pages and the Coach read;
    // without this they kept the pre-sync figure until the analytics TTL
    // lapsed. Mirrors the manual water POST's own hard-evict
    // (`nutrients/water/route.ts`) so a synced total reflects on the very
    // next read, same as a manually logged one.
    invalidateUserHealthContext(user.id);
  }

  annotate({
    action: { name: "nutrient.batch.ingest" },
    meta: {
      source,
      processed: entries.length,
      inserted,
      updated,
      skipped: skipped.length,
      skipped_by_reason: skippedByReason,
    },
  });

  const response = apiSuccess({
    processed: entries.length,
    inserted,
    updated,
    skipped,
    entries: results,
  });
  // `upsert_failed` is transient: nothing was stored for those entries and the
  // client sends them again. `no-store` keeps the idempotency layer from
  // caching this answer, so a retry under the same key writes instead of
  // replaying the failure. The measurement batch does the same for `failed`.
  if (skippedByReason.upsert_failed) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}
