/**
 * v1.27.7 — hero score-ring resolution for the dashboard snapshot.
 *
 * Resolves the user-selected `selectedScoreRings` (max 3, closed
 * `SCORE_RING_IDS` set) into ring entries the hero renders next to the
 * health-score ring:
 *
 *   - `READINESS` / `RECOVERY_SCORE` / `SLEEP_SCORE` call the SAME
 *     `computeDerivedMetric` dispatcher the `/api/insights/derived`
 *     batch route uses (profile loaded once via the shared
 *     `loadBaselineProfile`) — no score logic is re-derived here, and a
 *     non-`ok` compute (insufficient data, engine gate) simply yields no
 *     ring, mirroring the wellness strip's self-gating.
 *   - `MED_COMPLIANCE` is TODAY's dose progress from the snapshot's own
 *     `medsToday` block (takenToday / scheduledToday) — the same numbers
 *     the old hero dose row carried and the native client shows. The
 *     v1.27.7 first cut showed the pooled 7-day adherence percentage
 *     here; a percentage on a ring next to "today" scores read as a
 *     mystery number, so the ring now answers the question the hero
 *     actually poses: how many of today's doses are done. `score` stays
 *     the 0..100 progress (rounded) for wire compatibility; the additive
 *     `doses` field carries the taken/scheduled pair for the "1/3"
 *     display. No doses scheduled today → no ring (self-gating). The
 *     band is progress semantics — `green` once every scheduled dose is
 *     taken, `yellow` while doses remain — never `red`: pending doses in
 *     the morning are not an alert state.
 *
 * Module gating reads the surface map (`score-ring:<id>` in
 * `@/lib/modules/surface`): readiness/recovery → recovery, sleep score →
 * sleep, MED_COMPLIANCE → medications. The derived scores are data, so the
 * `insights` key (AI analysis) gates no ring.
 *
 * Every ring resolves fail-soft: a throwing engine drops its ring, never
 * the snapshot.
 *
 * 1.50 — two rules from the score clean-up:
 *
 *   - READINESS carries `fresh` and `asOfDay` from the engine. A readiness
 *     that is not fresh rests on an earlier day: the ring keeps the score
 *     for "last 81 on Nov 24" but has no band (`null`), since a band is a
 *     statement about today. A client built before 1.50 skips a ring it
 *     cannot decode, so it shows no stale band either.
 *   - RECOVERY_SCORE carries the `source` of the row it rests on. When that
 *     row is the computed proxy (`isProxyRecovery`) and a fresh READINESS
 *     ring (one with a band) is also served, the recovery ring is left out:
 *     it is the same blend twice. Beside a stale READINESS ring the proxy
 *     stays, because a shipped app skips the band-less ring and would
 *     otherwise show neither.
 *     The proxy ring otherwise stays in 1.50 and retires with the iOS ring
 *     rebuild in 1.51; a device's recovery ring always stays.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { ModuleKey } from "@/lib/modules/gate";
import { SCORE_RING_IDS, type ScoreRingId } from "@/lib/dashboard-layout";
import { isSurfaceVisible } from "@/lib/modules/surface";
import {
  isProxyRecovery,
  readCurrentCanonicalRecovery,
} from "@/lib/insights/derived/recovery-resolve";
import {
  computeDerivedMetric,
  loadBaselineProfile,
  isDerivedOk,
  type DerivedMetricId,
} from "@/lib/insights/derived";

export type ScoreRingBand = "green" | "yellow" | "red";

/** One resolved hero ring. */
export interface DashboardScoreRing {
  id: ScoreRingId;
  /** The 0..100 score (rounded). For `MED_COMPLIANCE`: today's dose progress. */
  score: number;
  /**
   * The server's band. `null` only on a READINESS ring that is not fresh:
   * a band is a statement about today, an old blend makes none.
   */
  band: ScoreRingBand | null;
  /** READINESS only (1.50): true when the blend describes today. */
  fresh?: boolean;
  /** READINESS only (1.50): the local day (YYYY-MM-DD) the blend rests on. */
  asOfDay?: string;
  /**
   * RECOVERY_SCORE only (1.50): the source of the row the ring shows.
   * `COMPUTED` is HealthLog's own readiness blend stored at 04:45 (the proxy
   * ring, retiring in 1.51); any other is the device's own score.
   */
  source?: string;
  /**
   * `MED_COMPLIANCE` only — today's dose tally behind the progress
   * score, for the "taken/scheduled" ring display. Additive; absent on
   * the derived score rings.
   */
  doses?: { taken: number; scheduled: number };
}

/** The medsToday slice the dose ring reads (subset of `MedsTodayBlock`). */
export interface MedsTodayForRings {
  takenToday: number;
  scheduledToday: number;
}

/** The derived-registry id behind each derived ring (identity mapping). */
const DERIVED_RING_METRIC: Partial<Record<ScoreRingId, DerivedMetricId>> = {
  READINESS: "READINESS",
  RECOVERY_SCORE: "RECOVERY_SCORE",
  SLEEP_SCORE: "SLEEP_SCORE",
};

/** The compute payload slice every derived score ring reads. */
interface ScoreBandValue {
  score: number;
  band: ScoreRingBand;
  /** READINESS only. */
  fresh?: boolean;
  /** READINESS only. */
  asOfDay?: string;
}

/**
 * Today's dose-progress ring from the snapshot's `medsToday` block, or
 * `null` when nothing is scheduled today — the ring self-gates instead
 * of asserting a hollow 100%.
 */
export function resolveDoseRing(
  medsToday: MedsTodayForRings | null,
): DashboardScoreRing | null {
  if (!medsToday) return null;
  const scheduled = medsToday.scheduledToday;
  if (!Number.isFinite(scheduled) || scheduled <= 0) return null;
  const taken = Math.max(0, Math.min(medsToday.takenToday, scheduled));
  const score = Math.round((taken / scheduled) * 100);
  return {
    id: "MED_COMPLIANCE",
    score,
    // Progress semantics, not adherence judgment: green when done,
    // yellow while doses remain. Pending morning doses are not "red".
    band: taken >= scheduled ? "green" : "yellow",
    doses: { taken, scheduled },
  };
}

/**
 * Resolve the selected hero rings against the module map. Selection
 * order is preserved; rings without data drop out. Every ring is
 * fail-soft on its own — one throwing engine never takes the row (or
 * the snapshot) down.
 */
export async function buildScoreRingsBlock(
  prisma: PrismaClient,
  userId: string,
  selected: ScoreRingId[],
  modules: Record<ModuleKey, boolean>,
  now: Date,
  medsToday: MedsTodayForRings | null,
): Promise<DashboardScoreRing[]> {
  const eligible = selected.filter((id) => {
    if (!(SCORE_RING_IDS as readonly string[]).includes(id)) return false;
    return isSurfaceVisible(`score-ring:${id}`, modules);
  });
  if (eligible.length === 0) return [];

  // Profile loaded ONCE via the shared loader (the batch-route pattern);
  // only when a derived ring is actually selected.
  const needsProfile = eligible.some((id) => DERIVED_RING_METRIC[id]);
  const profile = needsProfile
    ? await loadBaselineProfile(prisma, userId)
    : null;

  const resolved = await Promise.all(
    eligible.map(async (id): Promise<DashboardScoreRing | null> => {
      try {
        if (id === "MED_COMPLIANCE") {
          return resolveDoseRing(medsToday);
        }
        const metric = DERIVED_RING_METRIC[id];
        if (!metric || !profile) return null;
        const derived = await computeDerivedMetric({
          metric,
          userId,
          profile,
          now,
        });
        if (!isDerivedOk(derived)) return null;
        const value = derived.value as ScoreBandValue;
        if (typeof value?.score !== "number" || !Number.isFinite(value.score)) {
          return null;
        }
        const score = Math.round(value.score);
        if (id === "READINESS") {
          const fresh = value.fresh === true;
          return {
            id,
            score,
            band: fresh ? value.band : null,
            fresh,
            ...(typeof value.asOfDay === "string"
              ? { asOfDay: value.asOfDay }
              : {}),
          };
        }
        if (id === "RECOVERY_SCORE") {
          const row = await readCurrentCanonicalRecovery(prisma, userId, now);
          if (row === null) return null;
          return { id, score, band: value.band, source: row.source };
        }
        return { id, score, band: value.band };
      } catch {
        // Fail-soft per ring — a transient engine error drops the ring,
        // never the snapshot.
        return null;
      }
    }),
  );
  const rings = resolved.filter((r): r is DashboardScoreRing => r !== null);
  // The proxy recovery ring beside a READINESS ring with a band is the same
  // blend twice; it gives way. Beside a stale READINESS ring (band null) it
  // stays: every shipped app skips a ring without a band, so dropping the
  // proxy there would leave such a client with neither ring.
  const hasReadiness = rings.some(
    (r) => r.id === "READINESS" && r.band !== null,
  );
  return rings.filter(
    (r) =>
      !(
        hasReadiness &&
        r.id === "RECOVERY_SCORE" &&
        r.source !== undefined &&
        isProxyRecovery({ source: r.source })
      ),
  );
}
