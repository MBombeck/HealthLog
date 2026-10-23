/**
 * Per-kilometre splits from a workout's route geometry + per-sample
 * timestamps. Pure; computed server-side so the web client keeps
 * dropping the raw `sampleTimestamps` blob under `compact=1` (the
 * derived splits survive, the 20k-point timestamp array does not) and
 * iOS gets the same resolved figures — server-authoritative parity.
 *
 * Only meaningful for distance/pace sports; the caller gates the sport.
 * A workout without aligned timestamps (or under one full km) yields
 * `null` and the caller hides the splits card.
 */
import {
  extractLonLat,
  haversineMeters,
  type RouteCoordinate,
} from "@/lib/workouts/route-svg";
import { routeSampleInstant } from "@/lib/workouts/route-samples";

export interface WorkoutSplit {
  /** 1-based kilometre index. */
  km: number;
  /** Time to cover this kilometre, seconds. */
  durationSec: number;
  /** Pace over the kilometre, seconds per km (== durationSec here). */
  paceSecPerKm: number;
}

const KM = 1000;

/**
 * Compute whole-kilometre splits. Walks the polyline accumulating
 * haversine distance; at each km boundary the crossing time is linearly
 * interpolated between the two bounding samples by distance fraction,
 * so a split boundary that falls mid-segment is timed honestly.
 */
export function computeSplits(
  coordinates: readonly RouteCoordinate[],
  /** The stored samples: an instant each, or `{ t, … }` (`RouteSample`). */
  timestamps: readonly unknown[] | null | undefined,
): WorkoutSplit[] | null {
  if (!timestamps || timestamps.length !== coordinates.length) return null;

  // Keep coordinate/timestamp pairs that are both well-formed.
  const pts: Array<{ lon: number; lat: number; tMs: number }> = [];
  coordinates.forEach((c, i) => {
    const [lonLat] = extractLonLat([c]);
    if (!lonLat) return;
    const tMs = Date.parse(routeSampleInstant(timestamps[i]) ?? "");
    if (!Number.isFinite(tMs)) return;
    pts.push({ lon: lonLat[0], lat: lonLat[1], tMs });
  });
  if (pts.length < 2) return null;

  const splits: WorkoutSplit[] = [];
  let cumulative = 0;
  let nextBoundary = KM;
  let prevBoundaryTimeMs = pts[0].tMs;

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segDist = haversineMeters(a.lon, a.lat, b.lon, b.lat);
    if (segDist <= 0) continue;
    const segStart = cumulative;
    cumulative += segDist;

    // A single long segment can straddle several km boundaries.
    while (cumulative >= nextBoundary) {
      const frac = (nextBoundary - segStart) / segDist;
      const boundaryTimeMs = a.tMs + (b.tMs - a.tMs) * frac;
      const durationSec = Math.max(
        0,
        Math.round((boundaryTimeMs - prevBoundaryTimeMs) / 1000),
      );
      splits.push({
        km: splits.length + 1,
        durationSec,
        paceSecPerKm: durationSec,
      });
      prevBoundaryTimeMs = boundaryTimeMs;
      nextBoundary += KM;
    }
  }

  return splits.length > 0 ? splits : null;
}
