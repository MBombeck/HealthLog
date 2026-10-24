/**
 * Per-metric assessment-scope invalidation + refill.
 *
 * Maps fresh measurement types to the assessment scopes they dirty,
 * debounces the ingest-invalidation storm against recently warmed cache
 * rows, and enqueues the hash-gated background regenerations — for both
 * the ingest path (`invalidateStatusInsightsForTypes`) and the manual
 * regenerate path (`enqueueStatusRefillForUser`).
 *
 * Extracted verbatim from `comprehensive-generate.ts`, which re-exports
 * this module so every existing call site (the measurement ingest routes
 * and every provider sync) keeps importing from there.
 */
import { prisma } from "@/lib/db";
import {
  enqueueStatusGeneration,
  type InsightStatusScope,
} from "@/lib/jobs/insight-status-generate-shared";
import {
  normalizeLocale,
  type SupportedLocale,
} from "@/lib/insights/status-shared";
import {
  statusCacheAction,
  statusNotesNotDue,
} from "@/lib/insights/status-cache";
import { clearStatusNegativeWindows } from "@/lib/insights/status-negative-window";
import {
  metricIdForMeasurementType,
  metricStatusScope,
} from "@/lib/insights/metric-status-registry";
import { annotate } from "@/lib/logging/context";
import { listLiveMeasurementTypes } from "@/lib/measurements/live-types";
import { aiCapabilityForRecord } from "@/lib/ai/capabilities/gate";
import { loadRecordAiUsage } from "@/lib/ai/capabilities/usage";
import { statusRegenGapHours, type IngestSource } from "@/lib/ai/usage-level";
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * Where a batch of fresh measurements came from, which decides how soon the
 * status cards it dirties may regenerate.
 *
 *   - `manual`: a reading the person entered or changed by hand (the web
 *     form, the phone's entry sheet, a Telegram reply, an MCP write, a
 *     delete or restore, a file they chose to import). It should be narrated
 *     the same day, so its gap stays short.
 *   - `sync`: rows a device or an integration delivered on its own schedule
 *     (the phone's Apple Health sync, Withings, Oura, Fitbit, Polar, WHOOP,
 *     Nightscout, Google Health, a computed score). A watch drips these all
 *     day, and every drip moves today's partial bucket, so the content-hash
 *     gate cannot catch them; only a longer gap does.
 */
export type StatusIngestSource = IngestSource;

/**
 * The minimum gap between a scope's last cached (re)generation and the next
 * ingest-driven re-enqueue. A scope whose cached assessment was
 * (re)generated within the gap is left intact and not re-enqueued.
 *
 * History: v1.9.0 introduced the window (30 min) because a constantly
 * syncing client re-enqueued every dirtied scope on every batch. v1.16.8
 * widened it to 6 h for every ingest, which was rolled back to 1 h because a
 * lone 08:00 reading after the 04:30 nightly warm was not narrated the same
 * day. Since v1.43 (#1217) the gap is chosen by source and by the record's AI
 * usage level (`statusRegenGapHours` in `@/lib/ai/usage-level`): a hand entry
 * keeps the hour (six on `frugal`), a sync waits the operator's sync gap on
 * `standard` (default six hours), a day on `frugal` (or the operator's gap
 * when it is longer), the hour on `full`.
 */
async function ingestRegenGapMs(
  userId: string,
  source: StatusIngestSource,
): Promise<{ gapMs: number; level: string }> {
  const usage = await loadRecordAiUsage(userId);
  const hours = statusRegenGapHours(
    usage.level,
    source,
    usage.settings.syncRegenGapHours,
  );
  return { gapMs: hours * 60 * 60 * 1000, level: usage.level };
}

/**
 * The seven per-metric assessment scopes. Each generator persists its
 * cached text under `insights.<scope>-status.<locale>`; the nightly warm
 * pass refreshes them through each generator's content-hash gate, and the
 * targeted invalidator below re-enqueues only the scopes a fresh
 * measurement of a given type actually dirties.
 */
export const PER_STATUS_SCOPES = [
  "blood-pressure",
  "pulse",
  "weight",
  "bmi",
  "mood",
  "medication-compliance",
  "general",
] as const;

export type PerStatusScope = (typeof PER_STATUS_SCOPES)[number];

/**
 * Map a measurement type to the assessment scopes a fresh reading of it
 * dirties. `general` is the catch-all overview, so every measurement
 * type touches it. BMI rides on WEIGHT (it is weight ÷ height²), so a
 * new weight reading invalidates both the weight and the BMI card.
 */
function statusScopesForMeasurementType(
  type: MeasurementType,
): PerStatusScope[] {
  switch (type) {
    case "WEIGHT":
      return ["weight", "bmi", "general"];
    case "BLOOD_PRESSURE_SYS":
    case "BLOOD_PRESSURE_DIA":
      return ["blood-pressure", "general"];
    case "PULSE":
    case "RESTING_HEART_RATE":
      return ["pulse", "general"];
    default:
      // Every other tracked metric (body composition, sleep, steps,
      // glucose, …) still feeds the general overview assessment.
      return ["general"];
  }
}

/**
 * Re-warm the cached per-metric assessments that a batch of fresh
 * measurements dirties, so the next mount (or the next nightly warm
 * pass) reflects the new data instead of serving the pre-measurement
 * text for the rest of the day.
 *
 * Fire-and-forget from the measurement ingest path — idempotent and
 * never a blocker on the user's write. v1.16.8 — the invalidator no
 * longer DELETES the cache rows: the worker regenerates each enqueued
 * scope with `force: true`, and the generator's content-hash gate
 * decides whether the data actually changed. Keeping the row intact
 * preserves the stale-while-revalidate read AND lets the gate skip the
 * LLM entirely when the dirtying batch turned out to be a re-sync of
 * known data.
 */
export async function invalidateStatusInsightsForTypes(
  userId: string,
  types: Iterable<MeasurementType>,
  options: { source: StatusIngestSource },
): Promise<void> {
  // One ordered set of every scope the batch dirties. The seven specialised
  // scopes are bare slugs (`weight`, `general`, …); the generic HealthKit
  // cards (v1.8.7.1) carry a `metric:<ID>` prefix. Both share the cache-key
  // shape `insights.<scope>-status.<locale>`, so a single set covers the
  // eviction + the debounce filter + the enqueue uniformly. Only registered,
  // data-bearing types contribute a generic scope; the seven specialised
  // metrics and any unregistered type resolve to null and are skipped, so
  // the constant sync cannot fan out to unwanted scopes.
  const scopes = new Set<InsightStatusScope>();
  for (const type of types) {
    for (const scope of statusScopesForMeasurementType(type)) {
      scopes.add(scope);
    }
    const metricId = metricIdForMeasurementType(type);
    if (metricId) {
      scopes.add(metricStatusScope(metricId));
    }
  }
  if (scopes.size === 0) return;

  // No enqueue while status notes are unavailable for this record: the worker
  // would refuse anyway, and the queue should not carry work nobody may do.
  const capability = await aiCapabilityForRecord(userId, "statusText");
  if (!capability.available) {
    annotate({
      action: { name: "insights.status.invalidate.skipped" },
      meta: { reason: capability.reason },
    });
    return;
  }

  // v1.8.7 — regenerate only the user's resolved locale, matching the
  // read-path (every `*-status` GET serves `normalizeLocale(user.locale)`).
  // Warming both locales doubled provider spend on every sync, half of it
  // for a language the user never opens. A second locale a client actually
  // reads warms lazily through the read-path enqueue on its first miss.
  const localeRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { locale: true },
  });
  const locale = normalizeLocale(localeRow?.locale);

  // v1.9.0 — debounce the ingest-invalidation storm. A constantly-syncing
  // client drips batches every few minutes; re-enqueuing every dirtied
  // scope on every batch regenerated the same card several times an hour
  // (the per-(user,scope,locale) enqueue singleton is only 120 s, so it
  // could not coalesce across batches arriving minutes apart). Skip any
  // scope whose cached assessment was (re)generated within the minimum
  // gap — leave its row intact and do NOT re-enqueue. A genuinely stale
  // or missing scope still refreshes immediately, so correctness holds;
  // only the redundant churn is removed. Past the gap the enqueue always
  // goes through — the worker's content-hash gate decides whether the
  // batch actually changed anything (see the constant's doc).
  const { gapMs, level } = await ingestRegenGapMs(userId, options.source);
  const freshScopes = await findRecentlyWarmedScopes(
    userId,
    locale,
    scopes,
    gapMs,
  );
  const staleScopes = Array.from(scopes).filter(
    (scope) => !freshScopes.has(scope),
  );
  if (staleScopes.length === 0) {
    annotate({
      action: { name: "insights.status.invalidate.debounced" },
      meta: {
        skipped: scopes.size,
        refreshed: 0,
        source: options.source,
        usage_level: level,
      },
    });
    return;
  }

  // v1.8.7 — regenerate-on-invalidate: enqueue a debounced regenerate for
  // each dirtied scope so the cache is re-warmed in the background. The
  // enqueue is coalesced per `(user, metric, locale)` via the queue's
  // `singletonKey` (120 s window); the debounce above is the second, wider
  // coalescing layer that survives across the sync drip. The cache row
  // stays in place (stale-while-revalidate keeps the previous assessment
  // visible) — the worker forces the generator, whose content-hash gate
  // skips the LLM when the batch did not actually change the snapshot.
  for (const scope of staleScopes) {
    void enqueueStatusGeneration({ userId, metric: scope, locale });
  }

  annotate({
    action: { name: "insights.status.invalidate.debounced" },
    meta: {
      skipped: freshScopes.size,
      refreshed: staleScopes.length,
      source: options.source,
      usage_level: level,
    },
  });
}

/**
 * v1.16.8 — enqueue a hash-gated refill of every assessment card one user
 * actually has: the seven specialised scopes plus the generic
 * `metric:<ID>` scope of every measurement type with live rows. The
 * worker regenerates each enqueued scope with `force: true`, so every
 * card skips its same-day cache read, re-gathers its snapshot, and lands
 * on the content-hash gate — a card whose data changed regenerates, an
 * unchanged card gets a free timestamp refresh.
 *
 * This is the manual-regenerate path's card story: the POST regenerate
 * used to blanket-evict every per-status row, which deleted the hash
 * baselines and force-paid ~45 regenerations per click. Enqueuing through
 * the gate keeps the baseline rows intact, so a user who noticed a stale
 * card gets exactly the changed cards re-narrated — and nothing else.
 * Deliberately NOT routed through the ingest debounce: an explicit
 * regenerate is a user action, already bounded by the route's hourly
 * rate limit and the queue's per-(user,scope,locale) singleton.
 *
 * Returns the number of scopes enqueued (best-effort — the generic-scope
 * discovery read failing still refills the seven specialised cards).
 */
export async function enqueueStatusRefillForUser(
  userId: string,
  locale: SupportedLocale,
): Promise<number> {
  const capability = await aiCapabilityForRecord(userId, "statusText");
  if (!capability.available) {
    annotate({
      action: { name: "insights.status.refill.skipped" },
      meta: { reason: capability.reason },
    });
    return 0;
  }
  // #1279 — the person asked for fresh notes: a note backing off after
  // failed generations is asked again now, not when its window lapses.
  await clearStatusNegativeWindows(userId);
  const scopes = new Set<InsightStatusScope>(PER_STATUS_SCOPES);
  try {
    // v1.42 — a loose index scan over the live-rows index (`live-types.ts`)
    // rather than a `GROUP BY` that reads every live row of a dense
    // multi-year account to answer "which types exist?".
    const types = await listLiveMeasurementTypes(userId);
    for (const type of types) {
      const metricId = metricIdForMeasurementType(type);
      if (metricId) scopes.add(metricStatusScope(metricId));
    }
  } catch {
    // Discovery is best-effort; the specialised scopes still refill.
  }
  for (const scope of scopes) {
    void enqueueStatusGeneration({ userId, metric: scope, locale });
  }
  return scopes.size;
}

/**
 * v1.9.0 — return the subset of `scopes` whose cached assessment for
 * `locale` was generated within `gapMs` and is a
 * real (non-stub) assessment. Those scopes are skipped by the ingest
 * invalidator so a fresh assessment survives the sync drip.
 *
 * One indexed read per user answers it for every candidate scope at once.
 * #1279 — a scope inside an open negative-cache window counts too: it used to
 * be re-enqueued by every sync batch however often its generation had just
 * failed. Once the window lapses the next sync enqueues it again.
 */
async function findRecentlyWarmedScopes(
  userId: string,
  locale: SupportedLocale,
  scopes: ReadonlySet<InsightStatusScope>,
  gapMs: number,
): Promise<Set<InsightStatusScope>> {
  const cutoff = new Date(Date.now() - gapMs);
  // Match exactly the cache actions for the candidate scopes in this locale.
  const candidateActions = Array.from(scopes, (scope) =>
    statusCacheAction(scope, locale),
  );
  const actionToScope = new Map<string, InsightStatusScope>();
  for (const scope of scopes) {
    actionToScope.set(statusCacheAction(scope, locale), scope);
  }

  const written = await statusNotesNotDue({
    userId,
    cacheActions: candidateActions,
    since: cutoff,
  });
  const fresh = new Set<InsightStatusScope>();
  for (const action of written) {
    const scope = actionToScope.get(action);
    if (scope) fresh.add(scope);
  }
  return fresh;
}
