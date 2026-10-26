/**
 * The single-workout detail behind `GET /api/workouts/{id}`: the stored row,
 * the canonical winner of its duplicate cluster, the enrichment reads (heart
 * rate curve, effort zones, splits, sport context, the previous session) and
 * the stored Activity Insight while it may be served. The route owns
 * authentication, the module gate and the AI capability.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  canonicalClusterOf,
  canonicalWorkoutsInRange,
  readWorkoutsAroundRange,
  type CanonicalReadRow,
  type WorkoutBoundedRead,
  type WorkoutStartBounds,
} from "@/lib/workouts/canonical-read";
import type { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { buildWorkoutHrSeries } from "@/lib/workouts/hr-series";
import {
  computeZones,
  hrMaxFromAge,
  parseWhoopZoneDurations,
} from "@/lib/workouts/zones";
import { computeSplits } from "@/lib/workouts/splits";
import { buildSportContext } from "@/lib/workouts/sport-context";
import type { RouteCoordinate } from "@/lib/workouts/route-svg";
import { readRouteGeometry } from "@/lib/workouts/route-geometry-cipher";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { userDayKey } from "@/lib/tz/format";

type AiState = Awaited<ReturnType<typeof aiCapabilityToServe>>;

/** How many earlier rows one step of the previous-session search reads. */
const PREVIOUS_SESSION_BATCH = 20;
/** Steps before the search gives up; each reaches past the last one. */
const PREVIOUS_SESSION_MAX_STEPS = 5;

/**
 * The newest canonical workout of the sport that starts before `before` (the
 * first start of the current session's cluster). A batch of earlier rows names
 * the span to resolve; the span is read through the windowed reader so its
 * twins are resolved the way the list resolves them. A span whose rows are all
 * hidden by a twin further back moves the search back one batch.
 */
async function previousCanonicalWorkoutId<T extends CanonicalReadRow>(
  read: WorkoutBoundedRead<T>,
  latestStartsBefore: (to: Date, take: number) => Promise<Date[]>,
  before: Date,
  priorityJson: unknown,
): Promise<string | null> {
  let to = before;
  for (let step = 0; step < PREVIOUS_SESSION_MAX_STEPS; step += 1) {
    const earlier = await latestStartsBefore(to, PREVIOUS_SESSION_BATCH);
    if (earlier.length === 0) return null;
    const from = earlier[earlier.length - 1]!;
    const windowed = await readWorkoutsAroundRange({ from, to: before }, read);
    const canonical = canonicalWorkoutsInRange(windowed, priorityJson);
    const newest = canonical[canonical.length - 1];
    if (newest) return newest.id;
    to = from;
  }
  return null;
}

/** The stored workout with its track, series and (when served) insight. */
async function loadWorkout(id: string, ai: AiState) {
  return prisma.workout.findUnique({
    where: { id },
    include: {
      route: {
        select: {
          id: true,
          geometry: true,
          geometryEncrypted: true,
          sampleTimestamps: true,
          createdAt: true,
        },
      },
      samples: {
        select: {
          samples: true,
          sampleCount: true,
        },
      },
      insight: ai.available
        ? {
            select: { paragraphEncrypted: true, generatedAt: true },
          }
        : false,
    },
  });
}

type StoredWorkout = NonNullable<Awaited<ReturnType<typeof loadWorkout>>>;

/**
 * The detail body for a workout the caller owns, or null when the id names
 * no workout of theirs (another account's row reads as missing, so the
 * existence channel stays sealed).
 */
export async function readWorkoutDetail(args: {
  userId: string;
  id: string;
  compact: boolean;
  ai: AiState;
}) {
  const { userId, id, compact, ai } = args;
  const row = await loadWorkout(id, ai);
  if (!row || row.userId !== userId) return null;
  const identity = await resolveIdentity(userId, row);
  const enrichment = await readEnrichment(userId, row, identity);
  return shapeDetail(row, identity, enrichment, { compact, ai });
}

/** The canonical winner of the row's cluster, and the local day. */
async function resolveIdentity(userId: string, row: StoredWorkout) {
  // Resolve the canonical winner for the row's cluster. The read goes
  // through the same windowed reader as the list, so the cluster drawn here
  // is the one the list draws: a twin that straddles a clock slot boundary,
  // or one whose cluster begins with an earlier workout, resolves to the row
  // the list shows.
  const readSameSport = (bounds: WorkoutStartBounds) =>
    prisma.workout.findMany({
      where: {
        userId,
        sportType: row.sportType,
        startedAt: bounds,
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        source: true,
        startedAt: true,
        sportType: true,
        // Part of the canonical session identity consulted by the picker —
        // without it a HealthKit re-send of this very workout stays in the
        // cluster and the deep link can resolve to the duplicate instead of
        // the row the list shows.
        durationSec: true,
        avgHeartRate: true,
        maxHeartRate: true,
        metadata: true,
      },
    });
  const around = await readWorkoutsAroundRange(
    { from: row.startedAt, to: row.startedAt, inclusiveEnd: true },
    readSameSport,
  );

  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { sourcePriorityJson: true, dateOfBirth: true },
  });
  // The local calendar day this session belongs to. Resolved here, in the
  // user's timezone, so the day linkage stays server-authoritative — a
  // client that derived it from `startedAt` would fall back to the browser
  // zone and put a late-evening session on the wrong day whenever the two
  // disagree.
  const timezone = await resolveUserTimezone(userId);
  const dayKey = userDayKey(row.startedAt, timezone);

  const cluster = canonicalClusterOf(
    around,
    row.id,
    userRow?.sourcePriorityJson ?? null,
  );
  // The cluster's canonical rows, the requested row first when it is one of
  // them and otherwise the nearest in time, so a deep link to a hidden twin
  // lands on the most similar row.
  const canonical = cluster?.canonical[0] ?? null;
  const effectiveAvgHeartRate = canonical?.avgHeartRate ?? row.avgHeartRate;
  const effectiveMaxHeartRate = canonical?.maxHeartRate ?? row.maxHeartRate;

  return {
    readSameSport,
    userRow,
    dayKey,
    cluster,
    canonical,
    effectiveAvgHeartRate,
    effectiveMaxHeartRate,
  };
}

async function readEnrichment(
  userId: string,
  row: StoredWorkout,
  identity: Awaited<ReturnType<typeof resolveIdentity>>,
) {
  const { readSameSport, userRow, cluster, canonical } = identity;
  // ── Enrichment reads (all over existing tables — no migration) ────

  // Heart-rate curve: stored series first, pulse-window fallback
  // second, hide third. One server path, one DTO with provenance.
  const hrSeries = await buildWorkoutHrSeries({
    userId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSec: row.durationSec,
    storedSamples: row.samples?.samples ?? null,
  });
  annotate({
    action: { name: "workouts.detail.hr_series" },
    meta: {
      source: hrSeries?.source ?? "none",
      points: hrSeries?.points.length ?? 0,
    },
  });

  // Effort zones: WHOOP device durations win; else %HRmax fold from
  // the series when profile age exists; else null.
  const ageYears = getAgeFromDateOfBirth(userRow?.dateOfBirth ?? null);
  const zones = computeZones({
    hrMax: hrMaxFromAge(ageYears),
    series: hrSeries?.points ?? [],
    bucketSec: hrSeries?.bucketSec ?? 0,
    whoopZoneDurations: parseWhoopZoneDurations(
      canonical?.metadata ?? row.metadata,
    ),
  });

  // Per-km splits computed server-side from the geometry + timestamps
  // so the web client keeps dropping the raw timestamp blob under
  // `compact=1` while still rendering splits (server-authoritative
  // parity — iOS gets the same resolved figures).
  // The track is stored sealed; the legacy readable column is
  // read only for a row the backfill has not reached yet.
  const routeGeometry = row.route ? readRouteGeometry(row.route) : null;
  const geometryCoords =
    routeGeometry &&
    typeof routeGeometry === "object" &&
    Array.isArray((routeGeometry as { coordinates?: unknown }).coordinates)
      ? (routeGeometry as { coordinates: RouteCoordinate[] }).coordinates
      : null;
  const splits =
    geometryCoords && Array.isArray(row.route?.sampleTimestamps)
      ? computeSplits(geometryCoords, row.route.sampleTimestamps)
      : null;

  // Sport context: the user's own last-180-days average for this
  // sport, cross-source-collapsed so twins don't double-count.
  const sportContext = await buildSportContext(
    userId,
    row.sportType,
    userRow?.sourcePriorityJson ?? null,
    row.id,
  );

  // The session before this one in the same sport. "How does this compare
  // to last time?" is the most likely next question after reading a
  // workout, and today it costs a trip back to the list plus a scan.
  // Scoped to rows that start before this session's cluster, so a twin of
  // THIS session can never be offered as the previous one, and resolved
  // through the same windowed read so the link lands on the row the list
  // shows.
  const clusterStart = cluster?.members[0]?.startedAt ?? row.startedAt;
  const previousWorkoutId = await previousCanonicalWorkoutId(
    readSameSport,
    async (to, take) =>
      (
        await prisma.workout.findMany({
          where: {
            userId,
            sportType: row.sportType,
            startedAt: { lt: to },
          },
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          take,
          select: { startedAt: true },
        })
      ).map((earlier) => earlier.startedAt),
    clusterStart,
    userRow?.sourcePriorityJson ?? null,
  );
  return {
    hrSeries,
    zones,
    routeGeometry,
    splits,
    sportContext,
    previousWorkoutId,
  };
}

function shapeDetail(
  row: StoredWorkout,
  identity: Awaited<ReturnType<typeof resolveIdentity>>,
  enrichment: Awaited<ReturnType<typeof readEnrichment>>,
  options: { compact: boolean; ai: AiState },
) {
  const { compact, ai } = options;
  const { dayKey, canonical, effectiveAvgHeartRate, effectiveMaxHeartRate } =
    identity;
  const {
    hrSeries,
    zones,
    routeGeometry,
    splits,
    sportContext,
    previousWorkoutId,
  } = enrichment;
  // A route whose track cannot be read (a sealed value that no longer
  // opens, or an old row stored as a JSON null) is reported as no route at
  // all: clients decode `route.geometry` as required, so a route object
  // with a null geometry would fail the whole workout detail for them.
  const route =
    row.route && routeGeometry
      ? {
          geometry: routeGeometry,
          // `compact=1` drops the (up to 20k-entry) timestamp array; the
          // SVG needs geometry, not the per-sample timestamps, and the
          // splits above are already derived from them server-side.
          sampleTimestamps: compact
            ? null
            : (row.route.sampleTimestamps ?? null),
        }
      : null;

  // Route-independent per-workout HR series. Present for
  // both indoor (no route) and outdoor workouts that shipped a
  // `samples` array on ingest; null otherwise. `compact=1` keeps the
  // denormalised count but drops the raw sample blob (the web curve
  // reads `hrSeries` instead).
  const samples = row.samples
    ? {
        sampleCount: row.samples.sampleCount,
        samples: compact ? null : row.samples.samples,
      }
    : null;

  // Decrypt the stored paragraph. Fail-SOFT here and only here: `decrypt` is
  // fail-closed by design, so a rotated-away key would otherwise turn the
  // whole workout-detail page into a 500 over a garnish field. An
  // undecryptable paragraph degrades to no card, exactly like a workout that
  // never had one.
  let aiInsight: { paragraph: string; generatedAt: string } | null = null;
  if (ai.available && row.insight) {
    try {
      aiInsight = {
        paragraph: decryptFromBytes(row.insight.paragraphEncrypted),
        generatedAt: row.insight.generatedAt.toISOString(),
      };
    } catch {
      annotate({
        action: { name: "workouts.detail.insight_undecryptable" },
        meta: { workoutId: row.id },
      });
    }
  }

  return {
    id: row.id,
    sportType: row.sportType,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    // `YYYY-MM-DD` in the user's timezone. Additive; it addresses the
    // day-scoped reads (intraday pulse, that night's sleep, the day's
    // mood) the detail surface renders around the session.
    dayKey,
    durationSec: row.durationSec,
    distanceM: row.totalDistanceM,
    activeEnergyKcal: row.totalEnergyKcal,
    avgHr: effectiveAvgHeartRate,
    maxHr: effectiveMaxHeartRate,
    minHr: row.minHeartRate,
    // The row's own heart rate. `avgHr` / `maxHr` above may be filled in
    // from a twin by the canonical picker, which is right for display and
    // wrong for an edit: re-posting them would store the twin's values on
    // the hand-entered row (#1162).
    storedAvgHr: row.avgHeartRate,
    storedMaxHr: row.maxHeartRate,
    stepCount: row.stepCount,
    elevationM: row.elevationM,
    pauseDurationSec: row.pauseDurationSec,
    source: row.source,
    externalId: row.externalId,
    metadata: row.metadata,
    route,
    samples,
    // #67 enrichment — all additive, all over existing tables.
    hrSeries,
    zones,
    splits,
    sportContext,
    // The per-workout Activity Insight. A pure READ of a row the
    // `workout-insight-generate` worker wrote when this workout landed —
    // this route never generates, never enqueues, and never falls back to
    // a provider. A workout with no row (every historical one, every
    // re-synced one, every one on a provider-less install) serves null and
    // the page's `{aiInsight ? <card/> : null}` renders nothing.
    aiInsight,
    // Whether the Activity Insight can be shown, and why not.
    ai,
    // When the requested id is a non-canonical twin the
    // caller can redirect to `canonicalId` to land on the cluster
    // winner. `canonicalId === id` when the requested row already
    // is the winner.
    canonicalId: canonical?.id ?? row.id,
    // The canonical previous session in this sport, or null when this is
    // the first one on record. Additive; a client that does not read it is
    // unaffected.
    previousWorkoutId,
  };
}
