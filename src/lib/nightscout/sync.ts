/**
 * Nightscout CGM sync (v1.17.0).
 *
 * Pulls the most recent SGV entries from the user's self-hosted Nightscout
 * instance and writes each as a `BLOOD_GLUCOSE` mg/dL Measurement tagged
 * `source = NIGHTSCOUT`. This is the CGM density that makes the clinical
 * glucose panel (TIR / GMI) real — a continuous stream rather than the manual
 * spot readings.
 *
 * Idempotency: each row's `externalId` is derived from Nightscout's `_id` (or
 * the reading's epoch ms), and the write is FIRST-WRITE-WINS — a CGM sample is
 * an immutable canonical reading, so the `(userId, type, source, externalId)`
 * unique collapses a re-sync onto the existing row and the `update` branch is a
 * no-op (no value overwrite). This mirrors the Apple Health immutable-sample
 * contract, not the WHOOP re-score overwrite.
 *
 * Status bookkeeping rides the shared integration ledger (`nightscout` key): a
 * clean pass stamps `recordSyncSuccess`; an unreachable instance / wrong token
 * records a classified `recordSyncFailure` and rethrows so the cohort runner
 * can warn-and-continue.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import { dropImplausibleMeasurements } from "@/lib/measurements/plausibility-gate";
import {
  markSyncFailureRecorded,
  recordSyncFailure,
  recordSyncSuccess,
  toFailureKind,
  type FailureKind,
} from "@/lib/integrations/status";
import type { IntegrationClassification } from "@/lib/integrations/http-status-classifier";
import type { SyncWriteResult } from "@/lib/outcome/written-outcome";
import { afterProviderWrite } from "@/lib/integrations/sync-kit/after-write";
import type { InsertedMeasurementArrivalRow } from "@/lib/arrivals/measurement-emit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import {
  fetchSgvEntries,
  mapSgvEntryToMeasurement,
  NightscoutApiError,
  NightscoutPolicyError,
  type ParsedSgvEntry,
} from "./client";
import { getUserNightscoutCredentials } from "./credentials";

/**
 * How many recent SGV entries to pull per sync tick. A CGM emits one reading
 * every ~5 min (≈288/day); 576 covers ~48 h of catch-up so a missed hourly
 * tick (or a brief outage) still backfills on the next run without paging the
 * full instance.
 *
 * This ~48 h window is the ONLY history Nightscout imports: there is no
 * far-history backfill queue, so connecting Nightscout brings in about two
 * days of readings and every tick thereafter walks the same recent set. A
 * deeper walk would need its own windowed-pagination queue; it is not built.
 */
export const NIGHTSCOUT_SYNC_COUNT = 576;

/**
 * Redact the Nightscout auth secret from an error message before it reaches the
 * integration ledger / the `/api/nightscout/status` response.
 *
 * The entries URL carries the access token as a `?token=<secret>` query param
 * (and a classic instance may carry `api-secret`). A `SafeFetchError` embeds the
 * full target URL verbatim in its message — a private-host refusal, a timeout,
 * or a network failure would otherwise persist the token into `lastError` and
 * echo it back through the status endpoint. Rewrite any URL in the message so
 * the secret-bearing params read `=REDACTED`; everything else is preserved so
 * the operator still sees a useful diagnostic.
 */
export function redactNightscoutSecret(message: string): string {
  // Match `token=...` / `api-secret=...` up to the next param / whitespace /
  // quote boundary. Case-insensitive on the key; the value is whatever a URL
  // query value can hold short of a delimiter.
  return message.replace(/\b(token|api-secret)=[^\s&"']+/gi, "$1=REDACTED");
}

/**
 * Record a Nightscout sync failure on the shared `nightscout` ledger with the
 * correct classification + HTTP code + the token STRIPPED from the message.
 * Extracted so the poll-cohort boundary can record a future escape with the
 * same provider-owned classification AND redaction the inline fetch catch
 * applies — a boundary-blind recorder would persist the token-bearing URL a
 * `SafeFetchError` embeds.
 */
export async function recordNightscoutSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  const policyDenied =
    err instanceof NightscoutPolicyError ||
    (typeof err === "object" &&
      err !== null &&
      "reasonCode" in err &&
      err.reasonCode === "private_origin_not_approved");
  await recordSyncFailure({
    userId,
    integration: "nightscout",
    kind: classifyNightscoutFailure(err),
    message: policyDenied
      ? "private_origin_not_approved"
      : redactNightscoutSecret(
          err instanceof Error ? err.message : String(err),
        ),
    errorCode: policyDenied
      ? "private_origin_not_approved"
      : err instanceof NightscoutApiError && err.status != null
        ? String(err.status)
        : undefined,
  });
}

/** Map a Nightscout HTTP status / network error onto the shared ledger kind. */
export function classifyNightscoutFailure(err: unknown): FailureKind {
  let classification: IntegrationClassification = "transient";
  if (
    err instanceof NightscoutPolicyError ||
    (typeof err === "object" &&
      err !== null &&
      "reasonCode" in err &&
      err.reasonCode === "private_origin_not_approved")
  ) {
    classification = "persistent";
  } else if (err instanceof NightscoutApiError && err.status != null) {
    // Wrong / missing token, or a token whose role can't read SGV.
    if (err.status === 401 || err.status === 403) {
      classification = "reauth_required";
    } else if (err.status >= 400 && err.status < 500) {
      // 4xx other than auth = a contract / config problem worth surfacing.
      classification = "persistent";
    }
  }
  // 5xx, timeout, DNS, connection refused stay `transient` — retry next tick.
  return toFailureKind(classification);
}

/**
 * Sync one user's recent SGV entries.
 *
 * `imported` counts the rows FRESHLY INSERTED this tick (re-confirmed rows the
 * upsert merely touched are not counted — the old insert+reconfirm total
 * inflated the cohort's `measurements_imported` and fired the reminder-satisfy
 * trigger every tick regardless of whether new glucose actually arrived).
 * `failed` is true when any SGV row did not write.
 *
 * The count used to be the whole return value, which narrowed the failures
 * away: a tick where every row was refused answered the same `0` as a tick
 * that found nothing new, and the settings card rendered both as a green tick
 * with a count. The caller now gets both halves and decides.
 *
 * A user with no configured instance is a clean no-op (nothing imported,
 * nothing failed, no status row touched).
 */
export async function syncUserNightscout(
  userId: string,
  opts: { count?: number } = {},
): Promise<SyncWriteResult> {
  const creds = await getUserNightscoutCredentials(userId);
  if (!creds) return { imported: 0, failed: false };

  let entries: ParsedSgvEntry[];
  try {
    entries = await fetchSgvEntries({
      baseUrl: creds.baseUrl,
      token: creds.token,
      count: opts.count ?? NIGHTSCOUT_SYNC_COUNT,
    });
  } catch (err) {
    // Recorded here (token-redacted), then marked so the poll-cohort boundary
    // does not double-record it — and never re-persists the token-bearing URL
    // a boundary-blind recorder would.
    await recordNightscoutSyncFailure(userId, err);
    throw markSyncFailureRecorded(err);
  }

  const { inserted, failedRows } = await upsertNightscoutEntries(
    userId,
    entries,
  );

  // Background-sync posture: mark the analytics cells stale (never hard-evict
  // from a poll) so the inserted rows reach the cached readers. Fires on a
  // partial failure too — rows that DID land must not stay invisible for the
  // rest of the TTL window.
  if (inserted > 0) {
    invalidateUserMeasurements(userId);
  }

  if (failedRows > 0) {
    // Partial write failure: keep the tick honest. `transient` because the
    // ~48 h re-fetch window self-heals a transient DB hiccup, while a
    // persistent malformed-row failure now accrues visible strikes instead of
    // being invisibly reset by a success stamp. Do NOT stamp success.
    await recordSyncFailure({
      userId,
      integration: "nightscout",
      kind: "transient",
      message: `${failedRows} of ${entries.length} SGV rows failed to write`,
    });
    return { imported: inserted, failed: true };
  }

  await recordSyncSuccess(userId, "nightscout");
  return { imported: inserted, failed: false };
}

/**
 * Insert each SGV entry as an immutable BLOOD_GLUCOSE mg/dL row, then fold the
 * rollup tier + invalidate status-insight caches once at the end (mirrors the
 * Withings / WHOOP sync tail). First-write-wins: the `update` branch is empty
 * so a re-sync of the same reading is a no-op rather than a rewrite. Best-effort
 * on the per-row write + the rollup fold — one bad row never aborts the pass,
 * and the count of failed rows is returned so the caller can surface a partial
 * write failure instead of stamping success over it.
 *
 * Returns `inserted` (rows whose key was absent before this pass — the honest
 * "new readings" count that also drives the arrival emit) and `failedRows`.
 */
export async function upsertNightscoutEntries(
  userId: string,
  entries: ParsedSgvEntry[],
): Promise<{ inserted: number; failedRows: number }> {
  if (entries.length === 0) return { inserted: 0, failedRows: 0 };

  const type = "BLOOD_GLUCOSE" as MeasurementType;
  // A CGM that reports a glucose the app's own band calls impossible is
  // reporting a sensor fault or a unit slip, not a reading. Drop it: the row
  // would otherwise be immutable (first-write-wins), so an impossible sample
  // that lands here never corrects itself on a later pass.
  const mapped = dropImplausibleMeasurements(
    "nightscout",
    entries.map((entry) => mapSgvEntryToMeasurement(entry)),
    (m) => ({ type, value: m.value }),
  );
  if (mapped.length === 0) return { inserted: 0, failedRows: 0 };

  // Probe which keys already exist so a re-confirmed reading (the upsert's
  // no-op update branch) is not miscounted as a fresh import and the arrival
  // spine emits ONLY the genuinely-new rows. Cohort passes are sequential per
  // user, so no concurrent insert races this probe. A probe failure degrades
  // to "treat every row as fresh" — the rollup fold + count self-correct on
  // the next tick.
  const existingKeys = new Set<string>();
  try {
    const existing = await prisma.measurement.findMany({
      where: {
        userId,
        type,
        source: "NIGHTSCOUT",
        externalId: { in: mapped.map((m) => m.externalId) },
      },
      select: { externalId: true },
    });
    for (const row of existing) {
      if (row.externalId) existingKeys.add(row.externalId);
    }
  } catch (err) {
    getEvent()?.addWarning(
      `nightscout: insert-probe failed for ${userId}: ${err}`,
    );
  }

  let failedRows = 0;
  const insertedRows: InsertedMeasurementArrivalRow[] = [];
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];

  for (const m of mapped) {
    try {
      const row = await prisma.measurement.upsert({
        where: {
          userId_type_source_externalId: {
            userId,
            type,
            source: "NIGHTSCOUT",
            externalId: m.externalId,
          },
        },
        create: {
          userId,
          type,
          source: "NIGHTSCOUT",
          value: m.value,
          unit: m.unit,
          measuredAt: m.measuredAt,
          externalId: m.externalId,
        },
        // First-write-wins: a CGM sample is immutable, so a re-sync of the
        // same reading must not rewrite the stored value or measuredAt.
        // `deletedAt: null` is a no-op on a live row, a deliberate
        // RESURRECTION on a tombstoned one — Nightscout is the source of
        // truth for its own rows, so a re-synced reading brings the row
        // back (mirrors Google / Fitbit).
        update: { deletedAt: null },
        select: { id: true },
      });
      touched.push({ type, measuredAt: m.measuredAt });
      if (!existingKeys.has(m.externalId)) {
        insertedRows.push({ type, measuredAt: m.measuredAt, id: row.id });
      }
    } catch (err) {
      getEvent()?.addWarning(
        `nightscout: failed to upsert measurement: ${err}`,
      );
      failedRows++;
    }
  }

  // Spine parity with every other measurement writer: emit at most one arrival
  // per supported kind for the rows freshly inserted. BLOOD_GLUCOSE is not yet
  // an arrival kind (`ARRIVAL_MEASUREMENT_KIND`), so this is behaviourally
  // inert for glucose today — it removes Nightscout as the spine's odd one out
  // and lights up automatically once a `glucose` arrival kind + its consuming
  // surface land in a later release.
  await afterProviderWrite({
    userId,
    provider: "nightscout",
    touched,
    arrivals: { rows: insertedRows, source: "nightscout" },
  });

  return { inserted: insertedRows.length, failedRows };
}
