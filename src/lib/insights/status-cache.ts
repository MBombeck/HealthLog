import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import type { AiUnavailableReason } from "@/lib/ai/capabilities/types";
import { probeProviderPresence } from "@/lib/ai/provider";
import {
  enqueueStatusGeneration,
  type InsightStatusScope,
} from "@/lib/jobs/insight-status-generate-shared";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import {
  discoveryMeasurementTypes,
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
} from "@/lib/insights/correlation-discovery";
import { MAX_CUSTOM_CORRELATION_CHANNELS } from "@/lib/insights/correlation-channel-series";
import { annotate } from "@/lib/logging/context";
import { delegatedGenerationSuppressed } from "@/lib/sharing/delegated-generation";
import type { SupportedLocale } from "@/lib/insights/status-shared";

/**
 * v1.18.11 — the measurement types the FDR correlation-discovery
 * matrix scans (`correlation-discovery.ts`). A status card whose prompt folds
 * the surviving cross-metric correlations (`getRelevantCorrelationsForMetric`)
 * can have a NEW correlation surface purely because one of these channels
 * gained paired data — with no change to the card's own metric rows. The input
 * gate must therefore fingerprint these channels too, or a freshly discovered
 * relation would be silently skipped for the day. `MOOD` is mood-entry backed
 * (folded separately via `includeMood`), so it is excluded from the
 * measurement-type set here.
 *
 * v1.21.0 (FDREXTEND) — `MEDICATION_COMPLIANCE` (dose-history ledger) and
 * `SYMPTOM_SEVERITY` (illness day-log) are likewise NON-measurement channels;
 * `discoveryMeasurementTypes` excludes them too, or the `type IN (...)` groupBy
 * below would try to cast a non-enum string to `MeasurementType` and error.
 * Their own data changes still flip a card's gate through their source models —
 * they simply do not belong in the measurement fingerprint set.
 */
const CORRELATION_CHANNEL_TYPES: readonly MeasurementType[] =
  discoveryMeasurementTypes([
    ...DISCOVERY_BEHAVIOURS,
    ...DISCOVERY_OUTCOMES,
  ]) as MeasurementType[];

/**
 * The status-note store: what a model wrote about one metric, for one person,
 * in one language.
 *
 * Every per-metric generator (the seven specialised cards, the generic
 * `metric:<ID>` cards, the derived-score and biomarker assessments) keeps its
 * note in `InsightStatusCache`, one row per `(user, metric, locale)`, the note
 * itself encrypted at rest. Until v1.39.0 the notes were appended to
 * `audit_logs` as plaintext JSON; the callers still name a note by the old
 * cache-action string (`insights.<scope>-status.<locale>`, built only by
 * `statusCacheAction`), and this module maps it onto the row.
 *
 * A row carries two things that are updated independently:
 *
 *   - the note (`textEncrypted`, its `dateKey`, `generatedAt` and the two
 *     fingerprints), written when a generation succeeds or an unchanged-data
 *     run re-dates it;
 *   - a short negative-cache window (`retryAt`, `negativeReason`), written
 *     when a generation stalls, errs or is screened, so a stalled provider
 *     does not turn every page visit into another enqueue. Writing it never
 *     touches the note, so one stall cannot hide yesterday's text, and writing
 *     a note clears it.
 *
 * Nothing here serves a note while the `statusText` capability is unavailable
 * for the record, whatever the reason: an operator switch, the person's AI
 * opt-out, a missing provider, a withdrawn consent. The note stays stored (a
 * switch flipped back costs nothing) unless consent withdrawal purges it.
 */

/**
 * The single builder of a status note's name. The shape is part of the
 * contract between the generators, the queue and this store, so it is built
 * in one place only.
 */
export function statusCacheAction(scope: string, locale: string): string {
  return `insights.${scope}-status.${locale}`;
}

const CACHE_ACTION_SHAPE = /^insights\.(.+)-status\.([^.]+)$/;

/** The row key behind a note's name, or `null` for a name of another shape. */
export function statusCacheKey(
  cacheAction: string,
): { metric: string; locale: string } | null {
  const match = CACHE_ACTION_SHAPE.exec(cacheAction);
  if (!match) return null;
  return { metric: match[1], locale: match[2] };
}

/** One stored row, decrypted. */
interface StoredStatusNote {
  /** The note, `null` when the row carries only a negative-cache window. */
  text: string | null;
  /** Per-item notes (JSON), for a card that carries them. */
  items: unknown;
  inputHash: string | null;
  snapshotHash: string | null;
  dateKey: string;
  generatedAt: Date | null;
  retryAt: Date | null;
  negativeReason: string | null;
}

function decryptOrNull(payload: Uint8Array | null): string | null {
  if (!payload || payload.byteLength === 0) return null;
  try {
    return decryptFromBytes(payload);
  } catch {
    // A note encrypted under a key the host no longer holds is a cache miss;
    // the next run writes it again.
    return null;
  }
}

async function readStatusNote(
  userId: string,
  cacheAction: string,
): Promise<StoredStatusNote | null> {
  const key = statusCacheKey(cacheAction);
  if (!key) return null;
  const row = await prisma.insightStatusCache.findUnique({
    where: { userId_metric_locale: { userId, ...key } },
    select: {
      textEncrypted: true,
      itemsEncrypted: true,
      inputHash: true,
      snapshotHash: true,
      dateKey: true,
      generatedAt: true,
      retryAt: true,
      negativeReason: true,
    },
  });
  if (!row) return null;
  const text = decryptOrNull(row.textEncrypted);
  const itemsJson = decryptOrNull(row.itemsEncrypted);
  let items: unknown = null;
  if (itemsJson !== null) {
    try {
      items = JSON.parse(itemsJson);
    } catch {
      items = null;
    }
  }
  return {
    text: text !== null && text.trim().length > 0 ? text : null,
    items,
    inputHash: row.inputHash,
    snapshotHash: row.snapshotHash,
    dateKey: row.dateKey,
    generatedAt: row.generatedAt,
    retryAt: row.retryAt,
    negativeReason: row.negativeReason,
  };
}

/**
 * Whether stored status notes may be served, or re-dated, for this record.
 * Every reader and both unchanged-data gates ask this first. Answered from
 * the record's own state, so a delegate reads the owner's notes exactly when
 * the owner would; starting work is a separate question (see below).
 */
async function statusTextServable(userId: string): Promise<boolean> {
  return (await aiCapabilityToServe(userId, "statusText")).available;
}

/**
 * Write a note: a successful generation. Upserts the one row, clears any
 * negative-cache window, and returns when the note was written.
 */
export async function writeStatusNote(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  text: string;
  /** Per-item notes for a card that carries them; serialised as JSON. */
  items?: unknown;
  snapshotHash?: string;
  inputHash?: string;
}): Promise<Date> {
  const key = statusCacheKey(args.cacheAction);
  if (!key) {
    throw new Error(`Not a status note name: ${args.cacheAction}`);
  }
  const generatedAt = new Date();
  const note = {
    textEncrypted: encryptToBytes(args.text),
    itemsEncrypted:
      args.items === undefined
        ? null
        : encryptToBytes(JSON.stringify(args.items)),
    inputHash: args.inputHash ?? null,
    snapshotHash: args.snapshotHash ?? null,
    dateKey: args.todayKey,
    generatedAt,
    retryAt: null,
    negativeReason: null,
    failureStreak: 0,
  };
  await prisma.insightStatusCache.upsert({
    where: { userId_metric_locale: { userId: args.userId, ...key } },
    create: { userId: args.userId, ...key, ...note },
    update: note,
  });
  return generatedAt;
}

/**
 * Re-date the stored note under today's day key without touching the note or
 * its fingerprints: an unchanged-data run. Returns the new timestamp.
 */
async function redateStatusNote(
  userId: string,
  cacheAction: string,
  todayKey: string,
): Promise<Date> {
  const key = statusCacheKey(cacheAction);
  const generatedAt = new Date();
  if (key) {
    // `updateMany`, not `update`: a note purged between the read and here (a
    // consent withdrawal) is a no-op, not a thrown "record not found".
    await prisma.insightStatusCache.updateMany({
      where: { userId, ...key },
      data: {
        dateKey: todayKey,
        generatedAt,
        retryAt: null,
        negativeReason: null,
        failureStreak: 0,
      },
    });
  }
  return generatedAt;
}

export interface FreshStatusCacheHit {
  kind: "generated";
  text: string;
  updatedAt: string;
  retryable: false;
  expiresAfterDateKey: string;
}

/**
 * Today's note for `(userId, cacheAction)`, or `null` on a miss, a note from
 * an earlier day, no note at all, or a capability that is unavailable. Every
 * one of those means the caller should not serve stored text as current.
 *
 * `force` short-circuits to `null` without a read, so a forced regeneration
 * never reads the cache.
 */
export async function readFreshStatusText(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  force: boolean;
}): Promise<FreshStatusCacheHit | null> {
  const { userId, cacheAction, todayKey, force } = args;
  if (force) return null;
  if (!(await statusTextServable(userId))) return null;

  const note = await readStatusNote(userId, cacheAction);
  if (!note?.text || note.dateKey !== todayKey || !note.generatedAt) {
    return null;
  }
  return {
    kind: "generated",
    text: note.text,
    updatedAt: note.generatedAt.toISOString(),
    retryable: false,
    expiresAfterDateKey: note.dateKey,
  };
}

/**
 * Today's per-item note for a card that carries one (medication compliance):
 * the summary plus the parsed items, under the same rules as
 * `readFreshStatusText`.
 */
export async function readFreshStatusItems(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
}): Promise<{ text: string; items: unknown; updatedAt: string } | null> {
  if (!(await statusTextServable(args.userId))) return null;
  const note = await readStatusNote(args.userId, args.cacheAction);
  if (!note?.text || note.dateKey !== args.todayKey || !note.generatedAt) {
    return null;
  }
  return {
    text: note.text,
    items: note.items,
    updatedAt: note.generatedAt.toISOString(),
  };
}

/**
 * The content-hash regeneration gate for the per-status and generic metric
 * cards.
 *
 * A generator that has already gathered its data snapshot calls this BEFORE
 * the provider round-trip. When the stored note's `snapshotHash` equals the
 * fresh snapshot's, nothing the prompt sees has changed: the note is re-dated
 * under today's key and returned, and the caller skips the model entirely.
 * `null` on any miss (no note, a missing or differing hash).
 *
 * The capability comes first. Re-dating a note presents it as current, so a
 * record whose `statusText` capability is unavailable (consent withdrawn,
 * AI analysis switched off, …) never has old text re-dated; the gate misses,
 * and the generator's own chokepoint then refuses the generation.
 */
export async function refreshUnchangedStatusInsight(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  snapshotHash: string;
}): Promise<FreshStatusCacheHit | null> {
  if (!(await statusTextServable(args.userId))) {
    annotate({
      action: { name: "insights.status.unavailable" },
      meta: { cache_action: args.cacheAction, gate: "unchanged-refresh" },
    });
    return null;
  }

  const note = await readStatusNote(args.userId, args.cacheAction);
  if (!note?.text || note.snapshotHash !== args.snapshotHash) return null;

  const generatedAt = await redateStatusNote(
    args.userId,
    args.cacheAction,
    args.todayKey,
  );
  annotate({
    action: { name: "insights.status.skipped_unchanged" },
    meta: { cache_action: args.cacheAction },
  });
  return {
    kind: "generated",
    text: note.text,
    updatedAt: generatedAt.toISOString(),
    retryable: false,
    expiresAfterDateKey: args.todayKey,
  };
}

/**
 * The same gate for a card that carries per-item notes: re-dates the stored
 * note when its `snapshotHash` matches and hands back the items too.
 */
export async function refreshUnchangedStatusItems(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  snapshotHash: string;
}): Promise<{ text: string; items: unknown; updatedAt: string } | null> {
  if (!(await statusTextServable(args.userId))) return null;
  const note = await readStatusNote(args.userId, args.cacheAction);
  if (!note?.text || note.snapshotHash !== args.snapshotHash) return null;
  const generatedAt = await redateStatusNote(
    args.userId,
    args.cacheAction,
    args.todayKey,
  );
  annotate({
    action: { name: "insights.status.skipped_unchanged" },
    meta: { cache_action: args.cacheAction },
  });
  return {
    text: note.text,
    items: note.items,
    updatedAt: generatedAt.toISOString(),
  };
}

/**
 * v1.18.11 — cheap input fingerprint for the slow-moving status
 * metrics (weight / BMI).
 *
 * The post-build content-hash gate (`refreshUnchangedStatusInsight`)
 * already skips the LLM on unchanged data, but it only runs AFTER the heavy
 * snapshot build (the bounded `findMany` + per-series rollup reads +
 * correlation math). For metrics that move on a weekly cadence that rebuild
 * is paid six days out of seven for nothing.
 *
 * This probe answers "did any salient input change since the cached
 * assessment?" with ONE grouped query — per salient type, the live row
 * `count` plus the newest `measuredAt`. A new or removed reading flips one
 * of those, which flips the hash; an idle day leaves it byte-identical. The
 * caller hashes the result and, on a match, skips the entire build. The
 * finer post-build snapshot gate stays in place for the cases this coarse
 * probe can't see (e.g. an in-place edit that keeps count + newest stamp).
 */
export async function computeStatusInputFingerprint(args: {
  userId: string;
  types: readonly MeasurementType[];
  /**
   * v1.18.11 — include the mood-entry table in the fingerprint. The
   * weight snapshot folds a mood-context block, so a mood change must flip
   * the input hash or the gate would skip a build whose prose could have
   * moved. Omit for metrics that don't read mood.
   */
  includeMood?: boolean;
  /**
   * v1.18.11 — include the FDR correlation-discovery channels
   * (`CORRELATION_CHANNEL_TYPES`) in the fingerprint. A card that folds the
   * surviving cross-metric correlations (via `getRelevantCorrelationsForMetric`)
   * can surface a NEW relation purely because a discovery channel — steps,
   * sleep, HRV, glucose, daylight, … — gained paired data, with NO change to
   * the card's own metric rows. Without this the input gate would re-stamp the
   * stale assessment and the freshly discovered correlation would never reach
   * the prose. Cheap: it widens the SAME grouped query by the channel type set
   * (no extra round-trip). `includeMood` is honoured for the mood arm of the
   * discovery matrix as before. Set on any card whose prompt carries a
   * relations block (i.e. whose metric is a discovery channel).
   */
  includeCorrelationChannels?: boolean;
  /**
   * v1.18.11 — extra non-measurement inputs the snapshot derives from
   * (e.g. BMI reads the profile `heightCm`). Folded into the hash so a
   * change to one of them flips the gate. Values must be JSON-stable.
   */
  extra?: Record<string, string | number | null>;
}): Promise<string> {
  // Widen the grouped query by the correlation-discovery channels when the
  // card folds a relations block, so a discovery-channel change flips the gate.
  // De-duplicate the union (a card's own type can also be a discovery channel)
  // so the `type IN (...)` list carries each type once.
  const groupTypes = args.includeCorrelationChannels
    ? Array.from(new Set<string>([...args.types, ...CORRELATION_CHANNEL_TYPES]))
    : [...args.types];

  const [grouped, mood, customMetrics] = await Promise.all([
    prisma.measurement.groupBy({
      by: ["type"],
      where: {
        userId: args.userId,
        type: { in: groupTypes as MeasurementType[] },
        deletedAt: null,
      },
      _count: { _all: true },
      _max: { measuredAt: true },
    }),
    args.includeMood
      ? prisma.moodEntry.aggregate({
          // Tombstoned rows are excluded here for the same reason they are in
          // the measurement arm above: this aggregate IS the freshness
          // fingerprint, so a deletion that leaves the count and the newest
          // timestamp untouched cannot invalidate the cached assessment, and
          // yesterday's text gets re-dated as today's over data that is gone.
          where: { userId: args.userId, deletedAt: null },
          _count: { _all: true },
          _max: { moodLoggedAt: true },
        })
      : Promise.resolve(null),
    args.includeCorrelationChannels
      ? prisma.customMetric.findMany({
          where: {
            userId: args.userId,
            deletedAt: null,
            correlationEnabled: true,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: MAX_CUSTOM_CORRELATION_CHANNELS,
          select: {
            id: true,
            unit: true,
            updatedAt: true,
            _count: { select: { entries: { where: { deletedAt: null } } } },
            entries: {
              where: { deletedAt: null },
              orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
              take: 1,
              select: { measuredAt: true, unit: true },
            },
          },
        })
      : Promise.resolve([]),
  ]);
  // Deterministic shape regardless of group order: sort by type, project a
  // stable `{ type, count, newest }` triple. `hashInsightSnapshot` sorts keys
  // and collapses Date → ISO, so the hash is order- and clock-stable.
  const fingerprint = grouped
    .map((row) => ({
      type: row.type,
      count: row._count._all,
      newest: row._max.measuredAt ? row._max.measuredAt.toISOString() : null,
    }))
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return hashInsightSnapshot({
    statusInput: fingerprint,
    ...(mood
      ? {
          mood: {
            count: mood._count._all,
            newest: mood._max.moodLoggedAt
              ? mood._max.moodLoggedAt.toISOString()
              : null,
          },
        }
      : {}),
    customMetrics: customMetrics.map((metric) => ({
      id: metric.id,
      unit: metric.unit,
      updatedAt: metric.updatedAt.toISOString(),
      count: metric._count.entries,
      newest: metric.entries[0]?.measuredAt.toISOString() ?? null,
      newestUnit: metric.entries[0]?.unit ?? null,
    })),
    ...(args.extra ? { extra: args.extra } : {}),
  });
}

/**
 * The INPUT gate for slow-moving status metrics.
 *
 * Runs BEFORE the snapshot build. When the stored note's `inputHash` equals
 * the freshly probed one, nothing the prompt could see has changed, so the
 * note is re-dated under today's key and returned; the caller then skips the
 * whole gather AND the provider call. `null` on any miss (no note, a missing
 * or differing `inputHash`, a forced regeneration), in which case the caller
 * proceeds to the normal build and the finer post-build content-hash gate.
 *
 * The capability is checked first, for the reason `refreshUnchangedStatusInsight`
 * gives.
 */
export async function gateUnchangedStatusInput(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  inputHash: string;
  force: boolean;
}): Promise<FreshStatusCacheHit | null> {
  if (args.force) return null;

  if (!(await statusTextServable(args.userId))) {
    annotate({
      action: { name: "insights.status.unavailable" },
      meta: { cache_action: args.cacheAction, gate: "unchanged-input" },
    });
    return null;
  }

  const note = await readStatusNote(args.userId, args.cacheAction);
  if (!note?.text || !note.inputHash || note.inputHash !== args.inputHash) {
    return null;
  }

  // Same inputs, a stored note: re-date it WITHOUT rebuilding the snapshot or
  // calling the provider. Both fingerprints stay, so tomorrow's gates match.
  const generatedAt = await redateStatusNote(
    args.userId,
    args.cacheAction,
    args.todayKey,
  );
  annotate({
    action: { name: "insights.status.skipped_unchanged" },
    meta: { cache_action: args.cacheAction, gate: "input" },
  });
  return {
    kind: "generated",
    text: note.text,
    updatedAt: generatedAt.toISOString(),
    retryable: false,
    expiresAfterDateKey: args.todayKey,
  };
}

export interface LastGoodStatusHit {
  text: string;
  updatedAt: string;
}

/**
 * The stored note for `(userId, cacheAction)` whatever day it was written:
 * the stale-while-revalidate source. When today's note is a miss the read path
 * can still show the last one instantly while a fresh generation is warmed,
 * so opening a category never drops to the "preparing" skeleton if a note
 * was ever written. `null` when there is none, or when the capability is
 * unavailable.
 */
export async function readLastGoodStatusText(args: {
  userId: string;
  cacheAction: string;
}): Promise<LastGoodStatusHit | null> {
  if (!(await statusTextServable(args.userId))) return null;
  const note = await readStatusNote(args.userId, args.cacheAction);
  if (!note?.text || !note.generatedAt) return null;
  return { text: note.text, updatedAt: note.generatedAt.toISOString() };
}

/**
 * The stored note written at least `minAgeHours` ago, for the next
 * generation's "what did I say last time" prompt block. Not a serving read:
 * it feeds a generation that the chokepoint has already admitted.
 */
export async function readPreviousStatusNote(args: {
  userId: string;
  cacheAction: string;
  olderThan: Date;
}): Promise<{ text: string; generatedAt: Date } | null> {
  const note = await readStatusNote(args.userId, args.cacheAction);
  if (!note?.text || !note.generatedAt) return null;
  if (note.generatedAt.getTime() >= args.olderThan.getTime()) return null;
  return { text: note.text, generatedAt: note.generatedAt };
}

/**
 * Which of `cacheActions` are not due for another generation: a note written
 * at or after `since`, or (#1279) an open negative-cache window. The ingest
 * invalidator skips those, so a fresh note survives a sync drip and a note
 * whose generation keeps failing is not selected again by every sync.
 */
export async function statusNotesNotDue(args: {
  userId: string;
  cacheActions: readonly string[];
  since: Date;
}): Promise<Set<string>> {
  const byKey = new Map<string, string>();
  for (const action of args.cacheActions) {
    const key = statusCacheKey(action);
    if (key) byKey.set(`${key.metric}\u0000${key.locale}`, action);
  }
  if (byKey.size === 0) return new Set();
  const keys = [...byKey.keys()].map((k) => {
    const [metric, locale] = k.split("\u0000");
    return { metric, locale };
  });
  const [written, coolingDown] = await Promise.all([
    prisma.insightStatusCache.findMany({
      where: {
        userId: args.userId,
        OR: keys,
        generatedAt: { gte: args.since },
        textEncrypted: { not: null },
      },
      select: { metric: true, locale: true },
    }),
    prisma.insightStatusCache.findMany({
      where: { userId: args.userId, OR: keys, retryAt: { gt: new Date() } },
      select: { metric: true, locale: true },
    }),
  ]);
  const fresh = new Set<string>();
  for (const row of [...written, ...coolingDown]) {
    const action = byKey.get(`${row.metric}\u0000${row.locale}`);
    if (action) fresh.add(action);
  }
  return fresh;
}

/**
 * Outcome of the read-only cache-miss resolution. The generators map this
 * onto their public return shape:
 *
 *   - `unavailable` → the deterministic line, no enqueue. `hasProvider` is
 *     provider presence and nothing else, so a withdrawn consent or a switch
 *     turned off no longer reads as "no provider configured"; `reason` says
 *     which layer said no.
 *   - `preparing`   → a generation is (or recently was) in flight; the last
 *     note, if any, is served meanwhile. `revalidating` is true only when a
 *     last note is served AND a fresh generation was actually enqueued, so
 *     an open card keeps polling until the new note lands.
 */
export type ReadOnlyMissOutcome =
  | {
      kind: "unavailable";
      reason: AiUnavailableReason;
      hasProvider: boolean;
    }
  | {
      kind: "preparing";
      lastGood: LastGoodStatusHit | null;
      revalidating: boolean;
    };

/**
 * Resolve what a read-only status read returns on a cache miss WITHOUT the
 * heavy SQL gather or a blocking model round-trip: a navigation request never
 * awaits a provider.
 *
 * The `statusText` capability decides first. Unavailable, for any reason,
 * means no enqueue and no stored text. Available means: serve the last note
 * (if any) and enqueue a generation out of band, unless a recent stall opened
 * a negative-cache window.
 */
export async function resolveReadOnlyStatusMiss(args: {
  userId: string;
  metric: InsightStatusScope;
  locale: SupportedLocale;
}): Promise<ReadOnlyMissOutcome> {
  // Serving view: whether the record's notes may be shown at all. Starting
  // work for a delegate is refused by the suppression branch below.
  const capability = await aiCapabilityToServe(args.userId, "statusText");
  if (!capability.available) {
    const reason = capability.reason ?? "check_failed";
    annotate({
      action: { name: "insights.status.unavailable" },
      meta: { metric: args.metric, reason, read_only_miss: true },
    });
    return {
      kind: "unavailable",
      reason,
      hasProvider: await probeProviderPresence(args.userId, "text"),
    };
  }

  // v1.37.0 — a manager holding a MANAGE grant may READ the record's notes;
  // the miss behind that read must not ship the owner's data to the owner's
  // provider on the owner's budget. The last note if there is one,
  // `preparing` if not, and nothing enqueued either way. One gate here rather
  // than in every generator, so a generator added later inherits it.
  if (delegatedGenerationSuppressed()) {
    const lastGood = await readLastGoodStatusText({
      userId: args.userId,
      cacheAction: statusCacheAction(args.metric, args.locale),
    });
    annotate({
      action: { name: "insights.status.preparing" },
      meta: {
        metric: args.metric,
        suppressed_enqueue: true,
        delegated: true,
      },
    });
    return { kind: "preparing", lastGood, revalidating: false };
  }

  const cacheAction = statusCacheAction(args.metric, args.locale);
  const lastGood = await readLastGoodStatusText({
    userId: args.userId,
    cacheAction,
  });

  // Honour the short negative-cache window: re-enqueuing on every navigation
  // while the provider is still degraded would be a storm.
  const negativeCache = await readStatusNegativeCache({
    userId: args.userId,
    cacheAction,
  });
  if (negativeCache && !negativeCache.retryable) {
    annotate({
      action: { name: "insights.status.preparing" },
      meta: { metric: args.metric, suppressed_enqueue: true },
    });
    return { kind: "preparing", lastGood, revalidating: false };
  }

  // Enqueue out of band, never await a model here. Best-effort and de-duped
  // per (user, metric).
  await enqueueStatusGeneration({
    userId: args.userId,
    metric: args.metric,
    locale: args.locale,
  });
  annotate({
    action: { name: "insights.status.preparing" },
    meta: { metric: args.metric, stale_served: lastGood !== null },
  });
  return { kind: "preparing", lastGood, revalidating: lastGood !== null };
}

/** An open negative-cache window on a note. */
export interface StatusNegativeCache {
  kind: "negative";
  reason: "timeout" | "error" | "screened";
  retryAt: string;
  retryable: boolean;
}

/**
 * The note's negative-cache window, without exposing provider errors or note
 * content. `retryable` flips once `retryAt` has passed.
 */
export async function readStatusNegativeCache(args: {
  userId: string;
  cacheAction: string;
}): Promise<StatusNegativeCache | null> {
  const note = await readStatusNote(args.userId, args.cacheAction);
  if (!note?.retryAt) return null;
  const reason =
    note.negativeReason === "error" || note.negativeReason === "screened"
      ? note.negativeReason
      : "timeout";
  return {
    kind: "negative",
    reason,
    retryAt: note.retryAt.toISOString(),
    retryable: note.retryAt.getTime() <= Date.now(),
  };
}
